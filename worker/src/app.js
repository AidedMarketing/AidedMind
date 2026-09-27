// AidedMind API. Static files (web/) are served by Workers Static Assets;
// only /api/* reaches this code.
import { analyze, checkModel } from './analyze.js';
import { fetchSource } from './extract.js';
import { HttpError, json, readJson, sha256Hex, digestsEqual, randomToken } from './http.js';
import { summarizeCosts } from './costs.js';
import { checkServices } from './transcripts.js';

export const VERSION = '0.2.0';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-AidedMind-Token, Authorization',
    'Access-Control-Max-Age': '86400'
};

// Photos arrive already resized on the phone (~200-400 KB each).
export const MAX_PHOTOS = 8;
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024; // Claude's per-image limit
const MAX_ANALYZE_BYTES = 16 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function cleanImages(images) {
    if (images === undefined || images === null) return [];
    if (!Array.isArray(images)) throw new HttpError(400, 'images must be a list.');
    if (images.length > MAX_PHOTOS) throw new HttpError(413, `Add up to ${MAX_PHOTOS} photos at a time.`);
    return images.map((image, index) => {
        const mediaType = String(image?.mediaType || '');
        const data = String(image?.data || '');
        if (!IMAGE_TYPES.has(mediaType)) throw new HttpError(415, `Photo ${index + 1} isn't a supported image type.`);
        if (!data || data.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
            throw new HttpError(400, `Photo ${index + 1} couldn't be read.`);
        }
        return { mediaType, data };
    });
}

export function currentMonth(date = new Date()) {
    return date.toISOString().slice(0, 7);
}

export function monthlyLimit(plan, env) {
    if (plan === 'owner' || plan === 'unlimited') return null;
    if (plan === 'pro') return Number(env.PRO_MONTHLY_CAPTURES || 400);
    return Number(env.FREE_MONTHLY_CAPTURES || 25);
}

function directory(env) {
    return env.STORE.get(env.STORE.idFromName('directory'));
}

function userStore(env, userId) {
    return env.STORE.get(env.STORE.idFromName(`user:${userId}`));
}

async function authenticate(request, env) {
    const header = request.headers.get('X-AidedMind-Token') || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const token = header.trim();
    if (!token) throw new HttpError(401, 'Missing access token. Add it in AidedMind settings.');
    const hash = await sha256Hex(token);
    if (env.OWNER_TOKEN && digestsEqual(hash, await sha256Hex(env.OWNER_TOKEN))) {
        return { id: 'owner', plan: 'owner', label: 'Owner' };
    }
    const user = await directory(env).findUser(hash);
    if (!user) throw new HttpError(401, 'That access token isn\'t valid. Check it in AidedMind settings.');
    if (user.status !== 'active') throw new HttpError(403, 'This account is paused.');
    return user;
}

async function usageSummary(env, user) {
    const store = userStore(env, user.id);
    const month = currentMonth();
    const [usage, costs] = await Promise.all([store.usageFor(month), store.costsFor(month)]);
    return { month, captures: usage.captures, limit: monthlyLimit(user.plan, env), spend: summarizeCosts(costs) };
}

function requireOwner(user) {
    if (user.plan !== 'owner') throw new HttpError(403, 'Only the owner can do that.');
}

const routes = [
    ['GET', /^\/api\/health$/, async (request, env) => {
        const url = new URL(request.url);
        const checks = {
            anthropicKey: Boolean(env.ANTHROPIC_API_KEY),
            ownerToken: Boolean(env.OWNER_TOKEN)
        };
        const problems = {};
        if (url.searchParams.get('deep') === '1') {
            checks.storage = await Promise.resolve().then(() => directory(env).ping()).then(() => true, () => false);
            const modelProblem = await checkModel(env);
            checks.model = !modelProblem;
            if (modelProblem) problems.model = modelProblem;
        }
        const ok = Object.values(checks).every(Boolean);
        // Optional services: reported, but never make the app unhealthy.
        const services = { gemini: Boolean(env.GEMINI_API_KEY), supadata: Boolean(env.SUPADATA_API_KEY) };
        const serviceProblems = url.searchParams.get('deep') === '1' ? await checkServices(env) : {};
        return json({
            ok, version: VERSION, checks, services,
            ...(Object.keys(serviceProblems).length ? { serviceProblems } : {}),
            ...(ok ? {} : { problems })
        }, ok ? 200 : 503);
    }],

    ['POST', /^\/api\/auth-check$/, async (request, env, user) => {
        return json({ ok: true, user: { id: user.id, plan: user.plan }, usage: await usageSummary(env, user) });
    }, { auth: true }],

    ['POST', /^\/api\/source$/, async (request, env, user) => {
        const { url } = await readJson(request);
        const store = userStore(env, user.id);
        const month = currentMonth();
        return json(await fetchSource(url, {
            env,
            cacheGet: (key) => store.transcriptGet(key),
            cachePut: (key, source) => store.transcriptPut(key, source),
            record: (item, amount) => store.addCost(month, item, amount)
        }));
    }, { auth: true }],

    ['POST', /^\/api\/analyze$/, async (request, env, user) => {
        const { source, library, depth, concepts } = await readJson(request, MAX_ANALYZE_BYTES);
        if (!source || typeof source !== 'object') throw new HttpError(400, 'Send a source to analyze.');
        const store = userStore(env, user.id);
        const month = currentMonth();
        const limit = monthlyLimit(user.plan, env);
        const reservation = await store.reserveCapture(month, limit);
        if (!reservation.ok) {
            throw new HttpError(402, `You've used all ${limit} breakdowns for this month. They reset on the 1st.`, { usage: { month, captures: reservation.captures, limit } });
        }
        try {
            const clean = {
                sourceType: String(source.sourceType || 'text'),
                url: String(source.url || ''),
                title: String(source.title || ''),
                author: String(source.author || ''),
                partial: Boolean(source.partial),
                text: String(source.text || ''),
                images: cleanImages(source.images)
            };
            const result = await analyze(clean, library, env, typeof depth === 'string' ? depth : undefined, concepts);
            await store.recordTokens(month, result.tokens.input, result.tokens.output);
            await store.addCost(month, `claude:${result.model}:input`, result.tokens.input);
            await store.addCost(month, `claude:${result.model}:output`, result.tokens.output);
            return json({ analysis: result.analysis, model: result.model, depth: result.depth, auto: result.auto, usage: { month, captures: reservation.captures, limit } });
        } catch (error) {
            await store.releaseCapture(month);
            throw error;
        }
    }, { auth: true }],

    // iOS Shortcut target: holds shared links until the app opens.
    ['POST', /^\/api\/inbox$/, async (request, env, user) => {
        const body = await readJson(request);
        const item = await userStore(env, user.id).inboxAdd({ url: body.url, text: body.text, title: body.title });
        if (!item) throw new HttpError(400, 'Nothing to save: send a url or text.');
        return json({ ok: true, id: item.id, message: 'Saved to AidedMind. Open the app to see the breakdown.' }, 201);
    }, { auth: true }],

    ['GET', /^\/api\/inbox$/, async (request, env, user) => {
        return json({ items: await userStore(env, user.id).inboxList() });
    }, { auth: true }],

    ['DELETE', /^\/api\/inbox\/([\w-]+)$/, async (request, env, user, match) => {
        return json({ ok: await userStore(env, user.id).inboxRemove(match[1]) });
    }, { auth: true }],

    // Owner-only account management: the base for paid plans later.
    ['GET', /^\/api\/admin\/users$/, async (request, env, user) => {
        requireOwner(user);
        const users = await directory(env).listUsers();
        const month = currentMonth();
        const withUsage = await Promise.all(users.map(async (u) => ({
            ...u,
            usage: await userStore(env, u.id).usageFor(month),
            limit: monthlyLimit(u.plan, env)
        })));
        return json({ month, users: withUsage });
    }, { auth: true }],

    ['POST', /^\/api\/admin\/users$/, async (request, env, user) => {
        requireOwner(user);
        const { plan = 'free', label = '' } = await readJson(request);
        if (!['free', 'pro', 'unlimited'].includes(plan)) throw new HttpError(400, 'plan must be free, pro or unlimited.');
        const token = randomToken();
        const created = await directory(env).createUser({
            id: crypto.randomUUID(),
            tokenHash: await sha256Hex(token),
            plan,
            label: String(label).slice(0, 100)
        });
        return json({ ...created, token, limit: monthlyLimit(plan, env) }, 201);
    }, { auth: true }],

    ['PATCH', /^\/api\/admin\/users\/([\w-]+)$/, async (request, env, user, match) => {
        requireOwner(user);
        const { plan, status } = await readJson(request);
        if (plan && !['free', 'pro', 'unlimited'].includes(plan)) throw new HttpError(400, 'plan must be free, pro or unlimited.');
        if (status && !['active', 'paused'].includes(status)) throw new HttpError(400, 'status must be active or paused.');
        const updated = await directory(env).updateUser(match[1], { plan, status });
        if (!updated) throw new HttpError(404, 'No such user.');
        return json(updated);
    }, { auth: true }]
];

async function handleApi(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    const { pathname } = new URL(request.url);
    const candidates = routes.filter(([, pattern]) => pattern.test(pathname));
    if (!candidates.length) throw new HttpError(404, 'Not found.');
    const route = candidates.find(([method]) => method === request.method);
    if (!route) throw new HttpError(405, 'Method not allowed.');
    const [, pattern, handler, options = {}] = route;
    const user = options.auth ? await authenticate(request, env) : null;
    return handler(request, env, user, pathname.match(pattern));
}

export default {
    async fetch(request, env) {
        const { pathname } = new URL(request.url);
        if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
        let response;
        try {
            response = await handleApi(request, env);
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500;
            if (status >= 500) console.error('api error', pathname, error);
            response = json({ error: error instanceof HttpError ? error.message : 'Unexpected server error.', ...(error.extra || {}) }, status);
        }
        const headers = new Headers(response.headers);
        Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(response.body, { status: response.status, headers });
    }
};
