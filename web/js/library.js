// Library helpers that keep breakdowns cheap, all computed on the device:
// - relatedNotes: only the notes likely to connect to a new source are sent
//   to Claude, so the cost of a breakdown stays flat as the library grows.
// - conceptVocabulary: the library's most-used concept names, so Claude
//   still reuses them and the map keeps linking up.
// - canonicalUrl / findDuplicate: a link that's already saved opens the
//   existing note instead of paying for a second breakdown.
export const RELATED_LIMIT = 20;
const MIN_NOTES = 8; // fill with recent notes when few match
const VOCABULARY_LIMIT = 150;
const SOURCE_SCAN_CHARS = 60000;

const STOPWORDS = new Set(('the and for are but not you all any can had her was one our out has him his how its may new now old see two way who did get let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what into also most other their there these thing think those which while about after again being could every first great might never right shall since still where would should because before between through during without within across along among around doing having makes made using used even each both same does done here very also just really').split(' '));

export function terms(text) {
    return String(text || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
}

function noteFields(note) {
    const concepts = (note.concepts || []).map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
    return {
        strong: new Set([...terms(concepts.join(' ')), ...terms((note.tags || []).join(' '))]),
        title: new Set(terms(note.title)),
        tldr: new Set(terms(note.tldr)),
        phrases: concepts.map((name) => name.toLowerCase().trim()).filter((name) => name.includes(' ') && name.length > 4)
    };
}

function byNewest(a, b) {
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}

// Picks up to `limit` notes most related to the source. Small libraries are
// sent whole: that's already cheap and gives Claude the full picture.
export function relatedNotes(notes, source = {}, { limit = RELATED_LIMIT } = {}) {
    const list = Array.isArray(notes) ? notes : [];
    if (list.length <= limit) return list;

    const sourceText = `${source.title || ''}\n${String(source.text || '').slice(0, SOURCE_SCAN_CHARS)}`.toLowerCase();
    const sourceTerms = new Set(terms(sourceText));
    const fields = list.map(noteFields);

    // Rarer words say more about a match than common ones.
    const docFreq = new Map();
    fields.forEach((f) => new Set([...f.strong, ...f.title, ...f.tldr]).forEach((term) => docFreq.set(term, (docFreq.get(term) || 0) + 1)));
    const idf = (term) => Math.log(1 + list.length / (docFreq.get(term) || 1));

    const scored = list.map((note, index) => {
        const f = fields[index];
        let score = 0;
        const seen = new Set();
        const add = (set, weight) => set.forEach((term) => {
            if (seen.has(term) || !sourceTerms.has(term)) return;
            seen.add(term);
            score += weight * idf(term);
        });
        add(f.strong, 3);
        add(f.title, 2);
        add(f.tldr, 1);
        f.phrases.forEach((phrase) => { if (sourceText.includes(phrase)) score += 4; });
        const size = f.strong.size + f.title.size + f.tldr.size;
        return { note, score: size ? score / Math.sqrt(size) : 0 };
    });

    const picked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || byNewest(a.note, b.note)).slice(0, limit).map((s) => s.note);
    if (picked.length < MIN_NOTES) {
        const chosen = new Set(picked.map((n) => n.id));
        [...list].sort(byNewest).forEach((note) => {
            if (picked.length < Math.min(MIN_NOTES, limit) && !chosen.has(note.id)) picked.push(note);
        });
    }
    return picked;
}

// The most-used concept names across the whole library (only needed when
// the library is too big to send whole).
export function conceptVocabulary(notes, { limit = VOCABULARY_LIMIT } = {}) {
    const counts = new Map();
    (Array.isArray(notes) ? notes : []).forEach((note) => {
        const names = new Set((note.concepts || []).map((c) => String((typeof c === 'string' ? c : c?.name) || '').trim()).filter(Boolean));
        names.forEach((name) => {
            const key = name.toLowerCase();
            const entry = counts.get(key) || { name, count: 0 };
            entry.count++;
            counts.set(key, entry);
        });
    });
    return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit).map((e) => e.name);
}

// Topic names already used, most common first, so new notes reuse them.
export function knownTopics(notes, { limit = 100 } = {}) {
    const counts = new Map();
    (Array.isArray(notes) ? notes : []).forEach((note) => {
        const name = String(note.topic || '').trim();
        if (!name) return;
        const key = name.toLowerCase();
        const entry = counts.get(key) || { name, count: 0 };
        entry.count++;
        counts.set(key, entry);
    });
    return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit).map((e) => e.name);
}

const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|igsh|si|feature|ref|ref_src|ref_url|share|share_id|t|is_from_webapp|sender_device|_r|_t|publication_id|triedredirect)$/i;

// A stable key for "the same thing": ignores tracking parameters, fragments,
// www/m. prefixes and trailing slashes; YouTube links reduce to the video id.
export function canonicalUrl(raw) {
    let url;
    try {
        url = new URL(String(raw || '').trim());
    } catch {
        return '';
    }
    if (!/^https?:$/.test(url.protocol)) return '';
    const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
    if (host === 'youtu.be') {
        const id = url.pathname.split('/')[1];
        if (id) return `youtube:${id}`;
    }
    if (host.endsWith('youtube.com')) {
        const id = url.searchParams.get('v') || (url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/) || [])[1];
        if (id) return `youtube:${id}`;
    }
    const params = [...url.searchParams.entries()]
        .filter(([key]) => !TRACKING_PARAMS.test(key))
        .sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${host}${path}${query}`;
}

export function findDuplicate(notes, ...urls) {
    const keys = new Set(urls.map(canonicalUrl).filter(Boolean));
    if (!keys.size) return null;
    return (Array.isArray(notes) ? notes : []).find((note) =>
        [note.source?.url, note.source?.sharedUrl].some((u) => keys.has(canonicalUrl(u)))
    ) || null;
}
