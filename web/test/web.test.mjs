import test from 'node:test';
import assert from 'node:assert';
import { buildGraph } from '../js/graph.js';
import { toMarkdown, fileName } from '../js/markdown.js';
import { splitInput } from '../js/api.js';
import { relatedNotes, conceptVocabulary, canonicalUrl, findDuplicate } from '../js/library.js';

const notes = [
    { id: 'a', title: 'Spacing effect', source: { sourceType: 'article' }, concepts: [{ name: 'Memory' }], connections: [{ noteId: 'b', relation: 'supports', reason: 'r' }], tags: ['learning'], createdAt: '2026-01-01', tldr: 't' },
    { id: 'b', title: 'Anki tips', source: { sourceType: 'youtube' }, concepts: [{ name: 'memory' }, { name: 'Flashcards' }], connections: [], userNotes: 'see [[Sleep and recall]]', createdAt: '2026-01-02', tldr: 't' },
    { id: 'c', title: 'Sleep and recall', source: { sourceType: 'tiktok' }, concepts: [], connections: [], createdAt: '2026-01-03', tldr: 't' },
    { id: 'd', title: 'Unrelated', source: { sourceType: 'text' }, concepts: [], connections: [], createdAt: '2026-01-04', tldr: 't' }
];

test('graph links notes, wikilinks and shared concepts', () => {
    const graph = buildGraph(notes);
    const ids = graph.nodes.map((n) => n.id).sort();
    assert.deepStrictEqual(ids, ['a', 'b', 'c', 'concept:memory', 'd']);
    const keys = graph.links.map((l) => `${l.source}-${l.target}`).sort();
    assert.deepStrictEqual(keys, ['a-b', 'a-concept:memory', 'b-c', 'b-concept:memory']);
});

test('local graph keeps only the neighbourhood', () => {
    const local = buildGraph(notes, { focusId: 'c', depth: 1, showConcepts: false });
    assert.deepStrictEqual(local.nodes.map((n) => n.id).sort(), ['b', 'c']);
});

test('markdown export uses wikilinks and frontmatter', () => {
    const md = toMarkdown(notes[0], new Map(notes.map((n) => [n.id, n])));
    assert.match(md, /^---\ntitle: "Spacing effect"/);
    assert.match(md, /\[\[Anki tips\]\] \(supports\)/);
    assert.match(md, /- \[\[Memory\]\]/);
    assert.strictEqual(fileName({ title: 'a/b: c?' }), 'ab c.md');
});

test('shared text with a link is fetched as a link', () => {
    assert.deepStrictEqual(splitInput('Look at this https://vm.tiktok.com/ZMabc/ '), { url: 'https://vm.tiktok.com/ZMabc/', text: '' });
    assert.deepStrictEqual(splitInput('(https://example.com/a).'), { url: 'https://example.com/a', text: '' });
    const long = `${'word '.repeat(80)} https://example.com`;
    assert.strictEqual(splitInput(long).text, long.trim());
});

test('zip archive has valid structure', async () => {
    const { createZip } = await import('../js/zip.js');
    const blob = createZip([{ name: 'AidedMind/a.md', content: 'hello' }, { name: 'AidedMind/b.md', content: 'wörld' }]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    assert.strictEqual(view.getUint32(0, true), 0x04034b50);
    const end = bytes.length - 22;
    assert.strictEqual(view.getUint32(end, true), 0x06054b50);
    assert.strictEqual(view.getUint16(end + 10, true), 2);
    // CRC-32 of "hello"
    assert.strictEqual(view.getUint32(14, true), 0x3610a686);
});

function libraryOf(count) {
    return Array.from({ length: count }, (_, i) => ({
        id: `x${i}`, title: `Cooking tip ${i}`, tldr: 'How to cook pasta well', tags: ['cooking'],
        concepts: [{ name: 'Pasta' }], createdAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`
    }));
}

test('small libraries are sent whole', () => {
    const lib = libraryOf(12);
    assert.strictEqual(relatedNotes(lib, { text: 'anything' }).length, 12);
});

test('large libraries send only related notes', () => {
    const lib = libraryOf(200);
    lib.push({ id: 'sleep', title: 'Why sleep consolidates memory', tldr: 'Deep sleep replays the day', tags: ['sleep', 'memory'], concepts: [{ name: 'Memory consolidation' }], createdAt: '2025-01-01' });
    lib.push({ id: 'spacing', title: 'The spacing effect', tldr: 'Reviewing later beats cramming for memory', tags: ['learning'], concepts: [{ name: 'Spaced repetition' }], createdAt: '2025-01-02' });
    const picked = relatedNotes(lib, { title: 'Sleep and learning', text: 'Researchers found memory consolidation happens during deep sleep, and spaced repetition helps.' });
    assert.ok(picked.length <= 20);
    assert.deepStrictEqual(picked.slice(0, 2).map((n) => n.id).sort(), ['sleep', 'spacing']);
    const none = relatedNotes(lib, { text: '' });
    assert.strictEqual(none.length, 8); // falls back to the newest notes
});

test('concept vocabulary counts names across notes', () => {
    const lib = [...libraryOf(3), { id: 'z', concepts: [{ name: 'memory' }] }, { id: 'y', concepts: [{ name: 'Memory' }, { name: 'Memory' }] }];
    assert.deepStrictEqual(conceptVocabulary(lib), ['Pasta', 'memory']);
});

test('duplicate links are recognised despite tracking and short forms', () => {
    assert.strictEqual(canonicalUrl('https://www.example.com/post/?utm_source=x&b=2&a=1#top'), 'example.com/post?a=1&b=2');
    assert.strictEqual(canonicalUrl('https://youtu.be/abc123?si=xyz'), 'youtube:abc123');
    assert.strictEqual(canonicalUrl('https://m.youtube.com/watch?v=abc123&t=30s'), 'youtube:abc123');
    assert.strictEqual(canonicalUrl('https://www.youtube.com/shorts/abc123'), 'youtube:abc123');
    assert.strictEqual(canonicalUrl('not a url'), '');
    const lib = [{ id: 'a', source: { url: 'https://www.tiktok.com/@me/video/1', sharedUrl: 'https://vm.tiktok.com/ZM1/' } }];
    assert.strictEqual(findDuplicate(lib, 'https://vm.tiktok.com/ZM1')?.id, 'a');
    assert.strictEqual(findDuplicate(lib, 'https://tiktok.com/@me/video/1?is_from_webapp=1')?.id, 'a');
    assert.strictEqual(findDuplicate(lib, 'https://example.com/other'), null);
    assert.strictEqual(findDuplicate(lib, ''), null);
});

test('settings version matches the service worker cache version', async () => {
    const { readFile } = await import('node:fs/promises');
    const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
    const sw = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
    const appVersion = app.match(/const APP_VERSION = '(\d+)'/)[1];
    const cacheVersion = sw.match(/const CACHE_NAME = 'aidedmind-v(\d+)'/)[1];
    assert.strictEqual(appVersion, cacheVersion);
    // Every precached script must exist, or installing the update fails.
    for (const [, path] of sw.matchAll(/'\.\/(js\/[\w.-]+\.js)'/g)) {
        await readFile(new URL(`../${path}`, import.meta.url));
    }
});
