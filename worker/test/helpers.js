// Test doubles: a Durable Object namespace backed by node:sqlite (same SQL
// the real Store runs) and an Anthropic API stub.
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { StoreCore } from '../src/store-core.js';

export function sqlAdapter(db) {
    return {
        exec(query, ...bindings) {
            const statement = db.prepare(query);
            const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
            return { toArray: () => rows };
        }
    };
}

export function fakeEnv(overrides = {}) {
    const instances = new Map();
    return {
        OWNER_TOKEN: 'owner-secret',
        ANTHROPIC_API_KEY: 'test-key',
        FREE_MONTHLY_CAPTURES: '2',
        STORE: {
            idFromName: (name) => name,
            get: (id) => {
                if (!instances.has(id)) instances.set(id, Object.assign(new StoreCore(sqlAdapter(new DatabaseSync(':memory:'))), { ping: () => 'ok' }));
                return instances.get(id);
            }
        },
        ASSETS: { fetch: async () => new Response('<title>AidedMind</title>', { headers: { 'Content-Type': 'text/html' } }) },
        ...overrides
    };
}

export function sqlStore() {
    return new StoreCore(sqlAdapter(new DatabaseSync(':memory:')));
}

export async function anthropicStub(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            const parsed = body ? JSON.parse(body) : null;
            requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
            const { status = 200, json } = handler(req, parsed);
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(json));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

export function call(app, env, method, path, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-AidedMind-Token'] = token;
    return app.fetch(new Request(`https://aidedmind.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
