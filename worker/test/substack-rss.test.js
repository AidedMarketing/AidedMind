import test from 'node:test';
import assert from 'node:assert/strict';
import { substackPostAddress, parseSubstackFeed, sourceFromSubstackFeed } from '../src/substack-rss.js';
import { fetchSource } from '../src/extract.js';
import { extractArticle } from '../src/article.js';
import { processInbox } from '../src/inbox-processor.js';
import { fakeEnv, anthropicStub, sqlStore } from './helpers.js';

const html = '<p>The public article explains project context, instructions and boundaries in detail.</p>'.repeat(30);
const item = (slug, body = html, { excerpt = false } = {}) => `<item><title>${slug} &amp; context</title><link>https://writer.substack.com/p/${slug}</link><dc:creator>Writer &amp; Editor</dc:creator><${excerpt ? 'description' : 'content:encoded'}><![CDATA[${body}]]></${excerpt ? 'description' : 'content:encoded'}></item>`;
const feed = (...items) => `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Writer</title>${items.join('')}</channel></rss>`;
const rss = (body) => new Response(body, { headers: { 'content-type': 'application/rss+xml' } });
const enabled = { env: { AIDEDMIND_SUBSTACK_RSS: '1' } };

function mock(t, handler) {
    const real = globalThis.fetch;
    const calls = [];
    t.after(() => { globalThis.fetch = real; });
    globalThis.fetch = async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith('http://127.0.0.1')) return real(input, init);
        calls.push(url);
        return handler(url, init);
    };
    return calls;
}

test('feed addresses are restricted to exact known public Substack post routes', () => {
    assert.deepEqual(substackPostAddress('https://open.substack.com/pub/writer/p/story?r=app'), {
        pageUrl: 'https://writer.substack.com/p/story', feedUrl: 'https://writer.substack.com/feed'
    });
    for (const url of ['https://writer.substack.com/p/story/comments', 'https://writer.substack.com.evil.test/p/story',
        'https://localhost/p/story', 'https://custom.example/p/story', 'https://reader:secret@writer.substack.com/p/story'])
        assert.equal(substackPostAddress(url), null);
});

test('RSS parsing preserves article HTML and selects the exact post, never the newest unrelated item', () => {
    const posts = parseSubstackFeed(feed(item('newest'), item('target', html + '<p>A quoted &lt;item&gt; is article text.</p>')));
    const source = sourceFromSubstackFeed(posts, 'https://open.substack.com/pub/writer/p/target?r=app');
    assert.equal(source.url, 'https://writer.substack.com/p/target');
    assert.equal(source.partial, false);
    assert.equal(source.retrieval, 'substack_rss');
    const article = extractArticle(source.html);
    assert.equal(article.title, 'target & context');
    assert.equal(article.author, 'Writer & Editor');
    assert.match(article.text, /A quoted <item> is article text/);
    assert.equal(sourceFromSubstackFeed(posts, 'https://writer.substack.com/p/missing'), null);
    assert.equal(sourceFromSubstackFeed(parseSubstackFeed(feed(item('target'), item('target'))), 'https://writer.substack.com/p/target'), null);
});

test('invalid XML, declarations, oversized feeds and HTML error pages never become article data', () => {
    for (const body of ['<html><body>Site Unavailable</body></html>', '<rss><channel><item></rss>',
        '<!DOCTYPE rss SYSTEM "https://example.com/external.dtd">' + feed(item('story')),
        feed(item('story')).replace('story &amp; context', 'story &unknown; context'), ' '.repeat(3 * 1024 * 1024 + 1)])
        assert.equal(parseSubstackFeed(body), null);
    const source = sourceFromSubstackFeed(parseSubstackFeed(feed(item('story', html, { excerpt: true }))), 'https://writer.substack.com/p/story');
    assert.equal(source.partial, true);
    assert.equal(source.transcriptSource, 'feed_excerpt');
});

test('enabled retrieval shares a five-minute feed cache across posts and refreshes it after expiry', async (t) => {
    let now = 1000000;
    const cache = new Map();
    const deps = { ...enabled, now: () => now, cacheGet: async (key) => cache.get(key), cachePut: async (key, value) => cache.set(key, value) };
    const calls = mock(t, () => rss(feed(item('first'), item('second'))));
    assert.equal((await fetchSource('https://open.substack.com/pub/writer/p/first?r=app', deps)).retrieval, 'substack_rss');
    assert.equal((await fetchSource('https://writer.substack.com/p/second?utm_medium=ios', deps)).url, 'https://writer.substack.com/p/second');
    assert.deepEqual(calls, ['https://writer.substack.com/feed']);
    now += 300000;
    await fetchSource('https://writer.substack.com/p/first', deps);
    assert.equal(calls.length, 2);
});

test('feed throttling honors Retry-After and ends the attempt without hitting page or API', async (t) => {
    const calls = mock(t, () => new Response('Wait', { status: 429, headers: { 'retry-after': '600' } }));
    await assert.rejects(fetchSource('https://writer.substack.com/p/story', enabled), (error) =>
        error.upstreamStatus === 429 && error.retryAfterMs === 600000);
    assert.deepEqual(calls, ['https://writer.substack.com/feed']);
});

test('large real-world feeds cache separate posts within the SQLite row limit', async (t) => {
    const cache = new Map();
    const largeFeed = feed(...Array.from({ length: 20 }, (_, i) => item(`story-${i}`, html.repeat(12))));
    assert.ok(Buffer.byteLength(largeFeed) > 350000);
    const calls = mock(t, () => rss(largeFeed));
    const deps = { ...enabled, cacheGet: async (key) => cache.get(key), cachePut: async (key, entry) => {
        assert.ok(Buffer.byteLength(JSON.stringify(entry)) <= 350000);
        cache.set(key, entry);
    } };
    await fetchSource('https://open.substack.com/pub/writer/p/story-0', deps);
    await fetchSource('https://writer.substack.com/p/story-19', deps);
    assert.deepEqual(calls, ['https://writer.substack.com/feed']);
    assert.equal(cache.size, 21);
});

test('an older post missing from RSS uses the existing public post route', async (t) => {
    const calls = mock(t, (url) => url.endsWith('/feed') ? rss(feed(item('newest')))
        : new Response(JSON.stringify({ title: 'Older', body_html: html }), { headers: { 'content-type': 'application/json' } }));
    const result = await fetchSource('https://open.substack.com/pub/writer/p/older', enabled);
    assert.match(result.html, /Older/);
    assert.deepEqual(calls, ['https://writer.substack.com/feed', 'https://writer.substack.com/api/v1/posts/older']);
});

test('default retrieval remains unchanged and optional cache failures do not lose article text', async (t) => {
    const calls = mock(t, (url) => url.endsWith('/feed') ? rss(feed(item('story')))
        : new Response(JSON.stringify({ title: 'Story', body_html: html }), { headers: { 'content-type': 'application/json' } }));
    await fetchSource('https://open.substack.com/pub/writer/p/story');
    assert.deepEqual(calls, ['https://writer.substack.com/api/v1/posts/story']);
    const source = await fetchSource('https://writer.substack.com/p/story', { ...enabled, cachePut: async () => { throw new Error('Storage full'); } });
    assert.equal(source.retrieval, 'substack_rss');
});

test('a queued app share becomes a note from feed content, with preview status preserved', async (t) => {
    const stub = await anthropicStub(() => ({ json: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: JSON.stringify({ title: 'Story', topic: 'AI', tldr: 'Context helps.', summary: [], outline: [], concepts: [], tags: [], quotes: [], takeaways: [], connections: [] }) }],
        stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 100 } } }));
    t.after(() => stub.close());
    const core = sqlStore();
    const env = fakeEnv({ ANTHROPIC_BASE_URL: stub.url, AIDEDMIND_SUBSTACK_RSS: '1' });
    const preview = html + '<p>Subscribe to continue reading</p>';
    const calls = mock(t, () => rss(feed(item('full'), item('preview', preview), item('description', html, { excerpt: true }))));
    for (const slug of ['full', 'preview', 'description']) core.inboxAdd({ url: `https://open.substack.com/pub/writer/p/${slug}` });
    await processInbox(core, env);
    const notes = core.inboxList();
    assert.deepEqual(notes.map((row) => row.status), ['done', 'done', 'done']);
    assert.deepEqual(notes.map((row) => row.result.source.partial), [false, true, true]);
    assert.deepEqual(notes.map((row) => row.result.source.transcriptSource), ['', 'paywall', 'feed_excerpt']);
    assert.ok(notes.every((row) => row.result.source.retrieval === 'substack_rss'));
    assert.deepEqual(calls, ['https://writer.substack.com/feed']);
    assert.ok(notes[0].result.source.text.includes('instructions and boundaries'));
});
