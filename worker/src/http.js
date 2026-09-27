// Small response helpers and error type shared by the API.
export class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

export function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
    });
}

export async function readJson(request, maxBytes = 2 * 1024 * 1024) {
    const length = Number(request.headers.get('content-length') || 0);
    if (length > maxBytes) throw new HttpError(413, 'Request is too large.');
    const text = await request.text();
    if (text.length > maxBytes) throw new HttpError(413, 'Request is too large.');
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw new HttpError(400, 'Request body must be JSON.');
    }
}

export async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison of two hex digests of equal length.
export function digestsEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export function randomToken(bytes = 24) {
    const raw = crypto.getRandomValues(new Uint8Array(bytes));
    return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
