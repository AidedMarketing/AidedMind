import test from 'node:test';
import assert from 'node:assert';
import { extractArticle } from '../src/article.js';
import { looksPaywalled, countWords } from '../../web/js/paywall.js';

const para = (n) => `<p>Sentence number ${n} of the article talks about a specific idea in enough words to count as real prose, with a comma, a clause and a point.</p>`;
const body = (count) => Array.from({ length: count }, (_, i) => para(i + 1)).join('\n');

const PAGE = `<!doctype html><html><head>
<title>Fallback title | The Site</title>
<meta property="og:title" content="How habits &amp; routines work">
<meta property="og:site_name" content="The Site">
<meta property="og:image" content="https://example.com/cover.jpg">
<meta name="author" content="Ada Lovelace">
<script>var junk = "<p>not text</p>";</script><style>p { color: red }</style>
</head><body>
<nav><ul><li>Home</li><li>Subscribe</li></ul></nav>
<header><p>Site banner text that is long enough to look like a paragraph but is not the story.</p></header>
<article>
  <h1>How habits work</h1>
  ${body(12)}
  <h2>Why it matters</h2>
  <blockquote>A quoted line that <em>matters</em> to the argument being made here.</blockquote>
  <ul><li>First point</li><li>Second point</li></ul>
  <aside><p>Related: ten other stories you might like, in a sidebar that is not the article.</p></aside>
</article>
<article><p>Other story teaser</p></article>
<footer><p>Copyright notice and other footer boilerplate that should never be in the note.</p></footer>
</body></html>`;

test('extracts the article container, its structure and its metadata', () => {
    const page = extractArticle(PAGE, 'https://example.com/a');
    assert.strictEqual(page.title, 'How habits & routines work');
    assert.strictEqual(page.author, 'Ada Lovelace');
    assert.strictEqual(page.siteName, 'The Site');
    assert.strictEqual(page.thumbnail, 'https://example.com/cover.jpg');
    assert.match(page.text, /^\nHow habits work|^How habits work/);
    assert.match(page.text, /Sentence number 1 of the article/);
    assert.match(page.text, /Sentence number 12 of the article/);
    assert.match(page.text, /\nWhy it matters\n/);
    assert.match(page.text, /A quoted line that matters to the argument/);
    assert.match(page.text, /- First point\n\n- Second point/);
    for (const junk of ['not text', 'color: red', 'Site banner', 'Related: ten', 'Copyright notice', 'Other story teaser']) {
        assert.ok(!page.text.includes(junk), junk);
    }
});

test('falls back to long paragraphs when there is no article container', () => {
    const html = `<html><head><title>Plain page</title></head><body>
        <div><p>Menu</p><p>Login</p></div>
        <div>${body(10)}</div></body></html>`;
    const page = extractArticle(html, 'https://example.com/plain');
    assert.strictEqual(page.title, 'Plain page');
    assert.ok(!/\bMenu\b|\bLogin\b/.test(page.text));
    assert.ok(countWords(page.text) > 150);
});

test('pages without readable text are rejected with a helpful message', () => {
    assert.throws(() => extractArticle('<html><body><div id="app"></div><script>render()</script></body></html>', 'https://spa.example'), (error) => error.status === 422 && /login|Paste/.test(error.message));
});

test('paywall detection needs both a signal and a short read', () => {
    const marked = '<script type="application/ld+json">{"isAccessibleForFree": false}</script>';
    const short = 'word '.repeat(300);
    const long = 'word '.repeat(2000);
    assert.strictEqual(looksPaywalled(marked, short), true);
    assert.strictEqual(looksPaywalled(marked, long), false); // full text came through
    assert.strictEqual(looksPaywalled('<html></html>', short), false); // short but nothing says paywall
    assert.strictEqual(looksPaywalled('', `${short} Subscribe to continue reading.`), true);
    assert.strictEqual(looksPaywalled('', `${short} This post is for paid subscribers`), true);
    assert.strictEqual(looksPaywalled('', `${long} Subscribe to continue reading.`), false);
    assert.strictEqual(looksPaywalled('<div class="site-paywall__gate">', short), true);
    assert.strictEqual(looksPaywalled('<meta property="article:content_tier" content="locked">', short), true);
});
