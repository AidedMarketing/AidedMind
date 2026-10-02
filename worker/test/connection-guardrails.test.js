import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/analyze.js';
import { suggestConnections } from '../src/connections.js';
import { fakeEnv, anthropicStub } from './helpers.js';

test('analysis and connection responses enforce confidence bounds locally', async (t) => {
    const connections = [
        { noteId: 'a', relation: 'related', reason: 'Strong', confidence: 9 },
        { noteId: 'b', relation: 'related', reason: 'Weak', confidence: -2 }
    ];
    assert.deepEqual(normalize(baseRaw(connections), new Set(['a', 'b'])).connections.map(c => [c.noteId, c.confidence]), [['a', 1]]);
    const stub = await anthropicStub(() => ({ json: {
        id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: JSON.stringify({ connections }) }],
        stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }
    } }));
    t.after(() => stub.close());
    const result = await suggestConnections({ title: 'New note' }, [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], fakeEnv({ ANTHROPIC_BASE_URL: stub.url }));
    assert.deepEqual(result.connections.map(c => [c.noteId, c.confidence]), [['a', 1]]);
});

function baseRaw(connections) {
    return {
        title: 'New note',
        topic: 'Learning',
        tldr: 'A short summary.',
        sourceText: '',
        summary: [{ heading: 'Idea', body: 'Body' }],
        outline: [],
        concepts: [],
        tags: [],
        quotes: [],
        takeaways: [],
        connections
    };
}

test('automatic links keep only strong unique relationships and cap at six', () => {
    const ids = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const result = normalize(baseRaw([
        { noteId: 'a', relation: 'related', reason: 'A', confidence: 0.95 },
        { noteId: 'b', relation: 'related', reason: 'Too weak', confidence: 0.71 },
        { noteId: 'c', relation: 'supports', reason: 'C', confidence: 0.93 },
        { noteId: 'd', relation: 'extends', reason: 'D', confidence: 0.91 },
        { noteId: 'e', relation: 'related', reason: 'E', confidence: 0.89 },
        { noteId: 'f', relation: 'example-of', reason: 'F', confidence: 0.87 },
        { noteId: 'g', relation: 'related', reason: 'G', confidence: 0.85 },
        { noteId: 'h', relation: 'related', reason: 'H', confidence: 0.83 },
        { noteId: 'c', relation: 'related', reason: 'Duplicate C', confidence: 0.99 },
        { noteId: 'missing', relation: 'related', reason: 'Not in library', confidence: 1 }
    ]), ids);

    assert.equal(result.connections.length, 6);
    assert.deepEqual(result.connections.map((c) => c.noteId), ['a', 'c', 'd', 'e', 'f', 'g']);
    assert.ok(result.connections.every((c) => c.confidence >= 0.72));
    assert.ok(result.connections.every((c) => c.origin === 'aidedmind'));
});

test('legacy automatic links without confidence remain compatible', () => {
    const result = normalize(baseRaw([
        { noteId: 'old', relation: 'related', reason: 'Existing saved relationship' }
    ]), new Set(['old']));

    assert.equal(result.connections.length, 1);
    assert.equal(result.connections[0].confidence, 0.8);
    assert.equal(result.connections[0].origin, 'aidedmind');
});
