import test from 'node:test';
import assert from 'node:assert';
import { classifyUrl, youtubeId, decodeEntities, isPrivateAddress, assertPublicUrl, substackApiUrl, substackPageUrl, fetchSource } from '../src/extract.js';
import { normalize, compactLibrary, analyze, ANALYSIS_SCHEMA, autoDepth, countWords } from '../src/analyze.js';
import { sqlStore } from './helpers.js';

test('classifies source URLs', () => {
    assert.strictEqual(classifyUrl('https://www.youtube.com/watch?v=abc123def45'), 'youtube');
    assert.strictEqual(classifyUrl('https://youtu.be/abc123def45'), 'youtube');
    assert.strictEqual(classifyUrl('https://m.youtube.com/shorts/abc123def45'), 'youtube');
    assert.strictEqual(classifyUrl('https://vm.tiktok.com/ZMabc/'), 'tiktok');
    assert.strictEqual(classifyUrl('https://example.com/post'), 'article');
    assert.strictEqual(classifyUrl('not a url'), 'invalid');
});

test('extracts YouTube ids and decodes captions', () => {
    assert.strictEqual(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'dQw4w9WgXcQ');
    assert.strictEqual(youtubeId('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ');
    assert.strictEqual(youtubeId('https://www.youtube.com/feed/library'), null);
    assert.strictEqual(decodeEntities('it&#39;s &lt;3 &amp; more'), 'it\'s <3 & more');
});

test('private address detection', () => {
    ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']
        .forEach((ip) => assert.ok(isPrivateAddress(ip), ip));
    ['8.8.8.8', '2606:4700::1111', 'example.com'].forEach((ip) => assert.ok(!isPrivateAddress(ip), ip));
    assert.throws(() => assertPublicUrl('http://printer.local/'), /private/);
    assert.ok(assertPublicUrl('https://example.com/a'));
});

test('normalize drops unknown connections and dedupes concepts', () => {
    const result = normalize({
        title: ' T ', tldr: 'x',
        summary: [{ heading: 'a', body: 'b' }, { heading: 'e', body: '' }],
        outline: [{ level: 7, text: 'deep' }],
        concepts: [{ name: 'Spaced repetition', description: 'd' }, { name: 'spaced repetition', description: 'dup' }],
        tags: ['#Memory', 'Learning Science', 'memory'], quotes: ['q'], takeaways: [],
        connections: [{ noteId: 'n1', relation: 'supports', reason: 'r' }, { noteId: 'ghost', relation: 'related', reason: 'r' }]
    }, new Set(['n1']));
    assert.strictEqual(result.summary.length, 1);
    assert.deepStrictEqual(result.outline, [{ level: 3, text: 'deep' }]);
    assert.strictEqual(result.concepts.length, 1);
    assert.deepStrictEqual(result.tags, ['memory', 'learning-science']);
    assert.deepStrictEqual(result.connections.map((c) => c.noteId), ['n1']);
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
    await assert.rejects(analyze({ text: 'x'.repeat(700000) }, [], {}), (error) => error.status === 413);
});

test('store: quota reservation and inbox expiry', () => {
    const store = sqlStore();
    assert.deepStrictEqual(store.reserveCapture('2026-09', 1), { ok: true, captures: 1 });
    assert.deepStrictEqual(store.reserveCapture('2026-09', 1), { ok: false, captures: 1 });
    store.releaseCapture('2026-09');
    assert.strictEqual(store.usageFor('2026-09').captures, 0);
    assert.strictEqual(store.reserveCapture('2026-09', null).ok, true);

    store.inboxAdd({ url: 'https://example.com/new' });
    store.sql.exec('INSERT INTO inbox (id, url, received_at) VALUES (?, ?, ?)', 'old', 'https://example.com/old', '2020-01-01T00:00:00.000Z');
    assert.deepStrictEqual(store.inboxList().map((i) => i.url), ['https://example.com/new']);
    assert.strictEqual(store.inboxAdd({ url: '', text: '  ' }), null);
});

test('substack posts map to the post API', () => {
    assert.strictEqual(substackApiUrl('https://writer.substack.com/p/my-post?utm_source=share'), 'https://writer.substack.com/api/v1/posts/my-post');
    assert.strictEqual(substackApiUrl('https://www.customdomain.com/p/another-one'), 'https://www.customdomain.com/api/v1/posts/another-one');
    assert.strictEqual(substackApiUrl('https://example.com/blog/post'), null);
});

test('blocked substack page falls back to the post API', async (t) => {
    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    const seen = [];
    globalThis.fetch = async (url) => {
        seen.push(String(url));
        if (String(url).includes('/api/v1/posts/')) {
            return new Response(JSON.stringify({ title: 'A <Post>', subtitle: 'Sub', body_html: '<p>Body text</p>', canonical_url: 'https://writer.substack.com/p/a-post', publishedBylines: [{ name: 'Writer' }] }),
                { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('blocked', { status: 403 });
    };
    const source = await fetchSource('https://writer.substack.com/p/a-post');
    assert.deepStrictEqual(seen, ['https://writer.substack.com/p/a-post', 'https://writer.substack.com/api/v1/posts/a-post']);
    assert.strictEqual(source.url, 'https://writer.substack.com/p/a-post');
    assert.match(source.html, /<h1>A &lt;Post&gt;<\/h1><h2>Sub<\/h2><p>Body text<\/p>/);
    assert.match(source.html, /content="Writer"/);

    globalThis.fetch = async () => new Response('blocked', { status: 403 });
    await assert.rejects(fetchSource('https://example.com/not-substack'), (error) => {
        assert.match(error.message, /example\.com wouldn't let AidedMind read this page/);
        assert.doesNotMatch(error.message, /403/);
        return true;
    });
});

test('substack share links go to the newsletter\'s own address', () => {
    assert.strictEqual(substackApiUrl('https://open.substack.com/pub/writer/p/my-post?r=abc&utm_campaign=post'), 'https://writer.substack.com/api/v1/posts/my-post');
    assert.strictEqual(substackPageUrl('https://open.substack.com/pub/writer/p/my-post?r=abc'), 'https://writer.substack.com/p/my-post');
    assert.strictEqual(substackPageUrl('https://writer.substack.com/p/my-post'), null);
    assert.strictEqual(substackPageUrl('https://open.substack.com/pub/writer'), null);
});

test('a throttled substack share link is read from the newsletter\'s own address', async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    const seen = [];
    globalThis.fetch = async (input) => {
        const url = String(input);
        seen.push(url);
        if (url.startsWith('https://open.substack.com')) return new Response('slow down', { status: 429 });
        if (url === 'https://writer.substack.com/api/v1/posts/my-post') {
            return new Response(JSON.stringify({ title: 'My post', audience: 'only_paid', body_html: '<p>Hello world.</p>', canonical_url: 'https://writer.substack.com/p/my-post' }), { headers: { 'content-type': 'application/json' } });
        }
        return new Response('nope', { status: 404 });
    };
    const source = await fetchSource('https://open.substack.com/pub/writer/p/my-post?r=abc');
    assert.strictEqual(source.url, 'https://writer.substack.com/p/my-post');
    assert.strictEqual(source.restricted, true);
    assert.match(source.html, /article:content_tier" content="premium/);
    assert.match(source.html, /Hello world/);
    assert.ok(!seen.some((u) => u.startsWith('https://open.substack.com')), 'the throttled address is never touched');
});

test('an app share can use the public page when its post API is throttled', async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    const seen = [];
    globalThis.fetch = async (input) => {
        seen.push(String(input));
        return String(input).includes('/api/v1/posts/')
            ? new Response('slow down', { status: 429 })
            : new Response('<html><article><h1>Story</h1><p>Public article text.</p></article></html>', { headers: { 'content-type': 'text/html' } });
    };
    const source = await fetchSource('https://open.substack.com/pub/writer/p/story');
    assert.match(source.html, /Public article text/);
    assert.deepStrictEqual(seen, ['https://writer.substack.com/api/v1/posts/story', 'https://writer.substack.com/p/story']);
});

test('a throttled post API remains retryable if the page also cannot be read', async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    globalThis.fetch = async (input) => String(input).includes('/api/v1/posts/')
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '180' } })
        : new Response('not found', { status: 404 });
    await assert.rejects(fetchSource('https://open.substack.com/pub/writer/p/story'), (error) => {
        assert.strictEqual(error.upstreamStatus, 429);
        assert.strictEqual(error.retryAfterMs, 180000);
        return true;
    });
});

test('direct publication links also make only one request per rate-limit retry', async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    const seen = [];
    globalThis.fetch = async (input) => {
        seen.push(String(input));
        return new Response('slow down', { status: 429 });
    };
    const url = 'https://writer.substack.com/p/story';
    for (const attempt of [1, 2, 3]) {
        await assert.rejects(fetchSource(url, { attempt }), (error) => error.upstreamStatus === 429);
    }
    assert.deepStrictEqual(seen, [url, 'https://writer.substack.com/api/v1/posts/story',
        'https://writer.substack.com/api/v1/posts/story', url]);
});

test('a direct publication link preserves a throttled API when its page is missing', async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    globalThis.fetch = async (input) => String(input).includes('/api/v1/posts/')
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '600' } })
        : new Response('not found', { status: 404 });
    await assert.rejects(fetchSource('https://writer.substack.com/p/story'), (error) => {
        assert.strictEqual(error.upstreamStatus, 429);
        assert.strictEqual(error.retryAfterMs, 600000);
        return true;
    });
});

test('an API-only retry does not repeat a missing API or request another route', async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    const seen = [];
    globalThis.fetch = async (input) => {
        seen.push(String(input));
        return new Response('not found', { status: 404 });
    };
    for (const url of ['https://writer.substack.com/p/story', 'https://open.substack.com/pub/writer/p/story']) {
        await assert.rejects(fetchSource(url, { attempt: 2 }), (error) => error.upstreamStatus === 404);
    }
    assert.deepStrictEqual(seen, Array(2).fill('https://writer.substack.com/api/v1/posts/story'));
});

test('an API-only retry with no article body stops without extra fetches', async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    const seen = [];
    globalThis.fetch = async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ title: 'Story' }), { headers: { 'content-type': 'application/json' } });
    };
    for (const url of ['https://writer.substack.com/p/story', 'https://open.substack.com/pub/writer/p/story']) {
        await assert.rejects(fetchSource(url, { attempt: 2 }), (error) => error.status === 422);
    }
    assert.deepStrictEqual(seen, Array(2).fill('https://writer.substack.com/api/v1/posts/story'));
});

test('site problems are explained in plain words, with no status codes', async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    const say = async (respond) => {
        globalThis.fetch = async () => respond();
        try {
            await fetchSource('https://www.example.com/post');
        } catch (error) {
            return error.message;
        }
        return '';
    };
    assert.match(await say(() => new Response('', { status: 429 })), /example\.com is limiting how often AidedMind can read it right now/);
    assert.match(await say(() => new Response('', { status: 404 })), /doesn't exist any more/);
    assert.match(await say(() => new Response('', { status: 503 })), /having problems right now/);
    assert.match(await say(() => { throw new TypeError('fetch failed: ECONNRESET'); }), /Couldn't connect to example\.com/);
    assert.match(await say(() => { const e = new Error('The operation timed out'); e.name = 'TimeoutError'; throw e; }), /took too long to respond/);
    for (const status of [429, 404, 503, 401]) assert.doesNotMatch(await say(() => new Response('', { status })), /\d{3}/);
});

test('auto depth thresholds', () => {
    assert.strictEqual(countWords('  one two\nthree  '), 3);
    const words = (n) => 'w '.repeat(n);
    assert.strictEqual(autoDepth({ text: words(599) }), 'quick');
    assert.strictEqual(autoDepth({ text: words(600) }), 'balanced');
    assert.strictEqual(autoDepth({ text: words(11999) }), 'balanced');
    assert.strictEqual(autoDepth({ text: words(12000) }), 'thorough');
    assert.strictEqual(autoDepth({ text: words(5000), sourceType: 'tiktok' }), 'quick');
    assert.strictEqual(autoDepth({ text: words(5000), partial: true }), 'quick');
});

test('schema asks for sourceText, and normalize keeps it', () => {
    assert.ok(ANALYSIS_SCHEMA.required.includes('sourceText'));
    assert.strictEqual(normalize({ sourceText: '  read text  ' }, new Set()).sourceText, 'read text');
    assert.strictEqual(normalize({}, new Set()).sourceText, '');
});
