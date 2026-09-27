const test = require('node:test');
const assert = require('node:assert');
const { normalize, compactLibrary, analyze, ANALYSIS_SCHEMA } = require('../lib/analyze');

test('normalize drops unknown connections and dedupes concepts', () => {
    const result = normalize({
        title: ' T ',
        tldr: 'x',
        summary: [{ heading: 'a', body: 'b' }, { heading: 'empty', body: '' }],
        outline: [{ level: 7, text: 'deep' }, { level: 1, text: '' }],
        concepts: [{ name: 'Spaced repetition', description: 'd' }, { name: 'spaced repetition', description: 'dup' }],
        tags: ['#Memory', 'Learning Science', 'memory'],
        quotes: ['q'],
        takeaways: [],
        connections: [{ noteId: 'n1', relation: 'supports', reason: 'r' }, { noteId: 'ghost', relation: 'related', reason: 'r' }]
    }, new Set(['n1']));
    assert.strictEqual(result.title, 'T');
    assert.strictEqual(result.summary.length, 1);
    assert.deepStrictEqual(result.outline, [{ level: 3, text: 'deep' }]);
    assert.strictEqual(result.concepts.length, 1);
    assert.deepStrictEqual(result.tags, ['memory', 'learning-science']);
    assert.deepStrictEqual(result.connections.map((c) => c.noteId), ['n1']);
});

test('compactLibrary trims fields and drops id-less notes', () => {
    const lib = compactLibrary([{ id: 'a', title: 'x'.repeat(500), concepts: ['c'] }, { title: 'no id' }, null].filter(Boolean));
    assert.strictEqual(lib.length, 1);
    assert.strictEqual(lib[0].title.length, 200);
    assert.deepStrictEqual(compactLibrary('nope'), []);
});

test('schema is strict at every object level', () => {
    const walk = (schema) => {
        if (schema.type === 'object') {
            assert.strictEqual(schema.additionalProperties, false);
            assert.deepStrictEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
            Object.values(schema.properties).forEach(walk);
        }
        if (schema.type === 'array') walk(schema.items);
    };
    walk(ANALYSIS_SCHEMA);
});

test('oversized sources are rejected, not truncated', async () => {
    await assert.rejects(analyze({ sourceType: 'text', text: 'x'.repeat(700000) }, []), (error) => error.status === 413);
});
