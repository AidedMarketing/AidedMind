// URL → source material. Articles come back as raw HTML (the app runs
// Readability on the phone, keeping Worker CPU low); YouTube and TikTok are
// resolved to text here.
import { YoutubeTranscript } from 'youtube-transcript';
import { HttpError } from './http.js';
import { geminiTranscript, supadataTranscript, youtubeDetails } from './transcripts.js';

const TIMEOUT_MS = 15000;
const MAX_BYTES = 3 * 1024 * 1024;
// A regular browser identity: many sites (Substack, news) refuse unknown bots.
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export function isPrivateAddress(address) {
    const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 10 || a === 127 || a === 0 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) ||
            a >= 224;
    }
    const lower = address.toLowerCase();
    if (!lower.includes(':')) return false;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return lower === '::1' || lower === '::' ||
        lower.startsWith('fc') || lower.startsWith('fd') ||
        lower.startsWith('fe80') || lower.startsWith('ff');
}

export function assertPublicUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new HttpError(400, 'That does not look like a valid link.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new HttpError(400, 'Only http and https links are supported.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || isPrivateAddress(host)) {
        throw new HttpError(400, 'Links to private or local network addresses are blocked.');
    }
    return url;
}

async function readLimited(response) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
            await reader.cancel();
            throw new HttpError(413, 'That page is larger than 3 MB.');
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
    return new TextDecoder().decode(bytes);
}

// What went wrong reading a page, in words a person can act on. The technical
// detail (status code, error text) goes to the log, never to the screen.
export function describeUpstreamFailure(hostname, status) {
    const site = String(hostname || 'That site').replace(/^www\./, '');
    if (status === 429) return `${site} is limiting how often AidedMind can read it right now (too many requests).`;
    if (status === 401 || status === 403) return `${site} wouldn't let AidedMind read this page. It may need a login, or it blocks automated readers. Paste the text instead if you can see it.`;
    if (status === 404 || status === 410) return `${site} says this page doesn't exist any more. Check the link.`;
    if (status === 451) return `${site} can't show this page to AidedMind for legal reasons.`;
    if (status >= 500) return `${site} is having problems right now.`;
    return `${site} wouldn't let AidedMind read this page.`;
}

function retryAfterMs(value) {
    if (!value) return 0;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 24 * 60 * 60 * 1000) : 0;
}

export async function fetchPage(rawUrl, accept = 'text/html,application/xhtml+xml,*/*;q=0.8') {
    const url = assertPublicUrl(rawUrl);
    let response;
    try {
        response = await fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'en;q=0.9,*;q=0.5' }
        });
    } catch (error) {
        console.warn(`fetch ${url.hostname} failed: ${error.message}`);
        const slow = error.name === 'TimeoutError' || error.name === 'AbortError';
        const site = url.hostname.replace(/^www\./, '');
        throw new HttpError(502, slow
            ? `${site} took too long to respond.`
            : `Couldn't connect to ${site}. The site may be down, or the link may be wrong.`);
    }
    if (!response.ok) {
        console.warn(`fetch ${url.hostname} responded ${response.status}`);
        const error = new HttpError(502, describeUpstreamFailure(url.hostname, response.status));
        error.upstreamStatus = response.status;
        if (response.status === 429) error.retryAfterMs = retryAfterMs(response.headers.get('retry-after'));
        throw error;
    }
    const finalUrl = response.url || url.toString();
    assertPublicUrl(finalUrl);
    return { url: finalUrl, contentType: response.headers.get('content-type') || '', body: await readLimited(response) };
}

export function classifyUrl(rawUrl) {
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

export function youtubeId(rawUrl) {
    const url = new URL(rawUrl);
    if (url.hostname.endsWith('youtu.be')) return url.pathname.slice(1).split('/')[0] || null;
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
    return match ? match[1] : null;
}

export function decodeEntities(text) {
    return text
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function oembed(endpoint) {
    try {
        const { body } = await fetchPage(endpoint, 'application/json');
        return JSON.parse(body);
    } catch {
        return null;
    }
}

// deps: { env, cacheGet(key), cachePut(key, source), record(item, amount) }.
// All optional so tests and plain calls work without storage.
const NO_DEPS = { env: {}, cacheGet: async () => null, cachePut: async () => {}, record: async () => {} };

function withDeps(deps) {
    return { ...NO_DEPS, ...deps, env: deps?.env || {} };
}

async function extractYouTube(rawUrl, deps) {
    const { env, cacheGet, cachePut, record } = withDeps(deps);
    const id = youtubeId(rawUrl);
    if (!id) throw new HttpError(400, 'Could not find a video ID in that YouTube link.');
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    const cacheKey = `youtube:${id}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const meta = await oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonical)}`);
    const base = {
        sourceType: 'youtube',
        url: canonical,
        title: meta?.title || 'YouTube video',
        author: meta?.author_name || '',
        thumbnail: meta?.thumbnail_url || ''
    };
    const keep = async (source) => {
        await cachePut(cacheKey, source);
        return source;
    };

    // 1. The video's own captions (free).
    try {
        const segments = await YoutubeTranscript.fetchTranscript(id);
        const transcript = segments.map((segment) => decodeEntities(segment.text)).join(' ').replace(/\s+/g, ' ').trim();
        if (transcript) return keep({ ...base, text: transcript, transcriptSource: 'captions' });
    } catch (error) {
        console.warn(`no captions for ${id}: ${error.message}`);
    }

    // 2. Gemini watches the video (works without captions).
    const gemini = await geminiTranscript(canonical, env);
    if (gemini) {
        await record('gemini:videos', 1);
        await record('gemini:input', gemini.usage.input);
        await record('gemini:output', gemini.usage.output);
        return keep({ ...base, text: gemini.text, transcriptSource: 'gemini', partial: gemini.truncated });
    }

    // 3. Supadata, existing captions only (cheapest mode).
    const supadata = await supadataTranscript(canonical, env, { mode: 'native' });
    if (supadata) {
        await record('supadata:requests', 1);
        return keep({ ...base, text: supadata.text, transcriptSource: 'supadata' });
    }

    // 4. Title, description and chapters: a partial breakdown beats nothing.
    const details = await youtubeDetails(canonical);
    if (details?.description && details.description.trim().length > 40) {
        const minutes = details.lengthSeconds ? `Length: ${Math.round(details.lengthSeconds / 60)} minutes\n` : '';
        return {
            ...base,
            title: base.title === 'YouTube video' && details.title ? details.title : base.title,
            author: base.author || details.author,
            text: `${minutes}Video description:\n${details.description.trim()}`,
            transcriptSource: 'description',
            partial: true
        };
    }
    throw new HttpError(422, env.GEMINI_API_KEY
        ? 'Couldn\'t get a transcript or description for this video (it may be private or age-restricted). Paste the transcript as text instead.'
        : 'This video has no captions AidedMind can read. Add a Gemini key to transcribe videos without captions, or paste the transcript as text.');
}

async function extractTikTok(rawUrl, deps) {
    const { env, cacheGet, cachePut, record } = withDeps(deps);
    const page = await fetchPage(rawUrl).catch(() => null);
    const canonical = page?.url || rawUrl;
    const cacheKey = `tiktok:${canonical.split('?')[0]}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;
    const meta = await oembed(`https://www.tiktok.com/oembed?url=${encodeURIComponent(canonical)}`);
    const caption = meta?.title || '';
    // TikTok sometimes blocks the server's page fetch, leaving a short link;
    // oEmbed still names the video, so rebuild its full address.
    const videoUrl = tiktokVideoUrl(canonical, meta);

    // Supadata transcribes what is said (AI speech-to-text when needed).
    let transcriptError = '';
    const supadata = await supadataTranscript(videoUrl, env, { mode: 'auto', report: (reason) => { transcriptError = reason; } });
    if (supadata) {
        await record('supadata:requests', 1);
        const source = {
            sourceType: 'tiktok',
            url: videoUrl,
            title: caption ? caption.slice(0, 120) : 'TikTok video',
            author: meta?.author_name || '',
            thumbnail: meta?.thumbnail_url || '',
            text: [caption ? `Caption: ${caption}` : null, `Transcript:\n${supadata.text}`].filter(Boolean).join('\n\n'),
            transcriptSource: 'supadata'
        };
        await cachePut(cacheKey, source);
        return source;
    }

    const parts = [];
    if (caption) parts.push(`Caption: ${caption}`);
    const description = page?.body?.match(/<meta[^>]+(?:name|property)="(?:og:)?description"[^>]+content="([^"]*)"/i);
    if (description && description[1] && !parts.join(' ').includes(decodeEntities(description[1]))) {
        parts.push(`Description: ${decodeEntities(description[1])}`);
    }
    if (!parts.length) {
        throw new HttpError(422, 'TikTok did not return any caption for this video. Paste what it says as text instead.');
    }
    return {
        sourceType: 'tiktok',
        url: videoUrl,
        title: caption ? caption.slice(0, 120) : 'TikTok video',
        author: meta?.author_name || '',
        thumbnail: meta?.thumbnail_url || '',
        text: parts.join('\n\n'),
        transcriptSource: 'caption',
        transcriptError: transcriptError || (env.SUPADATA_API_KEY ? '' : 'Add a Supadata key to transcribe what TikToks say.'),
        partial: true
    };
}

export function tiktokVideoUrl(url, meta) {
    if (/tiktok\.com\/@[^/]+\/video\/\d+/.test(url)) return url.split('?')[0];
    const id = meta?.embed_product_id;
    const author = meta?.author_unique_id || String(meta?.author_url || '').match(/@([^/?]+)/)?.[1];
    if (id && /^\d+$/.test(String(id)) && author) return `https://www.tiktok.com/@${author}/video/${id}`;
    return url;
}

function escapeHtml(text) {
    return String(text || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Substack posts (substack.com or custom domains) live at /p/<slug>. When the
// page itself is blocked, the same post is usually available from Substack's
// public post API.
export function substackApiUrl(rawUrl) {
    const url = new URL(rawUrl);
    const shared = substackShared(url);
    if (shared) return `https://${shared.publication}.substack.com/api/v1/posts/${shared.slug}`;
    const match = url.pathname.match(/^\/p\/([\w-]+)/);
    return match ? `${url.origin}/api/v1/posts/${match[1]}` : null;
}

// The Share button gives open.substack.com/pub/<newsletter>/p/<post>, which
// Substack throttles hard. The post itself lives on the newsletter's own
// address, so go there directly.
function substackShared(url) {
    if (url.hostname !== 'open.substack.com') return null;
    const match = url.pathname.match(/^\/pub\/([\w-]+)\/p\/([\w-]+)/);
    return match ? { publication: match[1], slug: match[2] } : null;
}

export function substackPageUrl(rawUrl) {
    const shared = substackShared(new URL(rawUrl));
    return shared ? `https://${shared.publication}.substack.com/p/${shared.slug}` : null;
}

async function substackFallback(rawUrl) {
    const api = substackApiUrl(rawUrl);
    if (!api) return null;
    try {
        const { body } = await fetchPage(api, 'application/json');
        const post = JSON.parse(body);
        if (!post?.body_html) return null;
        // The public post API can return a paid preview. Preserve that signal
        // in the synthetic page so the shared paywall detector can label it.
        const restricted = post.audience === 'only_paid' || post.free_unlock_required === true;
        const html = `<!doctype html><html><head><title>${escapeHtml(post.title)}</title>` +
            `<meta name="author" content="${escapeHtml(post.publishedBylines?.[0]?.name || '')}">` +
            `${restricted ? '<meta name="article:content_tier" content="premium">' : ''}</head><body><article>` +
            `<h1>${escapeHtml(post.title)}</h1>${post.subtitle ? `<h2>${escapeHtml(post.subtitle)}</h2>` : ''}${post.body_html}</article></body></html>`;
        return { sourceType: 'article', url: post.canonical_url || rawUrl, html, restricted };
    } catch (error) {
        return { error };
    }
}

async function extractArticle(rawUrl, { attempt = 1 } = {}) {
    const own = substackPageUrl(rawUrl);
    if (own) {
        // On the first app share, try both public routes. Subsequent 429
        // retries use one route at a time, alternating API and page, so four
        // attempts do not turn into eight requests to the same publication.
        const apiOnly = attempt > 1 && attempt % 2 === 0;
        const pageOnly = attempt > 1 && attempt % 2 === 1;
        const post = pageOnly ? null : await substackFallback(own);
        if (post && !post.error) return post;
        if (apiOnly && post?.error?.upstreamStatus === 429) throw post.error;
        rawUrl = own; // read the page on the newsletter's own address instead
        try {
            const page = await fetchPage(rawUrl);
            return articleFromPage(page);
        } catch (error) {
            if (post?.error?.upstreamStatus === 429 && error.upstreamStatus !== 429) throw post.error;
            if (post?.error?.retryAfterMs && error.upstreamStatus === 429) {
                error.retryAfterMs = Math.max(error.retryAfterMs || 0, post.error.retryAfterMs);
            }
            throw error;
        }
    }
    // The app can also share a publication URL directly. After its first
    // attempt, use the same one-route retry policy as open.substack.com links.
    if (attempt > 1 && /(?:^|\.)substack\.com$/i.test(new URL(rawUrl).hostname) && substackApiUrl(rawUrl)) {
        if (attempt % 2 === 0) {
            const post = await substackFallback(rawUrl);
            if (post && !post.error) return post;
            if (post?.error?.upstreamStatus === 429) throw post.error;
            // A missing API or empty post can still have a readable page.
            // Try it once, without falling into the generic API fallback below.
            return articleFromPage(await fetchPage(rawUrl));
        } else {
            return articleFromPage(await fetchPage(rawUrl));
        }
    }
    let page;
    try {
        page = await fetchPage(rawUrl);
    } catch (error) {
        // An app share already tried this post API above. Repeating it within
        // the same attempt only adds traffic while the publisher is throttling.
        if (error.upstreamStatus && !own) {
            const fallback = await substackFallback(rawUrl);
            if (fallback && !fallback.error) return fallback;
            if (fallback?.error?.upstreamStatus === 429 && error.upstreamStatus !== 429) throw fallback.error;
            if (fallback?.error?.retryAfterMs && error.upstreamStatus === 429) {
                error.retryAfterMs = Math.max(error.retryAfterMs || 0, fallback.error.retryAfterMs);
            }
        }
        throw error;
    }
    return articleFromPage(page);
}

function articleFromPage(page) {
    const type = page.contentType.toLowerCase();
    if (type.includes('application/pdf')) throw new HttpError(415, 'PDF links are not supported yet. Paste the text instead.');
    if (type.startsWith('text/plain')) {
        return { sourceType: 'article', url: page.url, title: page.url, author: '', text: page.body.trim() };
    }
    if (type && !/html|xml/.test(type)) throw new HttpError(415, 'That link isn\'t a web page or an article AidedMind can read. Paste the text instead.');
    return { sourceType: 'article', url: page.url, html: page.body };
}

export async function fetchSource(url, deps) {
    if (typeof url !== 'string' || !url.trim()) throw new HttpError(400, 'Send a link.');
    const trimmed = url.trim();
    switch (classifyUrl(trimmed)) {
        case 'youtube': return extractYouTube(trimmed, deps);
        case 'tiktok': return extractTikTok(trimmed, deps);
        case 'article': return extractArticle(trimmed, deps);
        default: throw new HttpError(400, 'That does not look like a valid link.');
    }
}
