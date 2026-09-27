import test from 'node:test';
import assert from 'node:assert';
import { buildThemes, similarityGraph, louvain, THEME_COLORS } from '../js/themes.js';

let day = 1;
function note(id, tags, concepts = [], extra = {}) {
    return { id, title: `Note ${id}`, tags, concepts: concepts.map((name) => ({ name })), createdAt: `2026-01-${String(day++).padStart(2, '0')}`, ...extra };
}

function library() {
    day = 1;
    return [
        note('s1', ['sleep', 'health'], ['Circadian rhythm']),
        note('s2', ['sleep', 'recovery'], ['Circadian rhythm', 'Melatonin']),
        note('s3', ['sleep', 'health'], ['Melatonin']),
        note('s4', ['sleep'], ['Deep sleep']),
        note('m1', ['marketing', 'growth'], ['Funnel']),
        note('m2', ['marketing', 'seo'], ['Funnel', 'Keywords']),
        note('m3', ['marketing', 'growth'], ['Keywords']),
        note('lonely', ['woodworking'], ['Dovetail'])
    ];
}

test('notes group into themes named after their distinctive tags', () => {
    const { themes, byNote } = buildThemes(library());
    assert.strictEqual(themes.length, 2);
    const sleep = themes.find((t) => byNote.get('s1') === t.id);
    const marketing = themes.find((t) => byNote.get('m1') === t.id);
    assert.deepStrictEqual([...sleep.noteIds].sort(), ['s1', 's2', 's3', 's4']);
    assert.deepStrictEqual([...marketing.noteIds].sort(), ['m1', 'm2', 'm3']);
    assert.match(sleep.label, /^Sleep/);
    assert.match(marketing.label, /^Marketing/);
    assert.notStrictEqual(sleep.color, marketing.color);
    assert.ok(sleep.color >= 0 && sleep.color < THEME_COLORS);
    assert.strictEqual(byNote.has('lonely'), false); // unsorted
    assert.strictEqual(themes[0].id, sleep.id); // biggest first
});

test('themes are deterministic and keep their ids as the library grows', () => {
    const first = buildThemes(library());
    const again = buildThemes([...library()].reverse());
    assert.deepStrictEqual(again.themes.map((t) => [t.id, t.color, [...t.noteIds].sort()]).sort(), first.themes.map((t) => [t.id, t.color, [...t.noteIds].sort()]).sort());
    const grown = buildThemes([...library(), note('s5', ['sleep'], ['Deep sleep'])]);
    const sleepId = first.byNote.get('s1');
    assert.strictEqual(grown.byNote.get('s5'), sleepId);
    assert.strictEqual(grown.themes.find((t) => t.id === sleepId).color, first.themes.find((t) => t.id === sleepId).color);
});

test('explicit connections and wikilinks pull notes together', () => {
    day = 1;
    const notes = [
        note('a', ['x1'], [], { connections: [{ noteId: 'b', relation: 'supports', reason: '' }] }),
        note('b', ['x2']),
        note('c', ['x3'], [], { userNotes: 'see [[Note d]]' }),
        note('d', ['x4'])
    ];
    const adj = similarityGraph(notes);
    assert.strictEqual(adj.get('a').get('b'), 3);
    assert.strictEqual(adj.get('d').get('c'), 3);
    const { themes } = buildThemes(notes);
    assert.deepStrictEqual(themes.map((t) => [...t.noteIds].sort()).sort(), [['a', 'b'], ['c', 'd']]);
});

test('tags on most of the library do not glue everything together', () => {
    const notes = library().map((n) => ({ ...n, tags: [...n.tags, 'ideas'] }));
    assert.strictEqual(buildThemes(notes).themes.length, 2);
});

test('detail setting changes how finely the library splits', () => {
    day = 1;
    // Two tight pairs joined by a weaker shared tag.
    const notes = [
        note('a', ['alpha', 'shared'], ['A']), note('b', ['alpha', 'shared'], ['A']),
        note('c', ['beta', 'shared'], ['B']), note('d', ['beta', 'shared'], ['B']),
        note('e', ['gamma'], ['G']), note('f', ['gamma'], ['G']), note('g', ['delta'], ['D']), note('h', ['delta'], ['D'])
    ];
    const broad = buildThemes(notes, { detail: 'broad' }).themes.length;
    const detailed = buildThemes(notes, { detail: 'detailed' }).themes.length;
    assert.ok(detailed >= broad);
});

test('louvain splits two cliques joined by one edge', () => {
    const adj = new Map();
    const link = (a, b, w = 1) => {
        if (!adj.has(a)) adj.set(a, new Map());
        if (!adj.has(b)) adj.set(b, new Map());
        adj.get(a).set(b, w);
        adj.get(b).set(a, w);
    };
    ['a', 'b', 'c'].forEach((x, i, arr) => arr.slice(i + 1).forEach((y) => link(x, y)));
    ['d', 'e', 'f'].forEach((x, i, arr) => arr.slice(i + 1).forEach((y) => link(x, y)));
    link('c', 'd', 0.2);
    const community = louvain(adj);
    assert.strictEqual(community.get('a'), community.get('c'));
    assert.strictEqual(community.get('d'), community.get('f'));
    assert.notStrictEqual(community.get('a'), community.get('d'));
});

test('tiny or empty libraries have no themes', () => {
    assert.deepStrictEqual(buildThemes([]).themes, []);
    assert.deepStrictEqual(buildThemes([note('x', ['a'])]).themes, []);
});

test('large libraries stay fast', () => {
    const topics = Array.from({ length: 12 }, (_, i) => `topic-${i}`);
    let seed = 7;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const notes = Array.from({ length: 600 }, (_, i) => {
        const t = topics[i % topics.length];
        return { id: `n${i}`, title: `N${i}`, tags: [t, `sub-${t}-${rand(4)}`, `misc-${rand(40)}`], concepts: [{ name: `${t} idea ${rand(6)}` }], createdAt: '2026-01-01' };
    });
    const start = performance.now();
    const { themes, byNote } = buildThemes(notes);
    const ms = performance.now() - start;
    assert.ok(ms < 1500, `took ${ms}ms`);
    assert.ok(themes.length >= 6 && themes.length <= 60, `${themes.length} themes`);
    assert.ok(byNote.size > 500);
});

test('a journaling note that mentions AI sorts with journaling, not AI', () => {
    day = 1;
    const notes = [
        note('ai1', ['ai', 'llms'], ['Large language models'], { topic: 'Artificial Intelligence' }),
        note('ai2', ['ai', 'agents'], ['Large language models', 'Agents'], { topic: 'Artificial Intelligence' }),
        note('ai3', ['ai', 'prompting'], ['Prompting'], { topic: 'Artificial Intelligence' }),
        // Mentions AI (tag, concept and even a Claude link) but is about journaling.
        note('j1', ['journaling', 'ai', 'prompting'], ['Prompting', 'Morning pages'], {
            topic: 'Journaling', connections: [{ noteId: 'ai3', relation: 'related', reason: '' }]
        }),
        note('j2', ['journaling', 'habits'], ['Morning pages'], { topic: 'Journaling' }),
        note('j3', ['journaling', 'reflection'], ['Gratitude'], { topic: 'Journaling' })
    ];
    const { themes, byNote } = buildThemes(notes);
    assert.strictEqual(byNote.get('j1'), byNote.get('j2'));
    assert.notStrictEqual(byNote.get('j1'), byNote.get('ai1'));
    const journaling = themes.find((t) => t.id === byNote.get('j1'));
    assert.strictEqual(journaling.label, 'Journaling');
    assert.strictEqual(themes.find((t) => t.id === byNote.get('ai1')).label, 'Artificial Intelligence');
    assert.strictEqual(byNote.get('ai1'), 'artificial-intelligence');
});

test('without topics, notes still group by shared tags and links', () => {
    const { themes } = buildThemes(library());
    assert.strictEqual(themes.length, 2);
});

test('theme names keep acronyms', async () => {
    const { prettyName } = await import('../js/themes.js');
    assert.strictEqual(prettyName('ai-agents'), 'AI agents');
    assert.strictEqual(prettyName('saas'), 'SaaS');
    assert.strictEqual(prettyName('deep-work'), 'Deep work');
});
