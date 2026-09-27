const test = require('node:test');
const assert = require('node:assert');

process.env.AIDEDMIND_ACCESS_TOKEN = 'test-token';
process.env.AIDEDMIND_INBOX_PATH = require('node:path').join(require('node:os').tmpdir(), `aidedmind-inbox-${process.pid}.json`);
const app = require('../index');

test('capture endpoint enforces the access token', async (t) => {
    const server = app.listen(0);
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;

    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.strictEqual(health.ok, true);

    const denied = await fetch(`${base}/api/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AidedMind-Token': 'wrong' },
        body: JSON.stringify({ text: 'hi' })
    });
    assert.strictEqual(denied.status, 401);

    const badInput = await fetch(`${base}/api/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AidedMind-Token': 'test-token' },
        body: JSON.stringify({ url: 42 })
    });
    assert.strictEqual(badInput.status, 400);

    const ssrf = await fetch(`${base}/api/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AidedMind-Token': 'test-token' },
        body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data' })
    });
    assert.strictEqual(ssrf.status, 400);

    const shell = await fetch(`${base}/share?url=https%3A%2F%2Fexample.com`);
    assert.strictEqual(shell.status, 200);
    assert.match(await shell.text(), /<title>AidedMind<\/title>/);

    const headers = { 'Content-Type': 'application/json', 'X-AidedMind-Token': 'test-token' };
    const saved = await fetch(`${base}/api/inbox`, { method: 'POST', headers, body: JSON.stringify({ url: 'https://example.com/a' }) });
    assert.strictEqual(saved.status, 201);
    const empty = await fetch(`${base}/api/inbox`, { method: 'POST', headers, body: JSON.stringify({}) });
    assert.strictEqual(empty.status, 400);
    const unauth = await fetch(`${base}/api/inbox`);
    assert.strictEqual(unauth.status, 401);
    const { items } = await fetch(`${base}/api/inbox`, { headers }).then((r) => r.json());
    assert.deepStrictEqual(items.map((i) => i.url), ['https://example.com/a']);
    const removed = await fetch(`${base}/api/inbox/${items[0].id}`, { method: 'DELETE', headers }).then((r) => r.json());
    assert.strictEqual(removed.ok, true);
    const after = await fetch(`${base}/api/inbox`, { headers }).then((r) => r.json());
    assert.strictEqual(after.items.length, 0);
});
