import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function controller() {
    const source = await readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
    const version = source.match(/const CACHE_NAME = '([^']+)'/)[1];
    const listeners = new Map();
    const requests = [];
    const releases = new Map([
        [version, new Map([['./index.html', 'current document'], ['https://app.test/app.css', 'current styles']])],
        ['aidedmind-next', new Map([['./index.html', 'next document'], ['https://app.test/app.css', 'next styles']])]
    ]);
    runInNewContext(source, {
        URL,
        self: { location: { origin: 'https://app.test' }, addEventListener: (name, callback) => listeners.set(name, callback) },
        caches: {
            open: async (name) => ({ match: async (key) => releases.get(name)?.get(typeof key === 'string' ? key : key.url) }),
            // Global lookup must not accidentally select another installed release.
            match: async () => 'next release from global lookup'
        },
        fetch: async (request) => { requests.push(request.url); return 'new deployment from network'; }
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
