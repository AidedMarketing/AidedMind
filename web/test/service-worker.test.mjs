import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function controller(document = 'current document', network = 'new deployment from network') {
    const source = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
    const version = source.match(/const CACHE_NAME = '([^']+)'/)[1];
    const listeners = new Map();
    const requests = [];
    const releases = new Map([
        [version, new Map([['./index.html', document], ['https://app.test/app.css', 'current styles']])],
        ['aidedmind-next', new Map([['./index.html', 'next document'], ['https://app.test/app.css', 'next styles']])]
    ]);
    runInNewContext(source, {
        URL, Response,
        self: { location: { origin: 'https://app.test' }, addEventListener: (name, callback) => listeners.set(name, callback) },
        caches: {
            open: async (name) => ({ match: async (key) => releases.get(name)?.get(typeof key === 'string' ? key : key.url) }),
            // Global lookup must not accidentally select another installed release.
            match: async () => 'next release from global lookup'
        },
        fetch: async (request) => { requests.push(request.url); return network; }
    });
    return {
        requests,
        fetch: async (path, mode = 'navigate', method = 'GET') => {
            let response;
            listeners.get('fetch')({ request: { url: 'https://app.test' + path, mode, method }, respondWith: (value) => { response = value; } });
            return response;
        }
    };
}

test('navigation and share URLs keep the active release document when a newer deployment exists', async () => {
    const sw = await controller();
    assert.equal(await sw.fetch('/'), 'current document');
    assert.equal(await sw.fetch('/share?url=https%3A%2F%2Fexample.com%2Fpiece'), 'current document');
    assert.equal(await sw.fetch('/app.css', 'cors'), 'current styles');
    assert.deepEqual(sw.requests, []);
});

test('uncached assets still use the network; APIs and mutations bypass the shell cache', async () => {
    const sw = await controller();
    assert.equal(await sw.fetch('/new-image.png', 'cors'), 'new deployment from network');
    assert.equal(await sw.fetch('/api/health', 'cors'), undefined);
    assert.equal(await sw.fetch('/api/inbox', 'cors', 'POST'), undefined);
    assert.deepEqual(sw.requests, ['https://app.test/new-image.png']);
});


test('redirected cached HTML is returned as a fresh navigation response without redirect history', async () => {
    const redirected = new Response('<h1>Current release</h1>', { headers: { 'Content-Type': 'text/html', 'X-Release': 'current' } });
    Object.defineProperty(redirected, 'redirected', { value: true });
    const sw = await controller(redirected);
    const response = await sw.fetch('/?reopen=1');
    assert.equal(response.redirected, false);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'text/html');
    assert.equal(response.headers.get('X-Release'), 'current');
    assert.equal(await response.text(), '<h1>Current release</h1>');
    assert.deepEqual(sw.requests, []);
});

test('redirected network fallback is also safe when the shell cache is missing', async () => {
    const redirected = new Response('Fallback document');
    Object.defineProperty(redirected, 'redirected', { value: true });
    // null intentionally represents a missing cached entry.
    const missing = await controller(null, redirected);
    const response = await missing.fetch('/');
    assert.equal(response.redirected, false);
    assert.equal(await response.text(), 'Fallback document');
    assert.deepEqual(missing.requests, ['https://app.test/']);
});


test('loading repair refreshes only app caches and registration, preserving device data', async () => {
    const source = await readFile(new URL('../recovery.js', import.meta.url), 'utf8');
    let repair;
    const deleted = [], unregistered = [], navigations = [];
    const button = { addEventListener: (_, callback) => { repair = callback; } };
    runInNewContext(source, {
        URL, document: { getElementById: (id) => id === 'repair' ? button : {} },
        location: { href: 'https://app.test/api/recover', replace: (url) => navigations.push(url) },
        navigator: { serviceWorker: { getRegistrations: async () => ['https://app.test/', 'https://app.test/other/'].map((scope) => ({ scope, unregister: async () => unregistered.push(scope) })) } },
        caches: { keys: async () => ['aidedmind-v31', 'aidedmind-v32', 'other-cache'], delete: async (key) => deleted.push(key) },
        indexedDB: { open: () => { throw Error('Must not access saved pieces'); } },
        localStorage: { clear: () => { throw Error('Must not clear settings'); } }
    });
    await repair();
    assert.deepEqual(deleted, ['aidedmind-v31', 'aidedmind-v32']);
    assert.deepEqual(unregistered, ['https://app.test/']);
    assert.deepEqual(navigations, ['/']);
});
