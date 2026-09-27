import test from 'node:test';
import assert from 'node:assert';
import { classifyUrl, youtubeId, decodeEntities, isPrivateAddress, assertPublicUrl } from '../src/extract.js';
import { normalize, compactLibrary, analyze, ANALYSIS_SCHEMA } from '../src/analyze.js';
import { sqlStore } from './helpers.js';

test('classifies source URLs', () => {
    assert.strictEqual(classifyUrl('https://www.youtube.com/watch?v=abc123def45'), 'youtube');
    assert.strictEqual(classifyUrl('https://youtu.be/abc123def45'), 'youtube');
    assert.strictEqual(classifyUrl('https://m.youtube.com/shorts/abc123def45'), 'youtube');
    assert.strictEqual(classifyUrl('https://vm.tiktok.com/ZMabc/'), 'tiktok');
    assert.strictEqual(classifyUrl('https://example.com/post'), 'article');
    assert.strictEqual(classifyUrl('not a url'), 'invalid');
});

test('extracts YouTube ids and decodes captions', () => {
    assert.strictEqual(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'dQw4w9WgXcQ');
    assert.strictEqual(youtubeId('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ');
    assert.strictEqual(youtubeId('https://www.youtube.com/feed/library'), null);
    assert.strictEqual(decodeEntities('it&#39;s &lt;3 &amp; more'), 'it\'s <3 & more');
});

test('private address detection', () => {
    ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']
        .forEach((ip) => assert.ok(isPrivateAddress(ip), ip));
    ['8.8.8.8', '2606:4700::1111', 'example.com'].forEach((ip) => assert.ok(!isPrivateAddress(ip), ip));
    assert.throws(() => assertPublicUrl('http://printer.local/'), /private/);
    assert.ok(assertPublicUrl('https://example.com/a'));
});

test('normalize drops unknown connections and dedupes concepts', () => {
    const result = normalize({
        title: ' T ', tldr: 'x',
        summary: [{ heading: 'a', body: 'b' }, { heading: 'e', body: '' }],
        outline: [{ level: 7, text: 'deep' }],
        concepts: [{ name: 'Spaced repetition', description: 'd' }, { name: 'spaced repetition', description: 'dup' }],
        tags: ['#Memory', 'Learning Science', 'memory'], quotes: ['q'], takeaways: [],
        connections: [{ noteId: 'n1', relation: 'supports', reason: 'r' }, { noteId: 'ghost', relation: 'related', reason: 'r' }]
    }, new Set(['n1']));
    assert.strictEqual(result.summary.length, 1);
    assert.deepStrictEqual(result.outline, [{ level: 3, text: 'deep' }]);
    assert.strictEqual(result.concepts.length, 1);
    assert.deepStrictEqual(result.tags, ['memory', 'learning-science']);
    assert.deepStrictEqual(result.connections.map((c) => c.noteId), ['n1']);
    assert.deepStrictEqual(compactLibrary('nope'), []);
});

test('schema is strict at every object level', () => {
    const walk = (schema) => {
        if (schema.type === 'object') {
            assert.strictEqual(schema.additionalProperties, false);
            assert.deepStrictEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
            Object.values(schema.properties).forEach(walk);
        }
        if (schema.type === 'array') walk(schema.items);
    };
    walk(ANALYSIS_SCHEMA);
});

test('oversized sources are rejected, not truncated', async () => {
    await assert.rejects(analyze({ text: 'x'.repeat(700000) }, [], {}), (error) => error.status === 413);
});

test('store: quota reservation and inbox expiry', () => {
    const store = sqlStore();
    assert.deepStrictEqual(store.reserveCapture('2026-09', 1), { ok: true, captures: 1 });
    assert.deepStrictEqual(store.reserveCapture('2026-09', 1), { ok: false, captures: 1 });
    store.releaseCapture('2026-09');
    assert.strictEqual(store.usageFor('2026-09').captures, 0);
    assert.strictEqual(store.reserveCapture('2026-09', null).ok, true);

    store.inboxAdd({ url: 'https://example.com/new' });
    store.sql.exec('INSERT INTO inbox (id, url, received_at) VALUES (?, ?, ?)', 'old', 'https://example.com/old', '2020-01-01T00:00:00.000Z');
    assert.deepStrictEqual(store.inboxList().map((i) => i.url), ['https://example.com/new']);
    assert.strictEqual(store.inboxAdd({ url: '', text: '  ' }), null);
});
