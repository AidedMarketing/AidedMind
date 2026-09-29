// Storage logic for one Durable Object instance, written against the
// Durable Object SQL API (`sql.exec(query, ...bindings)`). Each user gets
// their own instance (inbox + usage); a single "directory" instance maps
// access-token hashes to users.
const INBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INBOX_MAX = 200;
const MAX_TEXT = 600000;

// Columns added to the inbox after it first shipped; existing tables get them
// on first use. `queued` marks items the server processes in the background
// (older rows are 0 and are still handled by the app when it opens).
const INBOX_COLUMNS = {
    status: "TEXT NOT NULL DEFAULT 'pending'",
    queued: 'INTEGER NOT NULL DEFAULT 0',
    attempts: 'INTEGER NOT NULL DEFAULT 0',
    next_attempt_at: "TEXT NOT NULL DEFAULT ''",
    error: "TEXT NOT NULL DEFAULT ''",
    error_kind: "TEXT NOT NULL DEFAULT ''",
    result: "TEXT NOT NULL DEFAULT ''",
    quota_limit: 'INTEGER NOT NULL DEFAULT -1'
};

export class StoreCore {
    constructor(sql) {
        this.sql = sql;
        sql.exec(`CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            token_hash TEXT NOT NULL UNIQUE,
            plan TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL
        )`);
        sql.exec(`CREATE TABLE IF NOT EXISTS inbox (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            received_at TEXT NOT NULL
        )`);
        const have = new Set(sql.exec('PRAGMA table_info(inbox)').toArray().map((column) => column.name));
        Object.entries(INBOX_COLUMNS).forEach(([name, definition]) => {
            if (!have.has(name)) sql.exec(`ALTER TABLE inbox ADD COLUMN ${name} ${definition}`);
        });
        sql.exec(`CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`);
        sql.exec(`CREATE TABLE IF NOT EXISTS transcripts (
            key TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL
        )`);
        sql.exec(`CREATE TABLE IF NOT EXISTS costs (
            month TEXT NOT NULL,
            item TEXT NOT NULL,
            amount REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (month, item)
        )`);
        sql.exec(`CREATE TABLE IF NOT EXISTS usage (
            month TEXT PRIMARY KEY,
            captures INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0
        )`);
    }

    rows(query, ...bindings) {
        return this.sql.exec(query, ...bindings).toArray();
    }

    // ----- directory -----

    findUser(tokenHash) {
        const [row] = this.rows('SELECT id, plan, label, status FROM users WHERE token_hash = ?', tokenHash);
        return row || null;
    }

    createUser({ id, tokenHash, plan, label }) {
        this.sql.exec(
            'INSERT INTO users (id, token_hash, plan, label, created_at) VALUES (?, ?, ?, ?, ?)',
            id, tokenHash, plan, label || '', new Date().toISOString()
        );
        return { id, plan, label: label || '', status: 'active' };
    }

    listUsers() {
        return this.rows('SELECT id, plan, label, status, created_at FROM users ORDER BY created_at');
    }

    updateUser(id, { plan, status }) {
        if (plan) this.sql.exec('UPDATE users SET plan = ? WHERE id = ?', plan, id);
        if (status) this.sql.exec('UPDATE users SET status = ? WHERE id = ?', status, id);
        const [row] = this.rows('SELECT id, plan, label, status FROM users WHERE id = ?', id);
        return row || null;
    }

    // ----- inbox -----
    //
    // A shared link is queued for the server to break down while the app is
    // closed: pending → processing → done (the finished note waits here until
    // the app collects it) or failed. `queued` items with a limit of null
    // are unlimited (owner and unlimited plans).

    inboxAdd({ url, text, title }, { limit = null, queue = true } = {}) {
        const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
        const now = new Date().toISOString();
        const item = {
            id: crypto.randomUUID(),
            url: clean(url, 4096),
            text: clean(text, MAX_TEXT),
            title: clean(title, 300),
            received_at: now
        };
        if (!item.url && !item.text) return null;
        this.sql.exec(`INSERT INTO inbox (id, url, text, title, received_at, status, queued, next_attempt_at, quota_limit)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        item.id, item.url, item.text, item.title, now, queue ? 1 : 0, now, limit === null ? -1 : Number(limit));
        this.sql.exec(`DELETE FROM inbox WHERE id NOT IN (SELECT id FROM inbox ORDER BY received_at DESC LIMIT ${INBOX_MAX})`);
        return { ...item, status: 'pending', queued: Boolean(queue) };
    }

    inboxList() {
        const cutoff = new Date(Date.now() - INBOX_TTL_MS).toISOString();
        this.sql.exec('DELETE FROM inbox WHERE received_at < ?', cutoff);
        return this.rows('SELECT * FROM inbox ORDER BY received_at').map((row) => {
            let result = null;
            if (row.status === 'done' && row.result) {
                try {
                    result = JSON.parse(row.result);
                } catch {
                    result = null;
                }
            }
            return {
                id: row.id,
                url: row.url,
                // A finished item's input is no longer needed.
                text: row.status === 'done' ? '' : row.text,
                title: row.title,
                receivedAt: row.received_at,
                queued: row.queued === 1,
                status: row.status === 'done' && !result ? 'failed' : row.status,
                attempts: row.attempts,
                nextRetryAt: row.status === 'pending' && row.queued === 1 ? row.next_attempt_at : null,
                error: row.error,
                errorKind: row.error_kind,
                result
            };
        });
    }

    inboxRemove(id) {
        const before = this.rows('SELECT COUNT(*) AS n FROM inbox WHERE id = ?', id)[0].n;
        this.sql.exec('DELETE FROM inbox WHERE id = ?', id);
        return before > 0;
    }

    inboxUpdate(id, { text = '', title = '' } = {}) {
        const [item] = this.rows('SELECT status FROM inbox WHERE id = ?', id);
        if (!item || !['failed', 'pending'].includes(item.status)) return false;
        const content = String(text || '').trim().slice(0, MAX_TEXT);
        if (content) {
            this.sql.exec("UPDATE inbox SET text = ?, title = CASE WHEN ? = '' THEN title ELSE ? END, received_at = ?, status = 'pending', attempts = 0, next_attempt_at = ?, error = '', error_kind = '' WHERE id = ?",
                content, String(title || '').trim(), String(title || '').trim().slice(0, 300), new Date().toISOString(), new Date().toISOString(), id);
        } else {
            this.sql.exec("UPDATE inbox SET status = 'pending', attempts = 0, next_attempt_at = ?, error = '', error_kind = '' WHERE id = ?",
                new Date().toISOString(), id);
        }
        return true;
    }

    // Takes the oldest queued item that is due and marks it in progress. The
    // "lease" keeps another run from taking it, and expires if this one dies.
    inboxClaim(nowMs, leaseMs) {
        const now = new Date(nowMs).toISOString();
        const [row] = this.rows(`SELECT id, url, text, title, attempts, quota_limit FROM inbox
            WHERE queued = 1 AND status IN ('pending', 'processing') AND next_attempt_at <= ?
            ORDER BY received_at LIMIT 1`, now);
        if (!row) return null;
        this.sql.exec("UPDATE inbox SET status = 'processing', attempts = attempts + 1, next_attempt_at = ? WHERE id = ?",
            new Date(nowMs + leaseMs).toISOString(), row.id);
        return { id: row.id, url: row.url, text: row.text, title: row.title, attempts: row.attempts + 1, quotaLimit: row.quota_limit < 0 ? null : row.quota_limit };
    }

    // When the next queued item is due (ms since epoch), or null.
    inboxNextDue() {
        const [row] = this.rows("SELECT MIN(next_attempt_at) AS due FROM inbox WHERE queued = 1 AND status IN ('pending', 'processing')");
        return row?.due ? new Date(row.due).getTime() : null;
    }

    inboxComplete(id, result) {
        this.sql.exec("UPDATE inbox SET status = 'done', result = ?, text = '', error = '', error_kind = '' WHERE id = ?", JSON.stringify(result), id);
    }

    inboxRetry(id, atMs, error) {
        this.sql.exec("UPDATE inbox SET status = 'pending', next_attempt_at = ?, error = ? WHERE id = ?", new Date(atMs).toISOString(), String(error || '').slice(0, 300), id);
    }

    inboxFail(id, { error, kind }) {
        this.sql.exec("UPDATE inbox SET status = 'failed', error = ?, error_kind = ? WHERE id = ?", String(error || '').slice(0, 300), kind || 'permanent', id);
    }

    // ----- small settings the app syncs (breakdown style, known names) -----

    metaGet(key) {
        const [row] = this.rows('SELECT value FROM meta WHERE key = ?', key);
        if (!row) return null;
        try {
            return JSON.parse(row.value);
        } catch {
            return null;
        }
    }

    metaSet(key, value) {
        this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    }

    // ----- transcript cache (so a retried link never pays twice) -----

    transcriptGet(key) {
        const cutoff = new Date(Date.now() - INBOX_TTL_MS).toISOString();
        this.sql.exec('DELETE FROM transcripts WHERE created_at < ?', cutoff);
        const [row] = this.rows('SELECT data FROM transcripts WHERE key = ?', key);
        if (!row) return null;
        try {
            return JSON.parse(row.data);
        } catch {
            return null;
        }
    }

    transcriptPut(key, source) {
        this.sql.exec(`INSERT INTO transcripts (key, data, created_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`,
        key, JSON.stringify(source), new Date().toISOString());
    }

    // ----- cost ledger: token and request counts per service per month -----

    addCost(month, item, amount) {
        const value = Number(amount) || 0;
        if (!value) return;
        this.sql.exec(`INSERT INTO costs (month, item, amount) VALUES (?, ?, ?)
            ON CONFLICT(month, item) DO UPDATE SET amount = amount + excluded.amount`, month, String(item).slice(0, 120), value);
    }

    costsFor(month) {
        return this.rows('SELECT item, amount FROM costs WHERE month = ? ORDER BY item', month);
    }

    // ----- usage -----

    usageFor(month) {
        const [row] = this.rows('SELECT captures, input_tokens, output_tokens FROM usage WHERE month = ?', month);
        return row ? { captures: row.captures, inputTokens: row.input_tokens, outputTokens: row.output_tokens } : { captures: 0, inputTokens: 0, outputTokens: 0 };
    }

    // Reserves one capture if the month's limit allows it. Durable Objects run
    // one request at a time, so check-and-increment cannot race.
    reserveCapture(month, limit) {
        const current = this.usageFor(month).captures;
        if (limit !== null && current >= limit) return { ok: false, captures: current };
        this.sql.exec(`INSERT INTO usage (month, captures) VALUES (?, 1)
            ON CONFLICT(month) DO UPDATE SET captures = captures + 1`, month);
        return { ok: true, captures: current + 1 };
    }

    releaseCapture(month) {
        this.sql.exec('UPDATE usage SET captures = MAX(captures - 1, 0) WHERE month = ?', month);
    }

    recordTokens(month, input, output) {
        this.sql.exec('UPDATE usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE month = ?',
            Number(input) || 0, Number(output) || 0, month);
    }
}
