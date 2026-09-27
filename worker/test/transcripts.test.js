import test from 'node:test';
import assert from 'node:assert';
import { fetchSource } from '../src/extract.js';
import { parseYouTubeDetails, supadataTranscript } from '../src/transcripts.js';
import { summarizeCosts } from '../src/costs.js';
import { sqlStore } from './helpers.js';

function mockFetch(t, handler) {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push({ url, init });
        return handler(url, init) || new Response('blocked', { status: 403 });
    };
    return calls;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function depsFor(store, env) {
    return {
        env,
        cacheGet: (k) => store.transcriptGet(k),
        cachePut: (k, v) => store.transcriptPut(k, v),
        record: (item, amount) => store.addCost('2026-09', item, amount)
    };
}

test('youtube without captions is transcribed by Gemini, then served from cache', async (t) => {
    const calls = mockFetch(t, (url, init) => {
        if (url.includes('/oembed')) return json({ title: 'Deep Work talk', author_name: 'Cal' });
        if (url.includes('generativelanguage.googleapis.com')) {
            const body = JSON.parse(init.body);
            assert.strictEqual(body.contents[0].parts[0].file_data.file_uri, 'https://www.youtube.com/watch?v=abcdefghijk');
            assert.strictEqual(init.headers['x-goog-api-key'], 'g-key');
            return json({
                candidates: [{ content: { parts: [{ text: '[0:00] Focus is a skill.\n\n[0:45] Schedule deep blocks.' }] }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 12000, candidatesTokenCount: 300 },
                modelVersion: 'gemini-flash-test'
            });
        }
        return null; // captions endpoints blocked
    });
    const store = sqlStore();
    const env = { GEMINI_API_KEY: 'g-key' };
    const source = await fetchSource('https://youtu.be/abcdefghijk', depsFor(store, env));
    assert.strictEqual(source.transcriptSource, 'gemini');
    assert.match(source.text, /Schedule deep blocks/);
    assert.strictEqual(source.title, 'Deep Work talk');
    assert.ok(!source.partial);
    assert.deepStrictEqual(store.costsFor('2026-09').map((row) => ({ ...row })), [
        { item: 'gemini:input', amount: 12000 }, { item: 'gemini:output', amount: 300 }, { item: 'gemini:videos', amount: 1 }
    ]);

    const geminiCalls = calls.filter((c) => c.url.includes('generativelanguage')).length;
    const again = await fetchSource('https://www.youtube.com/watch?v=abcdefghijk', depsFor(store, env));
    assert.strictEqual(again.text, source.text);
    assert.strictEqual(calls.filter((c) => c.url.includes('generativelanguage')).length, geminiCalls, 'cached, no second Gemini call');
});

test('youtube falls back to description and chapters when nothing else works', async (t) => {
    const description = 'In this video:\\n0:00 Intro\\n2:10 Why habits stick\\n9:30 Building a routine that lasts';
    mockFetch(t, (url) => {
        if (url.includes('/oembed')) return json({ title: 'Habits', author_name: 'Channel' });
        if (url.startsWith('https://www.youtube.com/watch')) {
            return new Response(`<html><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abcdefghijk","title":"Habits","lengthSeconds":"725","author":"Channel","shortDescription":"${description}"}};</script></html>`, { headers: { 'content-type': 'text/html' } });
        }
        return null;
    });
    const source = await fetchSource('https://www.youtube.com/watch?v=abcdefghijk', depsFor(sqlStore(), {}));
    assert.strictEqual(source.transcriptSource, 'description');
    assert.strictEqual(source.partial, true);
    assert.match(source.text, /Length: 12 minutes/);
    assert.match(source.text, /2:10 Why habits stick/);
});

test('youtube with nothing available explains how to fix it', async (t) => {
    mockFetch(t, () => null);
    await assert.rejects(fetchSource('https://youtu.be/abcdefghijk', depsFor(sqlStore(), {})), /Add a Gemini key/);
});

test('tiktok speech comes from Supadata, polling async jobs', async (t) => {
    let polls = 0;
    mockFetch(t, (url, init) => {
        if (url.startsWith('https://www.tiktok.com/@a/video/1')) return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
        if (url.includes('tiktok.com/oembed')) return json({ title: 'Morning routine #habits', author_name: '@a' });
        if (url.startsWith('https://api.supadata.ai/v1/transcript?')) {
            assert.strictEqual(init.headers['x-api-key'], 's-key');
            assert.strictEqual(new URL(url).searchParams.get('mode'), 'auto');
            return json({ jobId: 'job1' }, 202);
        }
        if (url === 'https://api.supadata.ai/v1/transcript/job1') {
            polls++;
            return json(polls < 2 ? { status: 'active' } : { status: 'completed', content: 'Wake up early and walk outside.' });
        }
        return null;
    });
    const store = sqlStore();
    const source = await fetchSource('https://www.tiktok.com/@a/video/1', { ...depsFor(store, { SUPADATA_API_KEY: 's-key' }) });
    assert.strictEqual(source.transcriptSource, 'supadata');
    assert.ok(!source.partial);
    assert.match(source.text, /Caption: Morning routine #habits\n\nTranscript:\nWake up early/);
    assert.deepStrictEqual(store.costsFor('2026-09').map((row) => ({ ...row })), [{ item: 'supadata:requests', amount: 1 }]);
}, { timeout: 20000 });

test('tiktok without a Supadata key keeps the caption-only partial breakdown', async (t) => {
    mockFetch(t, (url) => {
        if (url.includes('tiktok.com/oembed')) return json({ title: 'Caption only', author_name: '@a' });
        return null;
    });
    const source = await fetchSource('https://www.tiktok.com/@a/video/2', depsFor(sqlStore(), {}));
    assert.strictEqual(source.transcriptSource, 'caption');
    assert.strictEqual(source.partial, true);
});

test('supadata job that never finishes asks for a retry instead of failing', async (t) => {
    mockFetch(t, (url) => (url.includes('/transcript?') ? json({ jobId: 'slow' }, 202) : json({ status: 'active' })));
    let now = 0;
    const realNow = Date.now;
    t.after(() => { Date.now = realNow; });
    Date.now = () => now;
    await assert.rejects(
        supadataTranscript('https://www.tiktok.com/@a/video/3', { SUPADATA_API_KEY: 'k' }, { sleep: async () => { now += 10000; } }),
        (error) => error.status === 503
    );
});

test('youtube page details parser handles escapes', () => {
    const details = parseYouTubeDetails('{"title":"A \\"quoted\\" title","author":"Me","lengthSeconds":"60","shortDescription":"Line one\\nLine two \\u0026 more"}');
    assert.deepStrictEqual(details, { title: 'A "quoted" title', author: 'Me', description: 'Line one\nLine two & more', lengthSeconds: 60 });
});

test('cost summary prices each Claude model', () => {
    const spend = summarizeCosts([
        { item: 'claude:claude-sonnet-5:input', amount: 1_000_000 },
        { item: 'claude:claude-sonnet-5:output', amount: 100_000 },
        { item: 'claude:claude-opus-5-5:output', amount: 50_000 },
        { item: 'claude:claude-haiku-4-5-20251001:input', amount: 200_000 },
        { item: 'claude:mystery-model:input', amount: 5 },
        { item: 'gemini:videos', amount: 3 },
        { item: 'supadata:requests', amount: 7 }
    ]);
    assert.deepStrictEqual(spend.claudeByModel, { 'claude-sonnet-5': 3, 'claude-opus-5-5': 1, 'claude-haiku-4-5-20251001': 0.2 });
    assert.strictEqual(spend.claudeUsd, 4.2);
    assert.deepStrictEqual(spend.unpricedModels, ['mystery-model']);
    assert.strictEqual(spend.geminiVideos, 3);
    assert.strictEqual(spend.supadataRequests, 7);
});
