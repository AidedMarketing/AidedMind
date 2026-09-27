// URL → source material. Articles come back as raw HTML (the app runs
// Readability on the phone, keeping Worker CPU low); YouTube and TikTok are
// resolved to text here.
import { YoutubeTranscript } from 'youtube-transcript';
import { HttpError } from './http.js';

const TIMEOUT_MS = 15000;
const MAX_BYTES = 3 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; AidedMindBot/0.2; personal knowledge app)';

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
        throw new HttpError(502, `Could not reach ${url.hostname}: ${error.message}`);
    }
    if (!response.ok) throw new HttpError(502, `${url.hostname} responded with ${response.status}.`);
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

async function extractYouTube(rawUrl) {
    const id = youtubeId(rawUrl);
    if (!id) throw new HttpError(400, 'Could not find a video ID in that YouTube link.');
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    const meta = await oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonical)}`);
    let transcript = '';
    try {
        const segments = await YoutubeTranscript.fetchTranscript(id);
        transcript = segments.map((segment) => decodeEntities(segment.text)).join(' ').replace(/\s+/g, ' ').trim();
    } catch (error) {
        console.warn(`no transcript for ${id}: ${error.message}`);
    }
    if (!transcript) {
        throw new HttpError(422, 'This video has no captions AidedMind can read. Paste the transcript or your notes as text instead.');
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
    const page = await fetchPage(rawUrl).catch(() => null);
    const canonical = page?.url || rawUrl;
    const meta = await oembed(`https://www.tiktok.com/oembed?url=${encodeURIComponent(canonical)}`);
    const parts = [];
    if (meta?.title) parts.push(`Caption: ${meta.title}`);
    const description = page?.body?.match(/<meta[^>]+(?:name|property)="(?:og:)?description"[^>]+content="([^"]*)"/i);
    if (description && description[1] && !parts.join(' ').includes(decodeEntities(description[1]))) {
        parts.push(`Description: ${decodeEntities(description[1])}`);
    }
    if (!parts.length) {
        throw new HttpError(422, 'TikTok did not return any caption for this video. Paste what it says as text instead.');
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
    const page = await fetchPage(rawUrl);
    const type = page.contentType.toLowerCase();
    if (type.includes('application/pdf')) throw new HttpError(415, 'PDF links are not supported yet. Paste the text instead.');
    if (type.startsWith('text/plain')) {
        return { sourceType: 'article', url: page.url, title: page.url, author: '', text: page.body.trim() };
    }
    if (type && !/html|xml/.test(type)) throw new HttpError(415, `AidedMind cannot read ${type} content.`);
    return { sourceType: 'article', url: page.url, html: page.body };
}

export async function fetchSource(url) {
    if (typeof url !== 'string' || !url.trim()) throw new HttpError(400, 'Send a link.');
    const trimmed = url.trim();
    switch (classifyUrl(trimmed)) {
        case 'youtube': return extractYouTube(trimmed);
        case 'tiktok': return extractTikTok(trimmed);
        case 'article': return extractArticle(trimmed);
        default: throw new HttpError(400, 'That does not look like a valid link.');
    }
}
