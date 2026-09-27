// Talks to the AidedMind server. Settings live in localStorage.
const SETTINGS_KEY = 'aidedmind.settings';

export function getSettings() {
    try {
        return { serverUrl: '', token: '', showConcepts: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
        return { serverUrl: '', token: '', showConcepts: true };
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

export function capture({ url, text, title }, notes) {
    const library = notes.map((note) => ({
        id: note.id,
        title: note.title,
        tldr: note.tldr,
        concepts: (note.concepts || []).map((c) => c.name),
        tags: note.tags || []
    }));
    return request('POST', '/capture', { url, text, title, library });
}

export function checkAuth() {
    return request('POST', '/auth-check', {});
}

export async function fetchInbox() {
    const data = await request('GET', '/inbox');
    return data.items || [];
}

export function removeInboxItem(id) {
    return request('DELETE', `/inbox/${encodeURIComponent(id)}`);
}

export function serverBase() {
    const base = getSettings().serverUrl.trim().replace(/\/+$/, '');
    return base || location.origin;
}
