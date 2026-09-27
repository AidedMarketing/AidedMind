// Turns raw article HTML (fetched by the server) into clean text on the
// device, using Mozilla Readability loaded from vendor/Readability.js.
const BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, figcaption, td, dt, dd';

function blockText(root) {
    const blocks = [...root.querySelectorAll(BLOCKS)]
        .filter((el) => !el.parentElement.closest(BLOCKS))
        .map((el) => {
            const text = el.textContent.replace(/\s+/g, ' ').trim();
            if (!text) return '';
            if (/^H[1-6]$/.test(el.tagName)) return `\n${text}`;
            if (el.tagName === 'LI') return `- ${text}`;
            return text;
        })
        .filter(Boolean);
    return blocks.length ? blocks.join('\n\n') : root.textContent.replace(/\s+/g, ' ').trim();
}

export function readableFromHtml(html, url) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const meta = (selector) => doc.querySelector(selector)?.getAttribute('content') || '';
    const fallbackTitle = meta('meta[property="og:title"]') || doc.title || url;
    const siteName = meta('meta[property="og:site_name"]');
    const thumbnail = meta('meta[property="og:image"]');
    const metaAuthor = meta('meta[name="author"]');

    const Readability = window.Readability;
    const article = Readability ? new Readability(doc).parse() : null;
    let text = '';
    if (article?.content) {
        text = blockText(new DOMParser().parseFromString(article.content, 'text/html').body);
    }
    if (!text) text = blockText(doc.body || doc.documentElement);
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 200) {
        const error = new Error('Couldn\'t find readable text on that page (it may need a login). Paste the text instead.');
        error.status = 422;
        throw error;
    }
    return {
        title: article?.title || fallbackTitle,
        author: article?.byline || metaAuthor || '',
        siteName: article?.siteName || siteName,
        thumbnail,
        text
    };
}
