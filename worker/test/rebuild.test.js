import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlStore, fakeEnv, call } from './helpers.js';
import { assertPublicUrl, fetchPage } from '../src/extract.js';
import { summarizeCosts } from '../src/costs.js';
import app from '../src/app.js';

test('a full inbox refuses new work without dropping any saved item', () => {
    const core = sqlStore();
    for (let i = 0; i < 200; i++) core.inboxAdd({ url: `https://example.com/${i}` });
    assert.deepEqual(core.inboxAdd({ url: 'https://example.com/new' }), { full: true });
    assert.equal(core.inboxList().length, 200);
    assert.equal(core.inboxList()[0].url, 'https://example.com/0');
    const repeat = core.inboxAdd({ url: 'https://example.com/0?utm_source=share' });
    assert.equal(repeat.reused, true);
});
test('Safari upgrades a processing share and invalidates the old result', () => {
    const core = sqlStore();
    const original = core.inboxAdd({ url: 'https://example.com/story' });
    const oldClaim = core.inboxClaim(Date.now() + 1, 120000);
    const upgrade = core.inboxAdd({ url: 'https://example.com/story?utm_source=share', text: 'Readable article', capture: { kind: 'safari' } });
    assert.equal(upgrade.id, original.id);
    assert.equal(core.inboxIsCurrent(oldClaim), false);
    assert.equal(core.inboxList().length, 1);
    assert.equal(core.inboxList()[0].text, 'Readable article');
    assert.equal(core.inboxList()[0].status, 'pending');
    assert.equal(core.inboxAdd({ url: 'https://example.com/story', text: 'Readable article', capture: { kind: 'safari' } }).id, original.id);
});
test('IPv4-mapped private IPv6 and numeric loopback URLs are blocked', () => {
    for (const url of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://2130706433/', 'http://[::ffff:c0a8:101]/']) assert.throws(() => assertPublicUrl(url));
});
test('a redirect to a private destination is rejected before fetching it', async (t) => {
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    const urls = [];
    globalThis.fetch = async (url, init) => { urls.push(String(url)); assert.equal(init.redirect, 'manual'); return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }); };
    await assert.rejects(fetchPage('https://example.com/public'), /private or local/);
    assert.deepEqual(urls, ['https://example.com/public']);
});
test('Gemini ledger includes analysis and transcript tokens', () => {
    const result = summarizeCosts([{ item: 'gemini:analysis_input', amount: 100 }, { item: 'gemini:analysis_output', amount: 20 }, { item: 'gemini:input', amount: 10 }]);
    assert.equal(result.geminiTokens, 130);
});
test('supporting paid requests are quota, concurrency and rate bounded', () => {
    const core = sqlStore();
    core.reserveCapture(new Date().toISOString().slice(0, 7), 1);
    assert.equal(core.beginOperation('source', 1).error, 'quota');
    const leases = Array.from({ length: 3 }, () => core.beginOperation('connections', null));
    assert.equal(core.beginOperation('connections', null).error, 'busy');
    core.endOperation(leases[0].id);
    assert.ok(core.beginOperation('source', null).id);
    assert.ok(core.beginOperation('source', null, Date.now() + 11 * 60000).id);
});
test('full inbox returns a recoverable HTTP error over the API', async () => {
    const env = fakeEnv();
    for (let i = 0; i < 200; i++) await call(app, env, 'POST', '/api/inbox', { token: 'owner-secret', body: { url: `https://example.com/${i}` } });
    const res = await call(app, env, 'POST', '/api/inbox', { token: 'owner-secret', body: { url: 'https://example.com/full' } });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /Existing items are safe/);
});
