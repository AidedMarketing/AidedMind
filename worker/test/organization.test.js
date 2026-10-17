import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { normalizeConcepts } from '../src/knowledge-extraction.js';
import { eligibleLink } from '../src/link-quality.js';
import { fakeEnv, anthropicStub, call } from './helpers.js';

const source = 'Spaced repetition strengthens recall by separating practice across days.';
const target = 'Spaced repetition supports retention through revisiting material on different days.';
const connection = { noteId: 'target', relation: 'related', basis: 'same-framework', reason: 'Both explain spaced repetition.', confidence: .9,
    evidence: { source, target } };

test('direct links need verified passages with a distinctive shared subject', () => {
    const result = eligibleLink(connection, source, { passages: [target] });
    assert.equal(result.relation, 'related');
    assert.ok(result.anchors.includes('spaced'));
    assert.equal(result.qualityVersion, 3);
    assert.equal(eligibleLink(connection, source, { passages: ['An unrelated captured passage.'] }), null);
    assert.equal(eligibleLink({ ...connection, basis: 'analogy' }, source, { passages: [target] }), null);
    assert.equal(eligibleLink({ ...connection, basis: 'incidental' }, source, { passages: [target] }), null);
});
test('generic list and foundational-practice analogies cannot become map edges', () => {
    const left = 'A list of shows helps people organize their personal time.';
    const right = 'A list of ideas helps people organize their personal growth.';
    assert.equal(eligibleLink({ ...connection, evidence: { source: left, target: right } }, left, { passages: [right] }), null);
    const herb = 'Build health by learning to prepare a few herbs first.';
    const audit = 'Build health by learning to focus on personal growth first.';
    assert.equal(eligibleLink({ ...connection, evidence: { source: herb, target: audit } }, herb, { passages: [audit] }), null);
});
test('concepts without supporting original passages are removed', () => {
    const result = normalizeConcepts([
        { name: 'Spaced repetition', description: 'Separating practice over time.', evidence: source },
        { name: 'Spaced Repetition', description: 'Duplicate.', evidence: source },
        { name: 'Imported framework', description: 'An unrelated framework.', evidence: 'A passage absent from the captured source.' },
        { name: 'Bare label', description: 'No supporting passage.' }
    ], source);
    assert.equal(result.length, 1);
    assert.equal(result[0].evidence, source);
});
test('organization endpoint is authenticated and flags thin articles without a model call', async () => {
    const env = fakeEnv();
    assert.equal((await call(app, env, 'POST', '/api/organization', { body: { source: { text: source } } })).status, 401);
    const response = await call(app, env, 'POST', '/api/organization', { token: 'owner-secret', body: {
        source: { sourceType: 'article', title: 'A collection of research', text: 'Heading, byline and one introductory question.' }
    } });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.proposal.quality.status, 'needs-review');
    assert.equal(data.proposal.topic, undefined);
});
test('organization preview uses only the original source and meters tokens without a new breakdown', async (t) => {
    const stub = await anthropicStub(() => ({ json: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: JSON.stringify({ topic: 'Memory', concepts: [{ name: 'Spaced repetition', description: 'Practice over time.', evidence: source }], tags: ['memory'] }) }],
        stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } } }));
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const response = await call(app, env, 'POST', '/api/organization', { token: 'owner-secret', body: {
        source: { sourceType: 'text', text: source, title: 'Memory practice' },
        topic: 'Unrelated old category', concepts: ['Unrelated old concept'], library: [{ title: 'Unrelated old note' }]
    } });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.proposal.topic, 'Memory');
    assert.equal(data.proposal.concepts[0].evidence, source);
    assert.doesNotMatch(JSON.stringify(stub.requests[0].body.messages), /Unrelated old/);
    const month = new Date().toISOString().slice(0, 7);
    const usage = await env.STORE.get('user:owner').usageFor(month);
    assert.equal(usage.captures, 0);
    assert.ok(env.STORE.get('user:owner').costsFor(month).length > 0);
});

test('sharing generic AI terminology does not connect clinical research to an assistant', () => {
    const left = 'AI models use machine learning and data for medical research.';
    const right = 'AI models use machine learning and data for office tasks.';
    assert.equal(eligibleLink({ ...connection, basis: 'same-specific-subject', evidence: { source: left, target: right } }, left, { passages: [right] }), null);
});
test('potentially incomplete article sources do not incur connection model requests', async () => {
    const response = await call(app, fakeEnv(), 'POST', '/api/connections', { token: 'owner-secret', body: {
        note: { title: 'An introduction only', sourceType: 'article', sourceText: 'This introduction promises a collection of research.' },
        library: [{ id: 'other', title: 'Another article', passages: [target] }]
    } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).connections, []);
});
