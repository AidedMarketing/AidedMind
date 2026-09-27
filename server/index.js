// AidedMind server: serves the PWA and exposes POST /api/capture, which extracts
// a link's content and asks Claude for a breakdown. Stateless: the library
// lives on the user's device and is sent as a compact index per request.
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { extract } = require('./lib/extract');
const { analyze } = require('./lib/analyze');
const { Inbox } = require('./lib/inbox');

const PORT = Number(process.env.PORT) || 8787;
const ACCESS_TOKEN = process.env.AIDEDMIND_ACCESS_TOKEN || '';
const WEB_ROOT = path.join(__dirname, '..', 'web');
const inbox = new Inbox(process.env.AIDEDMIND_INBOX_PATH || path.join(__dirname, 'data', 'inbox.json'));

if (!ACCESS_TOKEN) {
    console.warn('[aidedmind] AIDEDMIND_ACCESS_TOKEN is not set. /api/capture will refuse requests until it is.');
}
if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[aidedmind] ANTHROPIC_API_KEY is not set. Analysis will fail.');
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"]
        }
    }
}));

function tokensMatch(given) {
    if (!ACCESS_TOKEN || typeof given !== 'string') return false;
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(ACCESS_TOKEN).digest();
    return crypto.timingSafeEqual(a, b);
}

function requireToken(req, res, next) {
    if (!ACCESS_TOKEN) {
        return res.status(503).json({ error: 'Server is missing AIDEDMIND_ACCESS_TOKEN.' });
    }
    if (!tokensMatch(req.get('X-AidedMind-Token'))) {
        return res.status(401).json({ error: 'Wrong or missing access token. Set it in AidedMind settings.' });
    }
    next();
}

const api = express.Router();
api.use(rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }));
api.use(express.json({ limit: '2mb' }));

api.get('/health', (req, res) => {
    res.json({ ok: true, configured: Boolean(ACCESS_TOKEN && process.env.ANTHROPIC_API_KEY) });
});

api.post('/auth-check', requireToken, (req, res) => res.json({ ok: true }));

api.post('/capture', requireToken, async (req, res) => {
    const { url, text, title, library } = req.body || {};
    if ((url && typeof url !== 'string') || (text && typeof text !== 'string') || (title && typeof title !== 'string')) {
        return res.status(400).json({ error: 'url, text and title must be strings.' });
    }
    const started = Date.now();
    try {
        const source = await extract({ url: url && url.trim(), text, title });
        const result = await analyze(source, library);
        console.log(`[aidedmind] captured ${source.sourceType} in ${Date.now() - started}ms (${result.usage.input}/${result.usage.output} tokens)`);
        res.json({
            source: {
                sourceType: source.sourceType,
                url: source.url,
                title: source.title,
                author: source.author,
                siteName: source.siteName || '',
                thumbnail: source.thumbnail || '',
                partial: Boolean(source.partial),
                text: source.text
            },
            analysis: result.analysis,
            model: result.model
        });
    } catch (error) {
        const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
        if (status >= 500) console.error('[aidedmind] capture failed:', error);
        res.status(status).json({ error: status === 500 && !error.status ? 'Unexpected server error.' : error.message });
    }
});

// iOS Shortcut target: store the shared link, analyze it when the app opens.
api.post('/inbox', requireToken, (req, res) => {
    const { url, text, title } = req.body || {};
    try {
        const item = inbox.add({ url, text, title });
        res.status(201).json({ ok: true, id: item.id, message: 'Saved to AidedMind. Open the app to see the breakdown.' });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message });
    }
});

api.get('/inbox', requireToken, (req, res) => res.json({ items: inbox.list() }));

api.delete('/inbox/:id', requireToken, (req, res) => {
    res.json({ ok: inbox.remove(req.params.id) });
});

app.use('/api', api);
app.use(express.static(WEB_ROOT, {
    setHeaders(res, filePath) {
        if (filePath.endsWith('service-worker.js')) res.setHeader('Cache-Control', 'no-cache');
    }
}));
// The share target and deep links all resolve to the app shell.
app.get('/share', (req, res) => {
    res.sendFile(path.join(WEB_ROOT, 'index.html'));
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`[aidedmind] listening on http://localhost:${PORT}`));
}

module.exports = app;
