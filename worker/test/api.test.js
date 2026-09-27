import test from 'node:test';
import assert from 'node:assert';
import app, { monthlyLimit } from '../src/app.js';
import { fakeEnv, anthropicStub, call } from './helpers.js';

const ANALYSIS = {
    title: 'T', tldr: 'x', summary: [{ heading: 'h', body: 'b' }], outline: [], concepts: [],
    tags: ['Big Idea'], quotes: [], takeaways: [], connections: [{ noteId: 'n1', relation: 'related', reason: 'r' }, { noteId: 'ghost', relation: 'related', reason: 'r' }]
};

function claudeReply() {
    return { json: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: JSON.stringify(ANALYSIS) }], stop_reason: 'end_turn', usage: { input_tokens: 120, output_tokens: 40 } } };
}

test('static files go to assets, api requires a token', async () => {
    const env = fakeEnv();
    const page = await call(app, env, 'GET', '/share?url=x');
    assert.match(await page.text(), /AidedMind/);
    const denied = await call(app, env, 'POST', '/api/source', { body: { url: 'https://example.com' } });
    assert.strictEqual(denied.status, 401);
    const wrong = await call(app, env, 'POST', '/api/auth-check', { token: 'nope' });
    assert.strictEqual(wrong.status, 401);
    const missing = await call(app, env, 'GET', '/api/nothing-here', { token: 'owner-secret' });
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(denied.headers.get('access-control-allow-origin'), '*');
});

test('health reports configuration without secrets', async () => {
    const ok = await call(app, fakeEnv(), 'GET', '/api/health');
    assert.deepStrictEqual((await ok.json()).checks, { anthropicKey: true, ownerToken: true });
    const bad = await call(app, fakeEnv({ ANTHROPIC_API_KEY: '' }), 'GET', '/api/health');
    assert.strictEqual(bad.status, 503);
});

test('deep health explains why the model check failed', async (t) => {
    let status = 401;
    const stub = await anthropicStub(() => (status === 200
        ? { json: { id: 'claude-opus-5', type: 'model' } }
        : { status, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }));
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const bad = await call(app, env, 'GET', '/api/health?deep=1');
    assert.strictEqual(bad.status, 503);
    assert.deepStrictEqual(await bad.json(), {
        ok: false, version: '0.2.0',
        checks: { anthropicKey: true, ownerToken: true, storage: true, model: false },
        problems: { model: 'api_key_rejected' }
    });
    status = 404;
    assert.strictEqual((await (await call(app, env, 'GET', '/api/health?deep=1')).json()).problems.model, 'model_not_available');
    status = 200;
    const good = await (await call(app, env, 'GET', '/api/health?deep=1')).json();
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.problems, undefined);
});

test('source endpoint blocks private addresses', async () => {
    const env = fakeEnv();
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest', 'http://localhost:8787', 'file:///etc/passwd', 'http://[::1]/']) {
        const res = await call(app, env, 'POST', '/api/source', { token: 'owner-secret', body: { url } });
        assert.strictEqual(res.status, 400, url);
    }
});

test('analyze calls Claude, keeps only known connections and meters usage', async (t) => {
    const stub = await anthropicStub(() => claudeReply());
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const res = await call(app, env, 'POST', '/api/analyze', {
        token: 'owner-secret',
        body: { source: { sourceType: 'text', text: 'hello world', title: 'Mine' }, library: [{ id: 'n1', title: 'Other' }] }
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.deepStrictEqual(data.analysis.connections.map((c) => c.noteId), ['n1']);
    assert.deepStrictEqual(data.analysis.tags, ['big-idea']);
    assert.deepStrictEqual(data.usage.limit, null);

    const sent = stub.requests[0];
    assert.strictEqual(sent.url, '/v1/messages?beta=true');
    assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.strictEqual(sent.body.model, 'claude-opus-5');
    assert.strictEqual(sent.body.fallbacks, 'default');
    assert.strictEqual(sent.body.output_config.format.type, 'json_schema');
    assert.deepStrictEqual(sent.body.messages[0].content.map((b) => b.type), ['text', 'document', 'text']);

    const usage = await env.STORE.get('user:owner').usageFor(new Date().toISOString().slice(0, 7));
    assert.deepStrictEqual(usage, { captures: 1, inputTokens: 120, outputTokens: 40 });
});

test('accounts: owner creates users, free plan quota enforced, failures refunded', async (t) => {
    let fail = false;
    const stub = await anthropicStub(() => (fail ? { status: 500, json: { type: 'error', error: { type: 'api_error', message: 'boom' } } } : claudeReply()));
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });

    const created = await call(app, env, 'POST', '/api/admin/users', { token: 'owner-secret', body: { label: 'Sam', plan: 'free' } });
    assert.strictEqual(created.status, 201);
    const { token, id, limit } = await created.json();
    assert.strictEqual(limit, 2);

    const forbidden = await call(app, env, 'GET', '/api/admin/users', { token });
    assert.strictEqual(forbidden.status, 403);

    const analyzeOnce = () => call(app, env, 'POST', '/api/analyze', { token, body: { source: { text: 'some text' }, library: [] } });
    fail = true;
    const failed = await analyzeOnce();
    assert.strictEqual(failed.status, 502);
    fail = false;
    assert.strictEqual((await analyzeOnce()).status, 200);
    assert.strictEqual((await analyzeOnce()).status, 200);
    const blocked = await analyzeOnce();
    assert.strictEqual(blocked.status, 402);
    assert.deepStrictEqual((await blocked.json()).usage.captures, 2);

    const list = await (await call(app, env, 'GET', '/api/admin/users', { token: 'owner-secret' })).json();
    assert.strictEqual(list.users[0].usage.captures, 2);

    const paused = await call(app, env, 'PATCH', `/api/admin/users/${id}`, { token: 'owner-secret', body: { status: 'paused' } });
    assert.strictEqual((await paused.json()).status, 'paused');
    assert.strictEqual((await call(app, env, 'POST', '/api/auth-check', { token })).status, 403);
});

test('inbox is per user', async () => {
    const env = fakeEnv();
    const other = await (await call(app, env, 'POST', '/api/admin/users', { token: 'owner-secret', body: { label: 'B' } })).json();
    const saved = await call(app, env, 'POST', '/api/inbox', { token: 'owner-secret', body: { url: 'https://example.com/a' } });
    assert.strictEqual(saved.status, 201);
    assert.strictEqual((await call(app, env, 'POST', '/api/inbox', { token: 'owner-secret', body: {} })).status, 400);
    const mine = await (await call(app, env, 'GET', '/api/inbox', { token: 'owner-secret' })).json();
    const theirs = await (await call(app, env, 'GET', '/api/inbox', { token: other.token })).json();
    assert.strictEqual(mine.items.length, 1);
    assert.strictEqual(theirs.items.length, 0);
    const removed = await (await call(app, env, 'DELETE', `/api/inbox/${mine.items[0].id}`, { token: 'owner-secret' })).json();
    assert.strictEqual(removed.ok, true);
});

test('plan limits', () => {
    assert.strictEqual(monthlyLimit('owner', {}), null);
    assert.strictEqual(monthlyLimit('free', {}), 25);
    assert.strictEqual(monthlyLimit('pro', { PRO_MONTHLY_CAPTURES: '50' }), 50);
});
