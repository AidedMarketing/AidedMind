// Substack's documented public syndication feed. This reads only content the
// publisher includes in RSS; it does not supply subscriber credentials.
import { SaxesParser } from 'saxes';

const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
const MAX_FEED_BYTES = 3 * 1024 * 1024;
const MAX_ITEMS = 100;

export function substackPostAddress(raw) {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.username || url.password) return null;
        const app = url.hostname === 'open.substack.com' && url.pathname.match(/^\/pub\/([\w-]+)\/p\/([\w-]+)\/?$/);
        if (app) return substackPostAddress(`https://${app[1]}.substack.com/p/${app[2]}`);
        if (!/^[\w-]+\.substack\.com$/.test(url.hostname) || !/^\/p\/[\w-]+\/?$/.test(url.pathname)) return null;
        return { pageUrl: `${url.origin}${url.pathname.replace(/\/$/, '')}`, feedUrl: `${url.origin}/feed` };
    } catch { return null; }
}

export function parseSubstackFeed(xml) {
    if (typeof xml !== 'string' || new TextEncoder().encode(xml).length > MAX_FEED_BYTES) return null;
    // No DTDs, entity declarations, external resources, or recovery from malformed XML.
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
    const posts = [];
    const stack = [];
    let item = null;
    let field = '';
    let rss = false;
    let channel = false;
    const parser = new SaxesParser({ xmlns: true });
    parser.on('opentag', (tag) => {
        stack.push(tag);
        if (stack.length === 1) {
            if (tag.local !== 'rss' || tag.uri) throw new Error('Not RSS');
            rss = true;
        }
        if (stack.length === 2 && tag.local === 'channel' && !tag.uri) channel = true;
        if (stack.length === 3 && stack[1].local === 'channel' && tag.local === 'item' && !tag.uri) {
            if (posts.length >= MAX_ITEMS) throw new Error('Too many feed items');
            item = { title: '', link: '', author: '', html: '', description: '' };
        }
        if (item && stack.length === 4) {
            field = !tag.uri && ['title', 'link', 'description'].includes(tag.local) ? tag.local
                : tag.uri === CONTENT_NS && tag.local === 'encoded' ? 'html'
                : tag.uri === DC_NS && tag.local === 'creator' ? 'author' : '';
        }
    });
    const content = (text) => { if (item && field && stack.length === 4) item[field] += text; };
    parser.on('text', content);
    parser.on('cdata', content);
    parser.on('closetag', () => {
        if (stack.length === 4) field = '';
        if (stack.length === 3 && item) { posts.push(item); item = null; }
        stack.pop();
    });
    try {
        parser.write(xml).close();
        return rss && channel ? posts : null;
    } catch { return null; }
}

const escape = (text) => String(text || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function sourceFromSubstackFeed(posts, rawUrl) {
    const target = substackPostAddress(rawUrl);
    if (!target || !Array.isArray(posts)) return null;
    const matches = posts.filter((post) => post && typeof post.link === 'string' && substackPostAddress(post.link)?.pageUrl === target.pageUrl);
    // Ambiguous feeds are never allowed to attach the wrong article to a share.
    if (matches.length !== 1) return null;
    const post = matches[0];
    const full = typeof post.html === 'string' ? post.html.trim() : '';
    const description = typeof post.description === 'string' ? post.description.trim() : '';
    const html = full || description;
    if (!html || html.length < 200) return null;
    const excerpt = !full;
    return {
        sourceType: 'article', url: target.pageUrl,
        html: `<!doctype html><html><head><title>${escape(post.title)}</title><meta name="author" content="${escape(post.author)}"></head><body><article><h1>${escape(post.title)}</h1>${html}</article></body></html>`,
        retrieval: 'substack_rss', partial: excerpt,
        transcriptSource: excerpt ? 'feed_excerpt' : ''
    };
}
