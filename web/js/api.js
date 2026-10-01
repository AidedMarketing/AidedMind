// Talks to the AidedMind server. Settings live in localStorage.
import { relatedNotes, conceptVocabulary, knownTopics, findDuplicate } from './library.js';
import { looksPaywalled } from './paywall.js';

const SETTINGS_KEY = 'aidedmind.settings';
const USAGE_KEY = 'aidedmind.usage';

export function getSettings() {
    try {
        return { serverUrl: '', token: '', showConcepts: true, depth: 'auto', mapColor: 'theme', themeDetail: 'balanced', librarySort: 'newest', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
        return { serverUrl: '', token: '', showConcepts: true, depth: 'auto', mapColor: 'theme', themeDetail: 'balanced', librarySort: 'newest' };
    }
}

export function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// Static GitHub Pages hosts the reading shell, never the capture API.
export function connectionSetupIssue(settings = getSettings(), origin = location.origin) {
    if (!settings.token?.trim()) return 'Add your access token, then choose Save & Test.';
    let server;
    try { server = new URL(settings.serverUrl?.trim() || origin); }
    catch { return 'Enter the full AidedMind server URL, including https://.'; }
    if (!['http:', 'https:'].includes(server.protocol)) return 'Use an http:// or https:// server URL.';
    if (server.hostname.endsWith('.github.io')) return 'Enter your Cloudflare AidedMind server URL. GitHub Pages hosts the app but cannot receive captures.';
    return '';
}

function endpoint(path) {
    const base = getSettings().serverUrl.trim().replace(/\/+$/, '');
    return `${base}/api${path}`;
}

// A reply with no message of its own, said in words a person can act on.
export function plainServerError(status) {
    if (status === 401) return 'Your access token wasn\'t accepted. Check it in Settings.';
    if (status === 402) return 'You\'ve used this month\'s breakdowns. They reset on the 1st.';
    if (status === 413) return 'That\'s too large to send. Try something shorter.';
    if (status === 429) return 'The server is busy right now. Try again in a minute.';
    if (status >= 500) return 'The AidedMind server had a problem. Try again in a minute.';
    return 'The AidedMind server couldn\'t do that. Try again in a minute.';
}

async function request(method, path, body) {
    let response;
    try {
        response = await fetch(endpoint(path), {
            method,
            headers: { 'Content-Type': 'application/json', 'X-AidedMind-Token': getSettings().token },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch {
        throw new Error('Can\'t reach your AidedMind server. Check your connection or the server URL in Settings.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || plainServerError(response.status));
        error.status = response.status;
        error.code = data.code;
        throw error;
    }
    return data;
}

export function splitInput(raw) {
    const input = raw.trim();
    const urlMatch = input.match(/https?:\/\/[^\s<>"']+/i);
    // A lone link (or a share like "Check this out https://vm.tiktok.com/…")
    // is fetched; anything longer is treated as pasted content.
    if (urlMatch && input.replace(urlMatch[0], '').trim().length < 280) {
        return { url: urlMatch[0].replace(/[).,]+$/, ''), text: '' };
    }
    return { url: urlMatch ? urlMatch[0] : '', text: input };
}

function libraryIndex(notes) {
    return notes.map((note) => ({
        id: note.id,
        title: note.title,
        topic: note.topic || '',
        tldr: note.tldr,
        concepts: (note.concepts || []).map((c) => c.name),
        tags: note.tags || []
    }));
}

export class DuplicateError extends Error {
    constructor(note) {
        super('Already in your library.');
        this.note = note;
    }
}

// Step 1: turn a link or pasted text into source text (articles are fetched by
// the server and cleaned up here). Step 2: ask the server for the breakdown.
// The kind of source a link points to, from its address alone.
export function sourceTypeForUrl(url) {
    let host = '';
    try {
        host = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, '');
    } catch {
        return 'text';
    }
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') return 'youtube';
    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
    return 'article';
}

// retry: an existing note to fetch again and replace (e.g. caption-only).
// replace: an existing note to replace with the text given (e.g. a paywalled
// article whose full text you pasted).
export async function capture({ url, text, title, depth, photos, retry, replace, augment }, notes) {
    // Links already saved open the existing note: no fetch, no Claude call.
    // A partial note (caption only, paywalled) is redone instead, and
    // replaced in place.
    let replaces = retry || replace || augment || null;
    const saved = url && !photos?.length && !retry && !replace ? findDuplicate(notes, url) : null;
    if (saved && !saved.source?.partial && !text) throw new DuplicateError(saved);
    if (saved?.source?.partial) replaces = saved;
    let source;
    if (augment && photos?.length) {
        source = {
            ...augment.source, sourceType: 'article', title: title || augment.title,
            text: augment.sourceText || '',
            images: photos.map((photo) => ({ mediaType: photo.mediaType, data: photo.data }))
        };
    } else if (photos?.length) {
        source = {
            sourceType: 'photo',
            url: '',
            title: title || '',
            author: '',
            text: text || '',
            images: photos.map((photo) => ({ mediaType: photo.mediaType, data: photo.data }))
        };
    } else if (text) {
        source = { sourceType: url ? sourceTypeForUrl(url) : 'text', url: url || '', title: title || '', author: '', text };
    } else {
        const fetched = await request('POST', '/source', { url });
        if (fetched.html) {
            const { readableFromHtml } = await import('./readable.js');
            const article = readableFromHtml(fetched.html, fetched.url);
            // Only the free start of the article: say so instead of pretending.
            const paywalled = looksPaywalled(fetched.html, article.text);
            source = { sourceType: 'article', url: fetched.url, ...article, partial: paywalled, transcriptSource: paywalled ? 'paywall' : '' };
        } else {
            source = fetched;
        }
        // Short links (vm.tiktok.com, youtu.be) resolve to the saved address.
        const resolved = retry ? null : findDuplicate(notes, source.url);
        if (resolved && !resolved.source?.partial) throw new DuplicateError(resolved);
        if (resolved) replaces = resolved;
        source.sharedUrl = url;
    }
    // Only the notes likely to connect are sent, plus the library's common
    // concept names, so the cost per breakdown stays flat as the library grows.
    const others = replaces ? notes.filter((n) => n.id !== replaces.id) : notes;
    const related = relatedNotes(others, source);
    const body = { source, library: libraryIndex(related), depth: depth || getSettings().depth, topics: knownTopics(others) };
    if (related.length < others.length) body.concepts = conceptVocabulary(others);
    const result = await request('POST', '/analyze', body);
    setLastUsage(result.usage);
    if (source.images) {
        // Keep what Claude read from the photos, never the photos themselves.
        const { images, ...rest } = source;
        source = { ...rest, text: augment ? [source.text, result.analysis.sourceText].filter(Boolean).join('\n\n') : result.analysis.sourceText || source.text,
            imageCount: source.imageCount };
    }
    return { source, analysis: result.analysis, model: result.model, depth: result.depth, auto: result.auto, usage: result.usage, replaces: replaces?.id || null };
}

export function getLastUsage() {
    try {
        return JSON.parse(localStorage.getItem(USAGE_KEY) || 'null');
    } catch {
        return null;
    }
}

function setLastUsage(usage) {
    if (!usage) return;
    try {
        // Breakdown responses carry counts only; keep the last spend summary.
        const previous = getLastUsage();
        const merged = usage.spend || !previous?.spend || previous.month !== usage.month ? usage : { ...usage, spend: previous.spend };
        localStorage.setItem(USAGE_KEY, JSON.stringify(merged));
    } catch {
        // storage unavailable
    }
}

export async function checkAuth() {
    const result = await request('POST', '/auth-check', {});
    setLastUsage(result.usage);
    return result;
}

// Asks the server for the main topic of notes saved before topics existed.
export async function assignTopics(notes, topics) {
    const result = await request('POST', '/topics', {
        notes: notes.map((n) => ({ id: n.id, title: n.title, tldr: n.tldr, tags: n.tags || [] })),
        topics
    });
    setLastUsage(result.usage);
    return result.assignments || {};
}

// Tells the server the breakdown style and the topic and concept names in use,
// so links it breaks down while the app is closed match your library.
export async function putPreferences(prefs) {
    await request('PUT', '/preferences', prefs);
}

// Links from a note the server broke down in the background to your library.
export async function suggestConnections(analysis, source, notes) {
    if (!notes.length) return [];
    const related = relatedNotes(notes, { title: analysis.title, text: `${analysis.tldr} ${(analysis.concepts || []).map((c) => c.name).join(' ')} ${source.text || ''}` });
    const result = await request('POST', '/connections', {
        note: {
            title: analysis.title,
            topic: analysis.topic || '',
            tldr: analysis.tldr,
            concepts: (analysis.concepts || []).map((c) => c.name),
            tags: analysis.tags || []
        },
        library: libraryIndex(related)
    });
    return result.connections || [];
}

export async function fetchInbox() {
    const data = await request('GET', '/inbox');
    return data.items || [];
}

export function queueInboxItem(item) {
    return request('POST', '/inbox', item);
}

export function removeInboxItem(id) {
    return request('DELETE', `/inbox/${encodeURIComponent(id)}`);
}

export function updateInboxItem(id, changes) {
    return request('PATCH', `/inbox/${encodeURIComponent(id)}`, changes);
}

export async function adminListUsers() {
    return request('GET', '/admin/users');
}

export async function adminCreateUser({ label, plan }) {
    return request('POST', '/admin/users', { label, plan });
}

// Public status of the server and its optional services. deep also tests
// storage and each API key (free: no tokens are spent).
export async function fetchHealth({ deep = false } = {}) {
    let response;
    try {
        response = await fetch(`${serverBase()}/api/health${deep ? '?deep=1' : ''}`, { cache: 'no-store' });
    } catch {
        throw new Error('Can\'t reach your AidedMind server.');
    }
    const data = await response.json().catch(() => null);
    if (!data) throw new Error(plainServerError(response.status));
    return data;
}

export function serverBase() {
    const base = getSettings().serverUrl.trim().replace(/\/+$/, '');
    return base || location.origin;
}
