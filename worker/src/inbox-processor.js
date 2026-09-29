// Breaks shared links down on the server while the app is closed.
//
// A link posted to the inbox is queued; the user's Durable Object wakes on an
// alarm and runs processInbox(): fetch the source (article, YouTube, TikTok),
// break it down with Claude and store the finished note until the app opens
// and collects it. Anything that can't be finished is left in a state the app
// understands: retried later, finished by the app itself, or failed with a
// reason.
//
// It works on the storage core directly (no network hops to itself), so it
// runs the same in tests as in production.
import { analyze } from './analyze.js';
import { extractArticle } from './article.js';
import { classifyUrl, fetchSource } from './extract.js';
import { recordClaude } from './costs.js';
import { HttpError, currentMonth } from './http.js';
import { looksPaywalled } from '../../web/js/paywall.js';
import { canonicalUrl } from '../../web/js/library.js';

export const MAX_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000];
const PROVIDER_RETRY_MAX_MS = 60 * 60 * 1000;
const LEASE_MS = 12 * 60 * 1000; // an item claimed by a run that died is picked up again after this
const STORED_TEXT_MAX = 400000; // one SQLite row holds the whole finished note
// Sites that answered with these will answer the same way next time.
const PERMANENT_UPSTREAM = new Set([401, 403, 404, 410, 451]);

function sourceTypeFor(url) {
    const kind = classifyUrl(url || '');
    return kind === 'invalid' ? 'text' : kind;
}

// Text the user sent along with the link (for example a page captured from
// their own logged-in Safari) is the article; otherwise fetch the link.
async function buildSource(core, env, item, month) {
    if (item.text) {
        return { sourceType: sourceTypeFor(item.url), url: item.url, title: item.title, author: '', text: item.text };
    }
    const fetched = await fetchSource(item.url, {
        env,
        cacheGet: (key) => core.transcriptGet(key),
        cachePut: (key, source) => core.transcriptPut(key, source),
        record: (name, amount) => core.addCost(month, name, amount)
    });
    if (!fetched.html) return { ...fetched, sharedUrl: item.url !== fetched.url ? item.url : '' };

    let page;
    try {
        page = extractArticle(fetched.html, fetched.url);
    } catch (error) {
        // A URL-only share cannot gain access to the user's logged-in app.
        // Keep the link and let them add text to this same inbox item.
        error.errorKind = 'needs_text';
        throw error;
    }
    const paywalled = Boolean(fetched.restricted) || looksPaywalled(fetched.html, page.text);
    return {
        sourceType: 'article',
        url: fetched.url,
        sharedUrl: item.url !== fetched.url ? item.url : '',
        ...page,
        partial: paywalled,
        transcriptSource: paywalled ? 'paywall' : ''
    };
}

function pack(source, result) {
    return {
        source: {
            sourceType: source.sourceType,
            url: source.url || '',
            sharedUrl: source.sharedUrl || '',
            title: source.title || '',
            author: source.author || '',
            siteName: source.siteName || '',
            thumbnail: source.thumbnail || '',
            partial: Boolean(source.partial),
            transcriptSource: source.transcriptSource || '',
            transcriptError: source.transcriptError || '',
            text: String(source.text || '').slice(0, STORED_TEXT_MAX)
        },
        analysis: result.analysis,
        model: result.model,
        depth: result.depth,
        auto: result.auto
    };
}

function fail(core, item, error, nowMs) {
    const status = error?.status;
    const known = error instanceof HttpError;
    if (!known) console.error('inbox item error', item.id, error);
    const message = known || error?.errorKind ? error.message : 'Something went wrong on the server.';
    if (error?.errorKind === 'provider_unavailable') {
        const delay = Math.min(PROVIDER_RETRY_MAX_MS, 60 * 1000 * 2 ** Math.min(item.attempts - 1, 6));
        return core.inboxRetry(item.id, nowMs + delay, message);
    }
    if (error?.errorKind) return core.inboxFail(item.id, { error: message, kind: error.errorKind });
    if ([401, 403].includes(error?.upstreamStatus)) {
        return core.inboxFail(item.id, { error: message, kind: 'needs_text' });
    }
    const transient = !status || status === 429 || status === 408 || status >= 500;
    if (!transient || PERMANENT_UPSTREAM.has(error.upstreamStatus)) {
        return core.inboxFail(item.id, { error: message, kind: 'permanent' });
    }
    if (item.attempts < MAX_ATTEMPTS) {
        // A site that says "too many requests" needs longer to cool off.
        const slowDown = error.upstreamStatus === 429 ? 2 : 1;
        return core.inboxRetry(item.id, nowMs + RETRY_DELAYS_MS[item.attempts - 1] * slowDown, message);
    }
    return core.inboxFail(item.id, { error: message, kind: 'retry_in_app' });
}

// True when a link (with no page text of its own) is already in the library.
async function alreadySaved(item, prefs) {
    if (item.text || !item.url || !prefs.urls?.length) return false;
    const key = canonicalUrl(item.url);
    if (!key) return false;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const hash = [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return prefs.urls.includes(hash);
}

async function processItem(core, env, item, nowMs) {
    const month = currentMonth(new Date(nowMs));
    const prefs = core.metaGet('prefs') || {};
    if (await alreadySaved(item, prefs)) {
        // No fetch, no Claude call, no quota used.
        return core.inboxComplete(item.id, { duplicate: true });
    }
    const reservation = core.reserveCapture(month, item.quotaLimit);
    if (!reservation.ok) {
        return core.inboxFail(item.id, {
            error: `You've used all ${item.quotaLimit} breakdowns for this month. They reset on the 1st.`,
            kind: 'permanent'
        });
    }
    try {
        const source = await buildSource(core, env, item, month);
        // The server doesn't keep your library, only the breakdown style and the
        // topic and concept names the app last synced, so names still get reused.
        // Connections to other notes are added when the app collects the note.
        const result = await analyze(source, [], env, prefs.depth, { concepts: prefs.concepts, topics: prefs.topics });
        await recordClaude(core, month, result.model, result.tokens);
        core.inboxComplete(item.id, pack(source, result));
    } catch (error) {
        core.releaseCapture(month);
        fail(core, item, error, nowMs);
    }
}

// Works through everything that's due, oldest first. Returns how many were
// handled. `budgetMs` keeps one run comfortably inside the platform's limit;
// whatever is left is picked up by the next run.
export async function processInbox(core, env, { now = Date.now, budgetMs = 8 * 60 * 1000, maxItems = 5 } = {}) {
    const started = now();
    let handled = 0;
    while (handled < maxItems && now() - started < budgetMs) {
        const item = core.inboxClaim(now(), LEASE_MS);
        if (!item) break;
        await processItem(core, env, item, now());
        handled++;
    }
    return handled;
}
