// Pulls the readable article out of a page's HTML on the server, for links
// that are processed in the background while the app is closed. (When you
// share from inside the app, the phone runs Mozilla Readability instead,
// which is a little more precise; this is the same job without a browser.)
//
// It scans the markup as text rather than building a page model, so it stays
// cheap: drop the parts that are never article text, find the article
// container, then take its paragraphs, headings, lists and quotes in order.
import { decodeEntities } from './extract.js';
import { HttpError } from './http.js';
import { countWords } from '../../web/js/paywall.js';

const MAX_HTML = 2.5 * 1024 * 1024;
const NEVER_ARTICLE = /<(script|style|noscript|svg|template|nav|aside|footer|form|iframe|button|select|dialog)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK = /<(h[1-6]|p|li|blockquote|pre|figcaption)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const MIN_ARTICLE_WORDS = 120;

function meta(head, key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const a = head.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i'));
    const b = head.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, 'i'));
    return decodeEntities((a || b || [])[1] || '').trim();
}

function plain(fragment) {
    return decodeEntities(fragment.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Paragraphs, headings and lists in reading order.
function blocks(markup, { strict }) {
    const out = [];
    let match;
    BLOCK.lastIndex = 0;
    while ((match = BLOCK.exec(markup))) {
        const tag = match[1].toLowerCase();
        const text = plain(match[2]);
        if (!text) continue;
        const heading = /^h[1-6]$/.test(tag);
        // Without a clear article container, only keep real sentences: menus,
        // captions and buttons are short.
        if (strict && !heading && text.length < 40) continue;
        out.push(heading ? `\n${text}` : tag === 'li' ? `- ${text}` : text);
    }
    return out;
}

function candidates(body) {
    const found = [];
    for (const pattern of [/<article\b[\s\S]*?<\/article\s*>/gi, /<main\b[\s\S]*?<\/main\s*>/gi]) {
        const items = [...body.matchAll(pattern)].map((m) => m[0]);
        // The article with the most text wins (pages list related stories in others).
        const best = items.map((markup) => ({ markup, words: countWords(plain(markup)) })).sort((a, b) => b.words - a.words)[0];
        if (best && best.words >= MIN_ARTICLE_WORDS) found.push({ markup: best.markup, strict: false });
    }
    found.push({ markup: body, strict: true });
    return found;
}

export function extractArticle(html, url = '') {
    const source = String(html || '').slice(0, MAX_HTML);
    const headEnd = source.search(/<\/head\s*>/i);
    const head = headEnd > 0 ? source.slice(0, headEnd) : source.slice(0, 20000);
    const titleTag = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const cleaned = source.slice(Math.max(headEnd, 0)).replace(/<!--[\s\S]*?-->/g, '').replace(NEVER_ARTICLE, ' ');

    let text = '';
    let chosen = cleaned;
    for (const { markup, strict } of candidates(cleaned)) {
        text = blocks(markup, { strict }).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
        chosen = markup;
        if (countWords(text) >= MIN_ARTICLE_WORDS) break;
    }
    if (text.length < 200) {
        throw new HttpError(422, 'Couldn\'t find readable text on that page (it may need a login). Paste the text instead.');
    }
    return {
        title: meta(head, 'og:title') || decodeEntities((titleTag || '').replace(/\s+/g, ' ').trim()) || url,
        author: meta(head, 'author') || meta(head, 'article:author'),
        siteName: meta(head, 'og:site_name'),
        thumbnail: meta(head, 'og:image'),
        imageCount: (chosen.match(/<img\b/gi) || []).length,
        text
    };
}
