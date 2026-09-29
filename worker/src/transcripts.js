// Optional transcript services, each switched on by its secret:
//   GEMINI_API_KEY   - Google Gemini watches public YouTube videos (captions or not)
//   SUPADATA_API_KEY - Supadata transcribes TikTok speech (and fetches YouTube captions)
// Without keys, these return null and the caller falls back to cheaper sources.
import { HttpError } from './http.js';
import { fetchPage, decodeEntities } from './extract.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
const GEMINI_TIMEOUT_MS = 4 * 60 * 1000;
const SUPADATA_BASE = 'https://api.supadata.ai/v1';
const SUPADATA_POLL_MS = 3000;
const SUPADATA_MAX_WAIT_MS = 90 * 1000;

const GEMINI_PROMPT = `Transcribe this video for a note-taking app.
Output plain text only:
- The spoken words as a clean transcript (drop filler words like "um", keep the meaning and the speaker's phrasing).
- Start a new paragraph roughly every 30-60 seconds, prefixed with a [mm:ss] or [h:mm:ss] timestamp.
- If important information appears only on screen (slides, captions, code, charts), add it on its own line starting with "On screen:".
Do not summarize, comment, or add anything that is not in the video.`;

export async function geminiTranscript(videoUrl, env) {
    if (!env.GEMINI_API_KEY) return null;
    const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    let response;
    try {
        response = await fetch(`${env.GEMINI_BASE_URL || GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
            body: JSON.stringify({
                contents: [{ parts: [{ file_data: { file_uri: videoUrl } }, { text: GEMINI_PROMPT }] }],
                generationConfig: { maxOutputTokens: 32768, temperature: 0.2 }
            })
        });
    } catch (error) {
        console.warn(`gemini unreachable: ${error.message}`);
        return null;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        console.warn(`gemini ${response.status}: ${data?.error?.message || 'no message'}`);
        return null;
    }
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts || [])
        .filter((part) => typeof part.text === 'string' && !part.thought)
        .map((part) => part.text)
        .join('')
        .trim();
    if (!text) {
        console.warn(`gemini returned no text (${candidate?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`);
        return null;
    }
    const usage = data.usageMetadata || {};
    return {
        text,
        truncated: candidate.finishReason === 'MAX_TOKENS',
        model: data.modelVersion || model,
        usage: {
            input: usage.promptTokenCount || 0,
            output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)
        }
    };
}

async function supadataGet(path, env) {
    const response = await fetch(`${env.SUPADATA_BASE_URL || SUPADATA_BASE}${path}`, {
        signal: AbortSignal.timeout(30000),
        headers: { 'x-api-key': env.SUPADATA_API_KEY }
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
}

// mode: 'native' (existing captions only, cheapest), 'generate' or 'auto'
// (AI speech-to-text when there are no captions).
const SUPADATA_REASONS = {
    401: 'Supadata rejected the API key. Check SUPADATA_API_KEY in Cloudflare.',
    403: 'Supadata rejected the API key. Check SUPADATA_API_KEY in Cloudflare.',
    402: 'Supadata is out of credits for this month.',
    429: 'Supadata is rate limiting requests. Try again in a minute.'
};

function supadataReason(status, data) {
    const detail = String(data?.message || data?.details || data?.error?.message || data?.error || '').slice(0, 200);
    if (!SUPADATA_REASONS[status]) console.warn(`supadata ${status}: ${detail || 'no message'}`);
    return SUPADATA_REASONS[status] || 'Supadata couldn\'t transcribe this video. It may be private, too long, or not available in your region.';
}

// report(reason) is told why no transcript came back, so the note can say so.
export async function supadataTranscript(url, env, { mode = 'auto', sleep = (ms) => new Promise((r) => setTimeout(r, ms)), report = () => {} } = {}) {
    if (!env.SUPADATA_API_KEY) return null;
    const fail = (reason) => {
        console.warn(`supadata: ${reason}`);
        report(reason);
        return null;
    };
    try {
        const query = new URLSearchParams({ url, text: 'true', mode });
        let { status, data } = await supadataGet(`/transcript?${query}`, env);
        if (status === 202 && data.jobId) {
            const jobId = data.jobId;
            const deadline = Date.now() + SUPADATA_MAX_WAIT_MS;
            for (;;) {
                if (Date.now() > deadline) {
                    throw new HttpError(503, 'The video is still being transcribed. It will be retried shortly.');
                }
                await sleep(SUPADATA_POLL_MS);
                ({ status, data } = await supadataGet(`/transcript/${encodeURIComponent(jobId)}`, env));
                if (data.status === 'completed') break;
                if (data.status === 'failed') {
                    return fail(`Supadata couldn't transcribe this video: ${String(data.error?.message || data.error || 'unknown error').slice(0, 200)}`);
                }
                if (status >= 400) return fail(supadataReason(status, data));
            }
        } else if (status !== 200) {
            return fail(supadataReason(status, data));
        }
        const content = data.content ?? data.result?.content;
        const text = typeof content === 'string'
            ? content
            : Array.isArray(content) ? content.map((c) => c.text).join(' ') : '';
        if (!text.trim()) return fail('Supadata found no speech in this video.');
        return { text: text.replace(/\s+\n/g, '\n').trim(), lang: data.lang || '' };
    } catch (error) {
        if (error instanceof HttpError) throw error;
        return fail(`Couldn't reach Supadata (${error.message}).`);
    }
}

// Health check for the optional services: confirms each key works without
// spending anything. Returns { service: reasonCode } for the ones that don't.
export async function checkServices(env) {
    const problems = {};
    const probe = async (name, url, headers) => {
        try {
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
            if (response.ok) return;
            if ([400, 401, 403].includes(response.status)) problems[name] = 'api_key_rejected';
            else if (response.status === 402) problems[name] = 'out_of_credits';
            else if (response.status === 404 && name === 'gemini') problems[name] = 'model_not_available';
            else if (response.status !== 404) problems[name] = `error_${response.status}`;
        } catch {
            problems[name] = 'unreachable';
        }
    };
    const checks = [];
    if (env.GEMINI_API_KEY) {
        const base = env.GEMINI_BASE_URL || GEMINI_BASE;
        checks.push(probe('gemini', `${base}/${encodeURIComponent(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL)}`, { 'x-goog-api-key': env.GEMINI_API_KEY }));
    }
    if (env.SUPADATA_API_KEY) {
        checks.push(probe('supadata', `${env.SUPADATA_BASE_URL || SUPADATA_BASE}/me`, { 'x-api-key': env.SUPADATA_API_KEY }));
    }
    await Promise.all(checks);
    return problems;
}

// Title, channel, length and description (which often lists chapters) from
// the watch page. Used when no transcript can be had at all.
export function parseYouTubeDetails(html) {
    const read = (key) => {
        const match = html.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
        if (!match) return '';
        try {
            return JSON.parse(`"${match[1]}"`);
        } catch {
            return decodeEntities(match[1]);
        }
    };
    const length = html.match(/"lengthSeconds":"(\d+)"/);
    return {
        title: read('title'),
        author: read('author'),
        description: read('shortDescription'),
        lengthSeconds: length ? Number(length[1]) : 0
    };
}

export async function youtubeDetails(videoUrl) {
    try {
        const page = await fetchPage(videoUrl);
        const details = parseYouTubeDetails(page.body);
        return details.description || details.title ? details : null;
    } catch (error) {
        console.warn(`youtube page unavailable: ${error.message}`);
        return null;
    }
}
