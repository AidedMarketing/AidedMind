import test from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import app from '../src/app.js';
import { StoreCore } from '../src/store-core.js';
import { processInbox, MAX_ATTEMPTS, RETRY_DELAYS_MS, RATE_LIMIT_MAX_ATTEMPTS } from '../src/inbox-processor.js';
import { fakeEnv, anthropicStub, call, sqlAdapter, sqlStore } from './helpers.js';
import { urlHash } from '../../web/js/library.js';

const ANALYSIS = {
    title: 'Habit loops', topic: 'Habits', tldr: 'Small cues drive routines.', summary: [{ heading: 'h', body: 'b' }], outline: [],
    concepts: [{ name: 'Cue', description: 'd' }], tags: ['habits'], quotes: ['q'], takeaways: ['t'], connections: [{ noteId: 'ghost', relation: 'related', reason: 'r' }], sourceText: ''
};
const reply = (model = 'claude-sonnet-5') => ({ json: { id: 'm', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: JSON.stringify(ANALYSIS) }], stop_reason: 'end_turn', usage: { input_tokens: 500, output_tokens: 100 } } });

const words = (n) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i} explains one idea about habits in a full sentence that is long enough to count as prose.</p>`).join('');
const page = (inner, head = '') => `<html><head><title>Story</title><meta property="og:title" content="Habit loops">${head}</head><body><nav><a>Home</a></nav><article>${inner}</article></body></html>`;

function mockFetch(t, routes) {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    const calls = [];
    globalThis.fetch = async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith('http://127.0.0.1')) return real(input, init); // the Claude stub
        calls.push(url);
        const handler = routes[url];
        return handler ? handler() : new Response('nope', { status: 404 });
    };
    return calls;
}
const html = (body, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'text/html' } });

async function setup(t, { model } = {}) {
    const stub = await anthropicStub(() => (typeof model === 'function' ? model() : reply()));
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    return { stub, env, core: sqlStore() };
}
const only = (core) => core.inboxList()[0];
const month = () => new Date().toISOString().slice(0, 7);

test('a shared article is broken down in the background and waits for the app', async (t) => {
    const { stub, env, core } = await setup(t);
    mockFetch(t, { 'https://example.com/habits': html(page(words(30))) });
    core.metaSet('prefs', { depth: 'balanced', topics: ['Habits', 'Sleep'], concepts: ['Cue'] });
    core.inboxAdd({ url: 'https://example.com/habits' }, { limit: null });

    assert.strictEqual(await processInbox(core, env), 1);
    const item = only(core);
    assert.strictEqual(item.status, 'done');
    assert.strictEqual(item.text, '');
    const { source, analysis, model, depth } = item.result;
    assert.strictEqual(source.sourceType, 'article');
    assert.strictEqual(source.title, 'Habit loops');
    assert.match(source.text, /Paragraph 0 explains one idea/);
    assert.ok(!source.text.includes('Home'));
    assert.strictEqual(source.partial, false);
    assert.strictEqual(analysis.topic, 'Habits');
    assert.deepStrictEqual(analysis.connections, []); // no library on the server
    assert.strictEqual(model, 'claude-sonnet-5');
    assert.strictEqual(depth, 'balanced');

    const sent = stub.requests[0].body;
    const known = sent.messages[0].content[0].text;
    assert.match(known, /<known_topics>\n\["Habits","Sleep"\]/);
    assert.match(known, /<known_concepts>\n\["Cue"\]/);
    assert.deepStrictEqual(core.usageFor(month()), { captures: 1, inputTokens: 500, outputTokens: 100 });
    assert.ok(core.costsFor(month()).some((row) => row.item === 'claude:claude-sonnet-5:input' && row.amount === 500));
});

test('a paywalled article becomes a short partial note, marked as paywalled', async (t) => {
    const { stub, env, core } = await setup(t);
    mockFetch(t, { 'https://news.example/story': html(page(words(6), '<script type="application/ld+json">{"isAccessibleForFree": false}</script>')) });
    core.inboxAdd({ url: 'https://news.example/story' });
    await processInbox(core, env);
    const { source } = only(core).result;
    assert.strictEqual(source.partial, true);
    assert.strictEqual(source.transcriptSource, 'paywall');
    assert.strictEqual(stub.requests[0].body.model, 'claude-haiku-4-5'); // partial → Quick
    const prompt = JSON.stringify(stub.requests[0].body.messages);
    assert.match(prompt, /behind a paywall/);
});

test('a paid Substack app share remains partial even when its public preview is long', async (t) => {
    const { env, core } = await setup(t);
    const publicPost = { title: 'Paid story', audience: 'only_paid', body_html: words(80), canonical_url: 'https://writer.substack.com/p/paid-story' };
    const calls = mockFetch(t, {
        'https://writer.substack.com/api/v1/posts/paid-story': () => new Response(JSON.stringify(publicPost), { headers: { 'content-type': 'application/json' } })
    });
    core.inboxAdd({ url: 'https://open.substack.com/pub/writer/p/paid-story' });
    await processInbox(core, env);
    assert.strictEqual(only(core).status, 'done');
    assert.strictEqual(only(core).result.source.partial, true);
    assert.strictEqual(only(core).result.source.transcriptSource, 'paywall');
    assert.deepStrictEqual(calls, ['https://writer.substack.com/api/v1/posts/paid-story']);
});

test('page text sent with the link (from your own Safari) is used as is, no fetching', async (t) => {
    const { env, core } = await setup(t);
    const calls = mockFetch(t, {});
    core.inboxAdd({ url: 'https://news.example/story', title: 'The full story', text: 'A long logged-in article. '.repeat(300) });
    await processInbox(core, env);
    assert.deepStrictEqual(calls, []);
    const { source } = only(core).result;
    assert.strictEqual(source.sourceType, 'article');
    assert.strictEqual(source.title, 'The full story');
    assert.strictEqual(source.partial, false);
    assert.match(source.text, /logged-in article/);
});

test('Claude outage keeps the share queued without using quota, then recovers', async (t) => {
    let down = true;
    const { env, core } = await setup(t, { model: () => down
        ? { status: 500, json: { type: 'error', error: { type: 'api_error', message: 'boom' } } }
        : reply() });
    mockFetch(t, { 'https://example.com/a': html(page(words(30))) });
    core.inboxAdd({ url: 'https://example.com/a' }, { limit: 5 });

    let now = Date.now();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        assert.strictEqual(await processInbox(core, env, { now: () => now }), 1, `attempt ${attempt}`);
        const item = only(core);
        assert.strictEqual(item.attempts, attempt);
        assert.strictEqual(core.usageFor(month()).captures, 0, 'quota is given back');
        assert.strictEqual(item.status, 'pending');
        assert.match(item.error, /Claude is having trouble/);
        assert.strictEqual(await processInbox(core, env, { now: () => now }), 0, 'not due yet');
        now += 60 * 1000 * 2 ** (attempt - 1) + 1000;
    }
    down = false;
    assert.strictEqual(await processInbox(core, env, { now: () => now }), 1);
    assert.strictEqual(only(core).status, 'done');
    assert.strictEqual(core.usageFor(month()).captures, 1);
});

test('site rate limits expose the next retry, then keep the same link available for manual recovery', async (t) => {
    const { env, core } = await setup(t);
    let blocked = true;
    mockFetch(t, { 'https://news.example/a': () => blocked
        ? new Response('slow down', { status: 429 })
        : new Response(page(words(30)), { headers: { 'content-type': 'text/html' } }) });
    const saved = core.inboxAdd({ url: 'https://news.example/a' }, { limit: 5 });
    let now = Date.now();
    for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
        assert.strictEqual(await processInbox(core, env, { now: () => now }), 1);
        const item = only(core);
        assert.strictEqual(item.id, saved.id);
        assert.strictEqual(item.attempts, attempt);
        assert.strictEqual(core.usageFor(month()).captures, 0);
        if (attempt === RATE_LIMIT_MAX_ATTEMPTS) {
            assert.deepStrictEqual([item.status, item.errorKind, item.nextRetryAt], ['failed', 'retry_in_app', null]);
        } else {
            assert.strictEqual(item.status, 'pending');
            const delay = Math.min(60 * 60 * 1000, 2 * 60 * 1000 * 2 ** (attempt - 1));
            assert.strictEqual(new Date(item.nextRetryAt).getTime(), now + delay);
            assert.strictEqual(await processInbox(core, env, { now: () => now }), 0);
            now += delay + 1000;
        }
    }
    blocked = false;
    assert.strictEqual(core.inboxUpdate(saved.id, {}), true);
    assert.strictEqual(await processInbox(core, env, { now: () => now }), 1);
    assert.strictEqual(only(core).status, 'done');
});

test('failures that will not get better fail at once, with a reason', async (t) => {
    const { stub, env, core } = await setup(t);
    mockFetch(t, { 'https://blocked.example/a': html('Forbidden', 403), 'https://spa.example/a': html('<html><body><div id="app"></div></body></html>') });
    core.inboxAdd({ url: 'https://blocked.example/a' });
    core.inboxAdd({ url: 'https://spa.example/a' });
    core.inboxAdd({ url: 'not a link' });
    await processInbox(core, env);
    const [blocked, spa, invalid] = core.inboxList();
    assert.deepStrictEqual([blocked.status, blocked.errorKind], ['failed', 'needs_text']);
    assert.match(blocked.error, /blocked\.example wouldn't let AidedMind read this page/);
    assert.doesNotMatch(blocked.error, /\d{3}/);
    assert.deepStrictEqual([spa.status, spa.errorKind], ['failed', 'needs_text']);
    assert.deepStrictEqual([invalid.status, invalid.errorKind], ['failed', 'permanent']);
    assert.strictEqual(stub.requests.length, 0);
    assert.strictEqual(core.usageFor(month()).captures, 0);
});

test('unreadable share keeps its id and accepts text for a later breakdown', async (t) => {
    const { env, core } = await setup(t);
    mockFetch(t, { 'https://news.example/paid': html('<html><body><div id="app"></div></body></html>') });
    const item = core.inboxAdd({ url: 'https://news.example/paid' });
    await processInbox(core, env);
    assert.deepStrictEqual([only(core).id, only(core).errorKind], [item.id, 'needs_text']);
    assert.strictEqual(core.inboxUpdate(item.id, { text: 'The subscriber article. '.repeat(30) }), true);
    await processInbox(core, env);
    assert.strictEqual(only(core).id, item.id);
    assert.strictEqual(only(core).status, 'done');
    assert.match(only(core).result.source.text, /subscriber article/);
});

test('plan limits apply to background breakdowns', async (t) => {
    const { stub, env, core } = await setup(t);
    mockFetch(t, { 'https://example.com/a': html(page(words(30))), 'https://example.com/b': html(page(words(30))) });
    core.inboxAdd({ url: 'https://example.com/a' }, { limit: 1 });
    core.inboxAdd({ url: 'https://example.com/b' }, { limit: 1 });
    await processInbox(core, env);
    const [a, b] = core.inboxList();
    assert.strictEqual(a.status, 'done');
    assert.deepStrictEqual([b.status, b.errorKind], ['failed', 'permanent']);
    assert.match(b.error, /used all 1 breakdowns/);
    assert.strictEqual(stub.requests.length, 1);
});

test('an item being processed is not taken twice, until its lease runs out', async () => {
    const core = sqlStore();
    core.inboxAdd({ url: 'https://example.com/a' });
    const now = Date.now();
    assert.ok(core.inboxClaim(now, 60000));
    assert.strictEqual(core.inboxClaim(now + 1000, 60000), null);
    const again = core.inboxClaim(now + 61000, 60000);
    assert.strictEqual(again.attempts, 2);
    assert.ok(core.inboxNextDue() > now);
});

test('older inbox tables gain the new columns, and their items are left to the app', () => {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE TABLE inbox (id TEXT PRIMARY KEY, url TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', received_at TEXT NOT NULL)");
    db.prepare("INSERT INTO inbox (id, url, received_at) VALUES ('old', 'https://example.com/old', ?)").run(new Date().toISOString());
    const core = new StoreCore(sqlAdapter(db));
    const [item] = core.inboxList();
    assert.deepStrictEqual([item.id, item.status, item.queued], ['old', 'pending', false]);
    assert.strictEqual(core.inboxClaim(Date.now() + 1e6, 1000), null);
});

test('inbox routes queue links with the plan limit, accept raw page text, and list results', async (t) => {
    const stub = await anthropicStub(() => reply());
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const other = await (await call(app, env, 'POST', '/api/admin/users', { token: 'owner-secret', body: { plan: 'free' } })).json();

    const queued = await call(app, env, 'POST', '/api/inbox', { token: other.token, body: { url: 'https://example.com/a' } });
    assert.strictEqual(queued.status, 201);
    assert.match((await queued.json()).message, /Saved to AidedMind/);
    const raw = await app.fetch(new Request('https://x/api/inbox', { method: 'POST', headers: { 'X-AidedMind-Token': other.token, 'Content-Type': 'text/plain' }, body: 'Just the page text, no JSON at all.' }), env);
    assert.strictEqual(raw.status, 201);
    const json = await app.fetch(new Request('https://x/api/inbox', { method: 'POST', headers: { 'X-AidedMind-Token': other.token, 'Content-Type': 'application/json' }, body: JSON.stringify(JSON.stringify({ url: 'https://example.com/p', title: 'T', text: 'Page text' })) }), env);
    assert.strictEqual(json.status, 201);
    const { items } = await (await call(app, env, 'GET', '/api/inbox', { token: other.token })).json();
    assert.strictEqual(items.length, 3);
    assert.ok(items.every((i) => i.queued && i.status === 'pending'));
    assert.strictEqual(items[1].text, 'Just the page text, no JSON at all.');
    assert.deepStrictEqual([items[2].url, items[2].title, items[2].text], ['https://example.com/p', 'T', 'Page text']); // unwrapped
    const store = env.STORE.get(`user:${other.id}`);
    assert.strictEqual(store.rows('SELECT quota_limit AS q FROM inbox LIMIT 1')[0].q, 2); // FREE_MONTHLY_CAPTURES in fakeEnv
    const owner = await call(app, env, 'POST', '/api/inbox', { token: 'owner-secret', body: { url: 'https://example.com/o' } });
    assert.strictEqual(owner.status, 201);
    assert.strictEqual(env.STORE.get('user:owner').rows('SELECT quota_limit AS q FROM inbox')[0].q, -1); // unlimited
});

test('inbox update is authenticated and resumes the same failed item', async () => {
    const env = fakeEnv();
    const owner = env.STORE.get('user:owner');
    const item = owner.inboxAdd({ url: 'https://news.example/paid' });
    owner.inboxFail(item.id, { error: 'Needs article text', kind: 'needs_text' });
    const denied = await call(app, env, 'PATCH', `/api/inbox/${item.id}`, { body: { text: 'Private article text.' } });
    assert.strictEqual(denied.status, 401);
    const result = await call(app, env, 'PATCH', `/api/inbox/${item.id}`, { token: 'owner-secret', body: { text: 'Private article text.' } });
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual([owner.inboxList()[0].id, owner.inboxList()[0].status, owner.inboxList()[0].text],
        [item.id, 'pending', 'Private article text.']);
});

test('preferences are validated and stored for background breakdowns', async (t) => {
    const env = fakeEnv();
    const res = await call(app, env, 'PUT', '/api/preferences', { token: 'owner-secret', body: { depth: 'thorough', topics: ['Sleep', 'sleep', ' Habits ', 5], concepts: ['A'] } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(env.STORE.get('user:owner').metaGet('prefs'), { depth: 'thorough', topics: ['Sleep', 'Habits', '5'], concepts: ['A'], urls: [] });
    await call(app, env, 'PUT', '/api/preferences', { token: 'owner-secret', body: { urls: ['0123456789abcdef', '0123456789abcdef', 'not-a-hash', 42] } });
    assert.deepStrictEqual(env.STORE.get('user:owner').metaGet('prefs').urls, ['0123456789abcdef']);
    await call(app, env, 'PUT', '/api/preferences', { token: 'owner-secret', body: { depth: 'ultra' } });
    assert.strictEqual(env.STORE.get('user:owner').metaGet('prefs').depth, undefined);
});

test('connections are suggested from the library, and only to known notes', async (t) => {
    const stub = await anthropicStub(() => ({ json: { ...reply('claude-haiku-4-5').json, content: [{ type: 'text', text: JSON.stringify({ connections: [
        { noteId: 'n1', relation: 'supports', reason: 'Same subject.' }, { noteId: 'n1', relation: 'related', reason: 'dup' }, { noteId: 'ghost', relation: 'related', reason: 'x' }, { noteId: 'n2', relation: 'weird', reason: 'y' }
    ] }) }] } }));
    t.after(() => stub.close());
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url });
    const res = await call(app, env, 'POST', '/api/connections', {
        token: 'owner-secret',
        body: { note: { title: 'New', topic: 'Habits', tldr: 't', concepts: ['Cue'], tags: ['habits'] }, library: [{ id: 'n1', title: 'A', topic: 'Habits' }, { id: 'n2', title: 'B' }] }
    });
    const data = await res.json();
    assert.deepStrictEqual(data.connections, [{ noteId: 'n1', relation: 'supports', reason: 'Same subject.' }, { noteId: 'n2', relation: 'related', reason: 'y' }]);
    assert.strictEqual(stub.requests[0].body.model, 'claude-haiku-4-5');
    const empty = await call(app, env, 'POST', '/api/connections', { token: 'owner-secret', body: { note: { title: 'New' }, library: [] } });
    assert.deepStrictEqual((await empty.json()).connections, []);
    assert.strictEqual(stub.requests.length, 1); // nothing to compare with: no call
});

test('a link already in the library is skipped without fetching or spending anything', async (t) => {
    const { stub, env, core } = await setup(t);
    const calls = mockFetch(t, {});
    // The app syncs fingerprints of finished notes' links (tracking parameters and www don't matter).
    core.metaSet('prefs', { urls: [await urlHash('https://example.com/habits')] });
    core.inboxAdd({ url: 'https://www.example.com/habits/?utm_source=x' }, { limit: 1 });
    // Page text you captured yourself is always processed, even for a saved link.
    core.inboxAdd({ url: 'https://example.com/habits', text: 'A long logged-in article. '.repeat(300) }, { limit: 1 });
    await processInbox(core, env);
    const [skipped, captured] = core.inboxList();
    assert.deepStrictEqual([skipped.status, skipped.result], ['done', { duplicate: true }]);
    assert.strictEqual(captured.status, 'done');
    assert.strictEqual(captured.result.source.title, '');
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(stub.requests.length, 1);
    assert.strictEqual(core.usageFor(month()).captures, 1);
});
