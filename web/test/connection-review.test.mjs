import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestConnections } from '../js/api.js';

const note = { title: 'Spaced practice', topic: 'Learning', tldr: 'Practice over time', concepts: [] };
const library = [{ id: 'other', title: 'Memory', tldr: 'Recall improves with practice', concepts: [], tags: [] }];

test('an incomplete connection response cannot replace existing links with an empty result', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({}));
    await assert.rejects(() => suggestConnections(note, { text: 'Original passage' }, library), /did not finish/);
});
test('a successful empty connection result is accepted', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ connections: [] }));
    assert.deepEqual(await suggestConnections(note, { text: 'Original passage' }, library), []);
});
test('a stalled connection request aborts and becomes a retryable failure', async (t) => {
    const timer = globalThis.setTimeout;
    let sentSignal;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => timer(callback, delay === 90000 ? 0 : delay, ...args));
    t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
        sentSignal = signal;
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('Aborted')), { once: true }));
    });
    await assert.rejects(() => suggestConnections(note, { text: 'Original passage' }, library), /reach your AidedMind server/);
    assert.equal(sentSignal.aborted, true);
});
