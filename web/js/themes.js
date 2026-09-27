// Map themes: groups notes into topics, entirely on the device (no AI cost).
//
// 1. Similarity: each note's main topic (what it's about, from Claude or
//    set by you) counts most. Notes are also related when Claude linked them,
//    when your own notes [[wikilink]] one to the other, or when they share
//    tags or concepts. Between notes with different topics, shared tags,
//    concepts and Claude's links count much less: a journaling note that
//    mentions AI stays with journaling. Rare tags and concepts count more
//    than common ones; ones on every note, or on most of a larger library,
//    are ignored.
// 2. Clustering: Louvain community detection finds groups of notes that are
//    more connected to each other than to the rest. Nodes are visited in a
//    fixed order, so the same library always gives the same themes.
// 3. Labels: a theme is named after the topic most of its notes share,
//    otherwise its most distinctive tags (frequent inside the theme, rare
//    outside it), falling back to concepts.
// 4. Colors: picked from the theme's main name, so a theme keeps its color
//    as the library grows.

export const THEME_COLORS = 8;
export const THEME_DETAIL = {
    broad: { label: 'Broad', resolution: 0.6, detail: 'Fewer, bigger themes.' },
    balanced: { label: 'Balanced', resolution: 1, detail: 'A theme for each main topic.' },
    detailed: { label: 'Detailed', resolution: 1.6, detail: 'More, smaller themes.' }
};

const WEIGHTS = { topic: 4, connection: 3, wikilink: 3, tag: 1, concept: 1.4 };
// How much shared tags, concepts and Claude's links count between notes
// whose topics differ. Your own [[wikilinks]] always count in full.
const CROSS_TOPIC = 0.3;
const COMMON_SHARE = 0.5; // ignore tags/concepts on more than half the notes…
const COMMON_MIN_NOTES = 12; // …once the library has this many notes
const MIN_THEME_SIZE = 2;

function keyOf(value) {
    return String(value || '').trim().toLowerCase();
}

function conceptNames(note) {
    return [...new Set((note.concepts || []).map((c) => keyOf(typeof c === 'string' ? c : c?.name)).filter(Boolean))];
}

export function topicOf(note) {
    return keyOf(note?.topic);
}

function tagNames(note) {
    return [...new Set((note.tags || []).map(keyOf).filter(Boolean))];
}

// Weighted, undirected note-to-note graph as Map(id -> Map(id -> weight)).
export function similarityGraph(notes) {
    const adj = new Map(notes.map((note) => [note.id, new Map()]));
    const topics = new Map(notes.map((note) => [note.id, topicOf(note)]));
    // Scale down evidence between notes that are about different things.
    const scale = (a, b) => {
        const ta = topics.get(a);
        const tb = topics.get(b);
        return ta && tb && ta !== tb ? CROSS_TOPIC : 1;
    };
    const add = (a, b, w, { full = false } = {}) => {
        if (a === b || !adj.has(a) || !adj.has(b) || !(w > 0)) return;
        const weight = full ? w : w * scale(a, b);
        adj.get(a).set(b, (adj.get(a).get(b) || 0) + weight);
        adj.get(b).set(a, (adj.get(b).get(a) || 0) + weight);
    };

    const titles = new Map(notes.map((note) => [keyOf(note.title), note.id]));
    notes.forEach((note) => {
        (note.connections || []).forEach((c) => add(note.id, c.noteId, WEIGHTS.connection));
        for (const match of (note.userNotes || '').matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
            add(note.id, titles.get(keyOf(match[1])), WEIGHTS.wikilink, { full: true });
        }
    });
    // Same topic: the strongest signal. Spread over the group so a big topic
    // doesn't swamp everything else.
    const byTopic = new Map();
    notes.forEach((note) => {
        const t = topics.get(note.id);
        if (!t) return;
        if (!byTopic.has(t)) byTopic.set(t, []);
        byTopic.get(t).push(note.id);
    });
    byTopic.forEach((ids) => {
        const w = WEIGHTS.topic / Math.sqrt(ids.length - 1 || 1);
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) add(ids[i], ids[j], w);
        }
    });

    const shared = (namesOf, weight) => {
        const holders = new Map();
        notes.forEach((note) => namesOf(note).forEach((name) => {
            if (!holders.has(name)) holders.set(name, []);
            holders.get(name).push(note.id);
        }));
        holders.forEach((ids) => {
            if (ids.length < 2) return;
            // A name on every note, or on most of a larger library, doesn't
            // separate topics. Small libraries keep their majority names:
            // there, a tag on 5 of 9 notes is usually the main topic.
            if (notes.length >= 3 && ids.length === notes.length) return;
            if (notes.length >= COMMON_MIN_NOTES && ids.length > notes.length * COMMON_SHARE) return;
            // Rarer shared names say more: 2 notes sharing a tag outweighs 20.
            const w = weight * Math.log(1 + notes.length / ids.length) / Math.log(1 + notes.length / 2);
            for (let i = 0; i < ids.length; i++) {
                for (let j = i + 1; j < ids.length; j++) add(ids[i], ids[j], w);
            }
        });
    };
    shared(tagNames, WEIGHTS.tag);
    shared(conceptNames, WEIGHTS.concept);
    return adj;
}

// Louvain modularity clustering. Returns Map(nodeId -> communityId).
// resolution > 1 favours smaller communities, < 1 larger ones.
export function louvain(adj, { resolution = 1, maxLevels = 10, maxPasses = 30 } = {}) {
    // Working graph: nodes are groups of original ids; self-loops hold the
    // weight inside a group once groups are merged.
    let nodes = [...adj.keys()].sort();
    let members = new Map(nodes.map((id) => [id, [id]]));
    let edges = new Map(nodes.map((id) => [id, new Map(adj.get(id))]));
    let selfLoops = new Map(nodes.map((id) => [id, 0]));

    for (let level = 0; level < maxLevels; level++) {
        const degree = new Map(nodes.map((id) => {
            let k = selfLoops.get(id);
            edges.get(id).forEach((w) => { k += w; });
            return [id, k];
        }));
        const total = [...degree.values()].reduce((a, b) => a + b, 0);
        if (!total) break;

        const community = new Map(nodes.map((id) => [id, id]));
        const sumTot = new Map(nodes.map((id) => [id, degree.get(id)]));
        let movedAny = false;

        for (let pass = 0; pass < maxPasses; pass++) {
            let moved = false;
            for (const id of nodes) {
                const k = degree.get(id);
                if (!k) continue;
                const current = community.get(id);
                const toCommunity = new Map();
                edges.get(id).forEach((w, other) => {
                    const c = community.get(other);
                    toCommunity.set(c, (toCommunity.get(c) || 0) + w);
                });
                sumTot.set(current, sumTot.get(current) - k);
                const gain = (c) => (toCommunity.get(c) || 0) - (resolution * sumTot.get(c) * k) / total;
                let best = current;
                let bestGain = gain(current);
                [...toCommunity.keys()].sort().forEach((c) => {
                    const g = gain(c);
                    if (g > bestGain + 1e-12) {
                        best = c;
                        bestGain = g;
                    }
                });
                sumTot.set(best, sumTot.get(best) + k);
                if (best !== current) {
                    community.set(id, best);
                    moved = true;
                    movedAny = true;
                }
            }
            if (!moved) break;
        }
        if (!movedAny) break;

        // Merge each community into one node and repeat on the smaller graph.
        const groups = new Map();
        nodes.forEach((id) => {
            const c = community.get(id);
            if (!groups.has(c)) groups.set(c, []);
            groups.get(c).push(id);
        });
        const nextMembers = new Map();
        const nextEdges = new Map();
        const nextSelf = new Map();
        groups.forEach((ids, c) => {
            nextMembers.set(c, ids.flatMap((id) => members.get(id)));
            nextEdges.set(c, new Map());
            nextSelf.set(c, ids.reduce((sum, id) => sum + selfLoops.get(id), 0));
        });
        nodes.forEach((id) => {
            const c = community.get(id);
            edges.get(id).forEach((w, other) => {
                const d = community.get(other);
                if (c === d) nextSelf.set(c, nextSelf.get(c) + w);
                else nextEdges.get(c).set(d, (nextEdges.get(c).get(d) || 0) + w);
            });
        });
        nodes = [...groups.keys()].sort();
        members = nextMembers;
        edges = nextEdges;
        selfLoops = nextSelf;
    }

    const result = new Map();
    nodes.forEach((group) => members.get(group).forEach((id) => result.set(id, group)));
    return result;
}

const ACRONYMS = new Map(['ai', 'ml', 'ux', 'ui', 'seo', 'llm', 'api', 'crm', 'b2b', 'b2c', 'roi', 'kpi', 'adhd', 'diy', 'nlp', 'vr', 'ar'].map((w) => [w, w.toUpperCase()]));
ACRONYMS.set('llms', 'LLMs').set('saas', 'SaaS').set('iphone', 'iPhone').set('ios', 'iOS');

// "ai-agents" → "AI agents": first letter up, known acronyms kept.
export function prettyName(name) {
    const words = name.replace(/-/g, ' ').trim().split(/\s+/).map((w) => ACRONYMS.get(w.toLowerCase()) || w);
    const text = words.join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

// Names a group of notes by what sets it apart from the rest of the library.
function labelFor(members, allNotes) {
    const topicCounts = new Map();
    members.forEach((note) => {
        const key = topicOf(note);
        if (!key) return;
        const entry = topicCounts.get(key) || { name: String(note.topic).trim(), count: 0 };
        entry.count++;
        topicCounts.set(key, entry);
    });
    const dominant = [...topicCounts.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))[0];
    const pick = (namesOf) => {
        const inside = new Map();
        const everywhere = new Map();
        allNotes.forEach((note) => namesOf(note).forEach((n) => everywhere.set(n, (everywhere.get(n) || 0) + 1)));
        members.forEach((note) => namesOf(note).forEach((n) => inside.set(n, (inside.get(n) || 0) + 1)));
        const minCount = members.length > 2 ? 2 : 1;
        return [...inside.entries()]
            .filter(([, count]) => count >= minCount)
            .map(([name, count]) => ({ name, count, score: (count * count) / everywhere.get(name) }))
            .sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name));
    };
    const tags = pick(tagNames);
    const concepts = pick(conceptNames);
    if (dominant && dominant[1].count * 2 >= members.length) {
        return { label: dominant[1].name, keys: [dominant[0]], tags: tags.slice(0, 6).map((t) => t.name), topic: dominant[1].name };
    }
    const top = (tags.length ? tags : concepts).slice(0, 2).map((t) => t.name);
    if (!top.length) {
        const first = [...members].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
        return { label: first?.title?.slice(0, 40) || 'Theme', keys: [keyOf(first?.title || 'theme')], tags: [] };
    }
    return {
        label: top.map(prettyName).join(' · '),
        keys: top,
        tags: tags.slice(0, 6).map((t) => t.name)
    };
}

// Returns { themes, byNote } where themes are sorted biggest first:
//   { id, label, color (0..THEME_COLORS-1), noteIds, tags }
// and byNote maps a note id to its theme id. Notes that don't fit any group
// are left out of byNote ("Unsorted").
export function buildThemes(notes, { detail = 'balanced' } = {}) {
    const list = (Array.isArray(notes) ? notes : []).filter((n) => n && n.id);
    const empty = { themes: [], byNote: new Map() };
    if (list.length < MIN_THEME_SIZE) return empty;
    const resolution = (THEME_DETAIL[detail] || THEME_DETAIL.balanced).resolution;
    const adj = similarityGraph(list);
    const community = louvain(adj, { resolution });

    const groups = new Map();
    list.forEach((note) => {
        if (!adj.get(note.id).size) return; // no links at all: unsorted
        const c = community.get(note.id);
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c).push(note);
    });

    const byId = new Map(list.map((n) => [n.id, n]));
    const themes = [...groups.values()]
        .filter((members) => members.length >= MIN_THEME_SIZE)
        .map((members) => ({ members, ...labelFor(members, list) }))
        .sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));

    const usedIds = new Set();
    const usedColors = new Set();
    const result = themes.map(({ members, label, keys, tags }) => {
        // The id (and so the color) follows only the top name, which rarely
        // changes as notes are added; the second word in the label may.
        const base = keys[0].replace(/[^\p{L}\p{N}-]+/gu, '-') || 'theme';
        let id = base;
        for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
        usedIds.add(id);
        // Color follows the name, so it survives new notes; clashes move to
        // the next free color while there are free colors left.
        let color = hashString(id) % THEME_COLORS;
        if (usedColors.size < THEME_COLORS) {
            while (usedColors.has(color)) color = (color + 1) % THEME_COLORS;
        }
        usedColors.add(color);
        return {
            id,
            label,
            color,
            tags,
            noteIds: members.map((m) => m.id).sort((a, b) => String(byId.get(b).createdAt).localeCompare(String(byId.get(a).createdAt)))
        };
    });

    const byNote = new Map();
    result.forEach((theme) => theme.noteIds.forEach((id) => byNote.set(id, theme.id)));
    return { themes: result, byNote };
}
