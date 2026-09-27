import test from 'node:test';
import assert from 'node:assert';
import { buildGraph } from '../js/graph.js';
import { toMarkdown, fileName } from '../js/markdown.js';
import { splitInput } from '../js/api.js';

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
