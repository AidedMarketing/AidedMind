// Fetch wrapper for user-supplied URLs: http(s) only, no private/loopback
// addresses, redirects re-checked hop by hop, bounded body size and time.
const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15000;
const MAX_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; AidedMindBot/0.1; personal knowledge app)';

function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) ||
            a >= 224;
    }
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return lower === '::1' || lower === '::' ||
        lower.startsWith('fc') || lower.startsWith('fd') ||
        lower.startsWith('fe80') || lower.startsWith('ff');
}

async function assertPublicUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new FetchError('That does not look like a valid URL.', 400);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new FetchError('Only http and https links are supported.', 400);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host)
        ? [{ address: host }]
        : await dns.lookup(host, { all: true }).catch(() => {
            throw new FetchError(`Could not resolve ${host}.`, 400);
        });
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
        throw new FetchError('Links to private or local network addresses are blocked.', 400);
    }
    return url;
}

class FetchError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.status = status;
    }
}

async function safeFetch(rawUrl, { accept = 'text/html,application/xhtml+xml,*/*;q=0.8' } = {}) {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const url = await assertPublicUrl(current);
        const response = await fetch(url, {
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'en;q=0.9,*;q=0.5' }
        }).catch((error) => {
            throw new FetchError(`Could not reach ${url.hostname}: ${error.message}`);
        });
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            current = new URL(response.headers.get('location'), url).toString();
            continue;
        }
        if (!response.ok) {
            throw new FetchError(`${url.hostname} responded with ${response.status}.`);
        }
        const body = await readLimited(response);
        return { url: url.toString(), contentType: response.headers.get('content-type') || '', body };
    }
    throw new FetchError('Too many redirects.');
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
            throw new FetchError('The page is larger than 5 MB.', 413);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

module.exports = { safeFetch, assertPublicUrl, isPrivateAddress, FetchError };
