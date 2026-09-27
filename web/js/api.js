// Talks to the AidedMind server. Settings live in localStorage.
import { relatedNotes, conceptVocabulary, findDuplicate } from './library.js';

const SETTINGS_KEY = 'aidedmind.settings';
const USAGE_KEY = 'aidedmind.usage';

export function getSettings() {
    try {
        return { serverUrl: '', token: '', showConcepts: true, depth: 'auto', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
        return { serverUrl: '', token: '', showConcepts: true, depth: 'auto' };
    }
}

export function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function endpoint(path) {
    const base = getSettings().serverUrl.trim().replace(/\/+$/, '');
    return `${base}/api${path}`;
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
        const error = new Error(data.error || `Server error (${response.status}).`);
        error.status = response.status;
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
export async function capture({ url, text, title, depth, photos }, notes) {
    // Links already saved open the existing note: no fetch, no Claude call.
    const saved = url ? findDuplicate(notes, url) : null;
    if (saved) throw new DuplicateError(saved);
    let source;
    if (photos?.length) {
        source = {
            sourceType: 'photo',
            url: '',
            title: title || '',
            author: '',
            text: text || '',
            images: photos.map((photo) => ({ mediaType: photo.mediaType, data: photo.data }))
        };
    } else if (text) {
        source = { sourceType: 'text', url: url || '', title: title || '', author: '', text };
    } else {
        const fetched = await request('POST', '/source', { url });
        if (fetched.html) {
            const { readableFromHtml } = await import('./readable.js');
            source = { sourceType: 'article', url: fetched.url, ...readableFromHtml(fetched.html, fetched.url) };
        } else {
            source = fetched;
        }
        // Short links (vm.tiktok.com, youtu.be) resolve to the saved address.
        const resolved = findDuplicate(notes, source.url);
        if (resolved) throw new DuplicateError(resolved);
        source.sharedUrl = url;
    }
    // Only the notes likely to connect are sent, plus the library's common
    // concept names, so the cost per breakdown stays flat as the library grows.
    const related = relatedNotes(notes, source);
    const body = { source, library: libraryIndex(related), depth: depth || getSettings().depth };
    if (related.length < notes.length) body.concepts = conceptVocabulary(notes);
    const result = await request('POST', '/analyze', body);
    setLastUsage(result.usage);
    if (source.images) {
        // Keep what Claude read from the photos, never the photos themselves.
        const { images, ...rest } = source;
        source = { ...rest, text: result.analysis.sourceText || source.text };
    }
    return { source, analysis: result.analysis, model: result.model, depth: result.depth, auto: result.auto, usage: result.usage };
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

export async function fetchInbox() {
    const data = await request('GET', '/inbox');
    return data.items || [];
}

export function removeInboxItem(id) {
    return request('DELETE', `/inbox/${encodeURIComponent(id)}`);
}

export async function adminListUsers() {
    return request('GET', '/admin/users');
}

export async function adminCreateUser({ label, plan }) {
    return request('POST', '/admin/users', { label, plan });
}

export function serverBase() {
    const base = getSettings().serverUrl.trim().replace(/\/+$/, '');
    return base || location.origin;
}
