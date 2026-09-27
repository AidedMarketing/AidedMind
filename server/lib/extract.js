// Turns a URL (or pasted text) into { sourceType, url, title, author, text }.
const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');
const { YoutubeTranscript } = require('youtube-transcript');
const { safeFetch, FetchError } = require('./safe-fetch');

function classifyUrl(rawUrl) {
    let host;
    try {
        host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\.|^m\./, '');
    } catch {
        return 'invalid';
    }
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') return 'youtube';
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
    return 'article';
}

function youtubeId(rawUrl) {
    const url = new URL(rawUrl);
    if (url.hostname.endsWith('youtu.be')) return url.pathname.slice(1).split('/')[0] || null;
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
    return match ? match[1] : null;
}

function decodeEntities(text) {
    return text
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function oembed(endpoint) {
    try {
        const { body } = await safeFetch(endpoint, { accept: 'application/json' });
        return JSON.parse(body);
    } catch {
        return null;
    }
}

async function extractYouTube(rawUrl) {
    const id = youtubeId(rawUrl);
    if (!id) throw new FetchError('Could not find a video ID in that YouTube link.', 400);
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    const meta = await oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonical)}`);
    let transcript = '';
    try {
        const segments = await YoutubeTranscript.fetchTranscript(id);
        transcript = segments.map((segment) => decodeEntities(segment.text)).join(' ').replace(/\s+/g, ' ').trim();
    } catch (error) {
        transcript = '';
        console.warn(`[extract] no transcript for ${id}: ${error.message}`);
    }
    if (!transcript) {
        throw new FetchError(
            'This video has no captions AidedMind can read. Paste the transcript or your notes as text instead.',
            422
        );
    }
    return {
        sourceType: 'youtube',
        url: canonical,
        title: meta?.title || 'YouTube video',
        author: meta?.author_name || '',
        thumbnail: meta?.thumbnail_url || '',
        text: transcript
    };
}

async function extractTikTok(rawUrl) {
    // Short links (vm.tiktok.com) redirect to the canonical video URL.
    const page = await safeFetch(rawUrl).catch(() => null);
    const canonical = page?.url || rawUrl;
    const meta = await oembed(`https://www.tiktok.com/oembed?url=${encodeURIComponent(canonical)}`);
    const parts = [];
    if (meta?.title) parts.push(`Caption: ${meta.title}`);
    if (page?.body) {
        const description = page.body.match(/<meta[^>]+(?:name|property)="(?:og:)?description"[^>]+content="([^"]*)"/i);
        if (description && description[1] && !parts.join(' ').includes(decodeEntities(description[1]))) {
            parts.push(`Description: ${decodeEntities(description[1])}`);
        }
    }
    if (!parts.length) {
        throw new FetchError('TikTok did not return any caption for this video. Paste what it says as text instead.', 422);
    }
    return {
        sourceType: 'tiktok',
        url: canonical,
        title: meta?.title ? meta.title.slice(0, 120) : 'TikTok video',
        author: meta?.author_name || '',
        thumbnail: meta?.thumbnail_url || '',
        text: parts.join('\n\n'),
        partial: true
    };
}

async function extractArticle(rawUrl) {
    const page = await safeFetch(rawUrl);
    if (page.contentType.includes('application/pdf')) {
        throw new FetchError('PDF links are not supported yet. Paste the text instead.', 415);
    }
    if (!/html|xml|text\/plain/.test(page.contentType) && page.contentType) {
        throw new FetchError(`AidedMind cannot read ${page.contentType} content.`, 415);
    }
    if (page.contentType.startsWith('text/plain')) {
        return { sourceType: 'article', url: page.url, title: page.url, author: '', text: page.body.trim() };
    }
    return parseArticleHtml(page.body, page.url);
}

function parseArticleHtml(html, url) {
    const { document } = parseHTML(html);
    const metaContent = (selector) => document.querySelector(selector)?.getAttribute('content') || '';
    const ogTitle = metaContent('meta[property="og:title"]');
    const siteName = metaContent('meta[property="og:site_name"]');
    const thumbnail = metaContent('meta[property="og:image"]');
    const metaAuthor = metaContent('meta[name="author"]');
    const article = new Readability(document).parse();
    const text = (article?.textContent || document.body?.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 200) {
        throw new FetchError('Could not find readable text on that page (it may need a login or JavaScript). Paste the text instead.', 422);
    }
    return {
        sourceType: 'article',
        url,
        title: article?.title || ogTitle || url,
        author: article?.byline || metaAuthor || '',
        siteName: article?.siteName || siteName,
        thumbnail,
        text
    };
}

async function extract({ url, text, title }) {
    if (text && text.trim()) {
        return {
            sourceType: 'text',
            url: url || '',
            title: title || '',
            author: '',
            text: text.trim()
        };
    }
    if (!url) throw new FetchError('Send a URL or some text.', 400);
    switch (classifyUrl(url)) {
        case 'youtube': return extractYouTube(url);
        case 'tiktok': return extractTikTok(url);
        case 'article': return extractArticle(url);
        default: throw new FetchError('That does not look like a valid URL.', 400);
    }
}

module.exports = { extract, parseArticleHtml, classifyUrl, youtubeId, decodeEntities };
