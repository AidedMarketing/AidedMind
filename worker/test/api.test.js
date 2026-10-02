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
        services: { gemini: false, supadata: false },
        problems: { model: 'api_key_rejected' }
    });
    status = 404;
    assert.strictEqual((await (await call(app, env, 'GET', '/api/health?deep=1')).json()).problems.model, 'model_not_available:quick');
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
        body: { source: { sourceType: 'text', text: 'hello world', title: 'Mine' }, library: [{ id: 'n1', title: 'Other' }], depth: 'balanced' }
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.deepStrictEqual(data.analysis.connections.map((c) => c.noteId), ['n1']);
    assert.deepStrictEqual(data.analysis.tags, ['big-idea']);
    assert.deepStrictEqual(data.usage.limit, null);

    const sent = stub.requests[0];
    assert.strictEqual(sent.url, '/v1/messages');
    assert.strictEqual(sent.body.model, 'claude-sonnet-5-5');
    assert.strictEqual(sent.body.fallbacks, undefined);
    assert.deepStrictEqual(sent.body.thinking, { type: 'adaptive' });
    assert.strictEqual(sent.body.output_config.effort, 'medium');
    assert.strictEqual(sent.body.output_config.format.type, 'json_schema');
    assert.deepStrictEqual(sent.body.messages[0].content.map((b) => b.type), ['text', 'document', 'text']);
    assert.match(sent.body.messages[0].content[2].text, /3-5 summary sections/);
    assert.strictEqual(data.depth, 'balanced');

    const usage = await env.STORE.get('user:owner').usageFor(new Date().toISOString().slice(0, 7));
    assert.deepStrictEqual(usage, { captures: 1, inputTokens: 120, outputTokens: 40 });
});

test('analyze caps the library index and passes known concepts', async (t) => {
    const stub = await anthropicStub(() => claudeReply());
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const library = Array.from({ length: 90 }, (_, i) => ({ id: `n${i}`, title: `Note ${i}` }));
    const concepts = ['Memory', 'memory', ' Sleep ', '', ...Array.from({ length: 300 }, (_, i) => `c${i}`)];
    const res = await call(app, env, 'POST', '/api/analyze', { token: 'owner-secret', body: { source: { text: 'hello world' }, library, concepts } });
    assert.strictEqual(res.status, 200);
    const text = stub.requests[0].body.messages[0].content[0].text;
    const index = JSON.parse(text.match(/<library_index>\n(.*)\n<\/library_index>/)[1]);
    assert.strictEqual(index.length, 60);
    const known = JSON.parse(text.match(/<known_concepts>\n(.*)\n<\/known_concepts>/)[1]);
    assert.deepStrictEqual(known.slice(0, 3), ['Memory', 'Sleep', 'c0']);
    assert.strictEqual(known.length, 200);

    await call(app, env, 'POST', '/api/analyze', { token: 'owner-secret', body: { source: { text: 'hello world' }, library: [] } });
    assert.doesNotMatch(stub.requests[1].body.messages[0].content[0].text, /known_concepts/);
});

test('analyze asks for a main topic and passes known topics', async (t) => {
    const stub = await anthropicStub(() => ({ json: { ...claudeReply().json, content: [{ type: 'text', text: JSON.stringify({ ...ANALYSIS, topic: ' Journaling. ' }) }] } }));
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const res = await call(app, env, 'POST', '/api/analyze', {
        token: 'owner-secret',
        body: { source: { text: 'hello world' }, library: [{ id: 'n1', title: 'Other', topic: 'Sleep' }], topics: ['Sleep', 'sleep', 'Artificial Intelligence'] }
    });
    const data = await res.json();
    assert.strictEqual(data.analysis.topic, 'Journaling');
    const sent = stub.requests[0].body;
    assert.ok(sent.output_config.format.schema.required.includes('topic'));
    const text = sent.messages[0].content[0].text;
    assert.deepStrictEqual(JSON.parse(text.match(/<known_topics>\n(.*)\n<\/known_topics>/)[1]), ['Sleep', 'Artificial Intelligence']);
    assert.match(text, /"topic":"Sleep"/);
    assert.match(sent.system, /not what it mentions in passing|passing mention/);
});

test('topics endpoint sorts existing notes in one quick call and meters it', async (t) => {
    const stub = await anthropicStub(() => ({ json: { ...claudeReply().json, model: 'claude-haiku-4-5', content: [{ type: 'text', text: JSON.stringify({ assignments: [{ id: 'a', topic: 'Journaling' }, { id: 'ghost', topic: 'X' }, { id: 'b', topic: '' }] }) }] } }));
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const res = await call(app, env, 'POST', '/api/topics', {
        token: 'owner-secret',
        body: { notes: [{ id: 'a', title: 'Morning pages', tldr: 'Write daily', tags: ['journaling', 'ai'] }, { id: 'b', title: 'B' }], topics: ['Sleep'] }
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.deepStrictEqual(data.assignments, { a: 'Journaling' });
    const sent = stub.requests[0].body;
    assert.strictEqual(sent.model, 'claude-haiku-4-5');
    assert.strictEqual(sent.thinking, undefined);
    assert.match(sent.messages[0].content, /<known_topics>/);
    const usage = await env.STORE.get('user:owner').usageFor(new Date().toISOString().slice(0, 7));
    assert.strictEqual(usage.captures, 1);

    const tooMany = await call(app, env, 'POST', '/api/topics', { token: 'owner-secret', body: { notes: Array.from({ length: 151 }, (_, i) => ({ id: `n${i}` })) } });
    assert.strictEqual(tooMany.status, 413);
    assert.strictEqual((await env.STORE.get('user:owner').usageFor(new Date().toISOString().slice(0, 7))).captures, 1); // refunded
});

test('breakdown styles pick the right model and options', async (t) => {
    const stub = await anthropicStub(() => claudeReply());
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const send = (depth, text = 'hello world') => call(app, env, 'POST', '/api/analyze', { token: 'owner-secret', body: { source: { text }, library: [], depth } });

    assert.strictEqual((await (await send('quick')).json()).depth, 'quick');
    let sent = stub.requests.at(-1);
    assert.strictEqual(sent.url, '/v1/messages');
    assert.strictEqual(sent.body.model, 'claude-haiku-4-5');
    assert.strictEqual(sent.body.thinking, undefined);
    assert.strictEqual(sent.body.output_config.effort, undefined);
    assert.match(sent.body.messages[0].content[2].text, /Keep it brief/);

    assert.strictEqual((await (await send('thorough')).json()).depth, 'thorough');
    sent = stub.requests.at(-1);
    assert.strictEqual(sent.url, '/v1/messages?beta=true');
    assert.strictEqual(sent.body.model, 'claude-opus-5-5');
    assert.strictEqual(sent.body.fallbacks, 'default');
    assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.deepStrictEqual(sent.body.thinking, { type: 'adaptive' });
    assert.strictEqual(sent.body.output_config.effort, 'medium');

    // Unknown styles fall back to the default (Auto); very long sources skip Quick.
    const unknown = await (await send('turbo')).json();
    assert.deepStrictEqual([unknown.depth, unknown.auto], ['quick', true]);
    assert.strictEqual((await (await send('quick', 'x'.repeat(400000))).json()).depth, 'balanced');

    // Per-style model overrides from wrangler vars.
    const custom = fakeEnv({ ANTHROPIC_BASE_URL: stub.url, AIDEDMIND_MODEL_BALANCED: 'claude-opus-5', AIDEDMIND_DEFAULT_DEPTH: 'balanced' });
    await call(app, custom, 'POST', '/api/analyze', { token: 'owner-secret', body: { source: { text: 'hi' }, library: [] } });
    assert.strictEqual(stub.requests.at(-1).body.model, 'claude-opus-5');
    assert.strictEqual(stub.requests.at(-1).body.fallbacks, 'default');
});

test('auto style picks from what was shared', async (t) => {
    const stub = await anthropicStub(() => claudeReply());
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(' ');
    const send = async (source) => {
        const data = await (await call(app, env, 'POST', '/api/analyze', { token: 'owner-secret', body: { source, library: [] } })).json();
        return [data.depth, data.auto, stub.requests.at(-1).body.model];
    };
    assert.deepStrictEqual(await send({ sourceType: 'text', text: words(300) }), ['quick', true, 'claude-haiku-4-5']);
    assert.deepStrictEqual(await send({ sourceType: 'tiktok', text: words(900), partial: true }), ['quick', true, 'claude-haiku-4-5']);
    assert.deepStrictEqual(await send({ sourceType: 'article', text: words(2500) }), ['balanced', true, 'claude-sonnet-5-5']);
    assert.deepStrictEqual(await send({ sourceType: 'youtube', text: words(15000) }), ['thorough', true, 'claude-opus-5-5']);
    // An explicit style is honored and not marked auto.
    const fixed = await (await call(app, env, 'POST', '/api/analyze', { token: 'owner-secret', body: { source: { text: words(300) }, library: [], depth: 'thorough' } })).json();
    assert.deepStrictEqual([fixed.depth, fixed.auto], ['thorough', false]);
    const fuller = await (await call(app, env, 'POST', '/api/analyze', { token: 'owner-secret', body: { source: { text: words(2500) }, library: [], depth: 'expanded' } })).json();
    assert.deepStrictEqual([fuller.depth, fuller.auto, stub.requests.at(-1).body.model], ['expanded', false, 'claude-sonnet-5-5']);
    assert.match(JSON.stringify(stub.requests.at(-1).body.messages), /fuller reading/);
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
    assert.strictEqual((await failed.json()).code, 'provider_unavailable');
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

test('analysis request rejection is distinct from text length and preserves quota', async (t) => {
    const stub = await anthropicStub(() => ({ status: 400, json: {
        type: 'error', error: { type: 'invalid_request_error', message: 'Unsupported request option' }
    } }));
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const response = await call(app, env, 'POST', '/api/analyze', { token: 'owner-secret', body: {
        source: { sourceType: 'tiktok', text: 'A short video caption' }, depth: 'quick'
    } });
    const result = await response.json();
    assert.strictEqual(response.status, 502);
    assert.strictEqual(result.code, 'analysis_request_rejected');
    assert.strictEqual(result.providerStatus, 400);
    assert.strictEqual(result.model, 'claude-haiku-4-5');
    assert.match(result.error, /rejected AidedMind's analysis request/);
    assert.doesNotMatch(result.error, /shorter|Unsupported request option/);
    assert.strictEqual(stub.requests.length, 1);
    assert.strictEqual((await env.STORE.get('user:owner').usageFor(new Date().toISOString().slice(0, 7))).captures, 0);
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

test('photos: sent to Claude as images, auto style by count, text read back', async (t) => {
    const reply = {
        title: 'Book page', tldr: 'x', summary: [], outline: [], concepts: [], tags: [], quotes: [], takeaways: [], connections: [],
        sourceText: 'Chapter 3. Habits compound over time.'
    };
    const stub = await anthropicStub(() => ({ json: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: JSON.stringify(reply) }], stop_reason: 'end_turn', usage: { input_tokens: 1600, output_tokens: 300 } } }));
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const photo = { mediaType: 'image/jpeg', data: Buffer.from('fake-jpeg-bytes').toString('base64') };
    const send = (images, text = '') => call(app, env, 'POST', '/api/analyze', {
        token: 'owner-secret',
        body: { source: { sourceType: 'photo', title: 'Page', text, images }, library: [] }
    });

    const one = await (await send([photo], 'From chapter 3')).json();
    assert.strictEqual(one.depth, 'balanced');
    assert.strictEqual(one.analysis.sourceText, 'Chapter 3. Habits compound over time.');
    const content = stub.requests.at(-1).body.messages[0].content;
    assert.deepStrictEqual(content.map((b) => b.type), ['text', 'text', 'image', 'text', 'text']);
    assert.deepStrictEqual(content[2].source, { type: 'base64', media_type: 'image/jpeg', data: photo.data });
    assert.match(content[3].text, /The user added this context:\nFrom chapter 3/);
    assert.match(content[4].text, /Transcribe the photos into sourceText/);

    const article = await call(app, env, 'POST', '/api/analyze', { token: 'owner-secret', body: {
        source: { sourceType: 'article', title: 'Story', url: 'https://example.com/story', text: 'The original article paragraph.', images: [photo] }, library: []
    } });
    assert.strictEqual(article.status, 200);
    const articleContent = stub.requests.at(-1).body.messages[0].content;
    assert.deepStrictEqual(articleContent.map((b) => b.type), ['text', 'document', 'text', 'image', 'text', 'text']);
    assert.match(articleContent[1].source.data, /original article paragraph/);

    assert.strictEqual((await (await send(Array(6).fill(photo))).json()).depth, 'thorough');
    assert.strictEqual((await send(Array(9).fill(photo))).status, 413);
    assert.strictEqual((await send([{ mediaType: 'image/tiff', data: photo.data }])).status, 415);
    assert.strictEqual((await send([{ mediaType: 'image/png', data: 'not base64!' }])).status, 400);
    // Rejected photos don't use up the monthly quota.
    const usage = await env.STORE.get('user:owner').usageFor(new Date().toISOString().slice(0, 7));
    assert.strictEqual(usage.captures, 3);
});


test('recovery files bypass authentication and map only to dedicated static assets', async () => {
    const paths = [];
    const env = { ASSETS: { fetch: async (request) => { paths.push(new URL(request.url).pathname); return new Response('recovery file'); } } };
    for (const path of ['/api/recover', '/api/recovery.js']) {
        const response = await app.fetch(new Request('https://app.test' + path), env);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'recovery file');
    }
    assert.deepEqual(paths, ['/recovery', '/recovery.js']);
});
