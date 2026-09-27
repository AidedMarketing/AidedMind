const test = require('node:test');
const assert = require('node:assert');
const { classifyUrl, youtubeId, decodeEntities, extract } = require('../lib/extract');
const { isPrivateAddress, assertPublicUrl } = require('../lib/safe-fetch');

test('classifies source URLs', () => {
    assert.strictEqual(classifyUrl('https://www.youtube.com/watch?v=abc123def45'), 'youtube');
    assert.strictEqual(classifyUrl('https://youtu.be/abc123def45'), 'youtube');
    assert.strictEqual(classifyUrl('https://m.youtube.com/shorts/abc123def45'), 'youtube');
    assert.strictEqual(classifyUrl('https://www.tiktok.com/@user/video/123'), 'tiktok');
    assert.strictEqual(classifyUrl('https://vm.tiktok.com/ZMabc/'), 'tiktok');
    assert.strictEqual(classifyUrl('https://example.com/post'), 'article');
    assert.strictEqual(classifyUrl('not a url'), 'invalid');
});

test('extracts YouTube video ids', () => {
    assert.strictEqual(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'dQw4w9WgXcQ');
    assert.strictEqual(youtubeId('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ');
    assert.strictEqual(youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.strictEqual(youtubeId('https://www.youtube.com/feed/library'), null);
});

test('decodes caption entities', () => {
    assert.strictEqual(decodeEntities('it&#39;s &amp;quot;fine&amp;quot; &lt;3'), 'it\'s &quot;fine&quot; <3');
});

test('blocks private and loopback addresses', async () => {
    ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']
        .forEach((ip) => assert.ok(isPrivateAddress(ip), ip));
    ['8.8.8.8', '1.1.1.1', '2606:4700::1111'].forEach((ip) => assert.ok(!isPrivateAddress(ip), ip));
    await assert.rejects(assertPublicUrl('http://127.0.0.1:8787/'), /private/);
    await assert.rejects(assertPublicUrl('http://[::1]/'), /private/);
    await assert.rejects(assertPublicUrl('file:///etc/passwd'), /http and https/);
});

test('pasted text skips fetching', async () => {
    const source = await extract({ text: '  some notes  ', title: 'Mine' });
    assert.deepStrictEqual(source, { sourceType: 'text', url: '', title: 'Mine', author: '', text: 'some notes' });
});

test('article parsing keeps the body and drops page chrome', () => {
    const { parseArticleHtml } = require('../lib/extract');
    const paragraph = 'Spaced repetition schedules reviews at growing intervals so memories consolidate before they fade. ';
    const html = `<!doctype html><html><head><title>Spacing | Blog</title>
        <meta property="og:site_name" content="Blog"><meta name="author" content="Ada"></head>
        <body><nav>Home About Subscribe</nav><article><h1>Why spacing works</h1>
        <p>${paragraph.repeat(4)}</p><p>${paragraph.repeat(3)}</p></article>
        <footer>Copyright cookie banner</footer></body></html>`;
    const result = parseArticleHtml(html, 'https://blog.example/spacing');
    assert.strictEqual(result.sourceType, 'article');
    assert.match(result.text, /growing intervals/);
    assert.doesNotMatch(result.text, /cookie banner/);
    assert.strictEqual(result.siteName, 'Blog');
    assert.throws(() => parseArticleHtml('<html><body><p>tiny</p></body></html>', 'u'), /readable text/);
});
