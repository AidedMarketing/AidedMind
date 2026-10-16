import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyEvidence } from '../src/link-evidence.js';
import { normalize, compactLibrary } from '../src/analyze.js';

const source = 'Repeated practice helps people remember what they learn.';
const target = 'Spaced practice improves retention across multiple sessions.';
test('strong relationship labels need literal evidence in both sources', () => {
    const connection = { relation: 'supports', evidence: { source, target } };
    assert.equal(verifyEvidence(connection, source, { passages: [target] }).relation, 'supports');
    assert.equal(verifyEvidence(connection, source, { passages: ['Different content entirely.'] }).relation, 'related');
    assert.equal(verifyEvidence({ relation: 'contradicts' }, source).relation, 'related');
    assert.equal(verifyEvidence({ relation: 'related' }, source).evidence, null);
});
test('analysis normalization validates evidence against the matching library piece', () => {
    const library = compactLibrary([{ id: 'a', passages: [target] }, { id: 'b', passages: ['Another piece without this evidence.'] }]);
    const raw = { connections: ['a', 'b'].map((noteId) => ({ noteId, relation: 'supports', reason: 'Specific relationship', confidence: .9, evidence: { source, target } })) };
    const result = normalize(raw, new Set(['a', 'b']), { sourceText: source, library });
    assert.deepEqual(result.connections.map((c) => c.relation), ['supports', 'related']);
});
