// Storage logic for one Durable Object instance, written against the
// Durable Object SQL API (`sql.exec(query, ...bindings)`). Each user gets
// their own instance (inbox + usage); a single "directory" instance maps
// access-token hashes to users.
const INBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INBOX_MAX = 200;
const MAX_TEXT = 600000;

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

    inboxAdd({ url, text, title }) {
        const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
        const item = {
            id: crypto.randomUUID(),
            url: clean(url, 4096),
            text: clean(text, MAX_TEXT),
            title: clean(title, 300),
            received_at: new Date().toISOString()
        };
        if (!item.url && !item.text) return null;
        this.sql.exec('INSERT INTO inbox (id, url, text, title, received_at) VALUES (?, ?, ?, ?, ?)',
            item.id, item.url, item.text, item.title, item.received_at);
        this.sql.exec(`DELETE FROM inbox WHERE id NOT IN (SELECT id FROM inbox ORDER BY received_at DESC LIMIT ${INBOX_MAX})`);
        return item;
    }

    inboxList() {
        const cutoff = new Date(Date.now() - INBOX_TTL_MS).toISOString();
        this.sql.exec('DELETE FROM inbox WHERE received_at < ?', cutoff);
        return this.rows('SELECT id, url, text, title, received_at FROM inbox ORDER BY received_at')
            .map((row) => ({ id: row.id, url: row.url, text: row.text, title: row.title, receivedAt: row.received_at }));
    }

    inboxRemove(id) {
        const before = this.rows('SELECT COUNT(*) AS n FROM inbox WHERE id = ?', id)[0].n;
        this.sql.exec('DELETE FROM inbox WHERE id = ?', id);
        return before > 0;
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
