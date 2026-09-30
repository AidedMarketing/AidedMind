// Validate the entire backup before opening a write transaction. Existing IDs
// are preserved: restoring is additive, never an implicit overwrite.
export function prepareRestore(data, existing) {
    if (!Array.isArray(data) && (!data || data.version !== 1 || !Array.isArray(data.notes))) {
        throw new Error('Use an AidedMind version 1 backup.');
    }
    const incoming = Array.isArray(data) ? data : data.notes;
    if (incoming.length > 20000) throw new Error('This backup contains too many notes.');
    const ids = new Set();
    const isText = (x) => typeof x === 'string';
    const date = (x) => isText(x) && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(x) && Number.isFinite(Date.parse(x));
    for (const n of incoming) {
        if (!n || !isText(n.id) || !n.id.trim() || n.id.length > 200 || !isText(n.title) || !n.title.trim() || !date(n.createdAt) || (n.updatedAt !== undefined && !date(n.updatedAt)) || ids.has(n.id)) {
            throw new Error('The backup contains an invalid or repeated note. No notes were changed.');
        }
        ids.add(n.id);
        for (const field of ['tldr', 'userNotes', 'topic']) if (n[field] !== undefined && !isText(n[field])) throw new Error(`Invalid ${field} in “${n.title}”.`);
        for (const field of ['tags', 'quotes', 'takeaways', 'removedLinks']) if (n[field] !== undefined && (!Array.isArray(n[field]) || !n[field].every(isText))) throw new Error(`Invalid ${field} in “${n.title}”.`);
        for (const [field, keys] of Object.entries({ summary: ['heading', 'body'], outline: ['text'], concepts: ['name', 'description'], connections: ['noteId', 'relation', 'reason'] })) {
            if (n[field] !== undefined && (!Array.isArray(n[field]) || !n[field].every((v) => v && keys.every((key) => isText(v[key]))))) throw new Error(`Invalid ${field} in “${n.title}”.`);
        }
        if (n.source !== undefined) {
            if (!n.source || typeof n.source !== 'object' || Array.isArray(n.source)) throw new Error('Invalid source in backup.');
            for (const key of ['url', 'sharedUrl', 'title', 'text', 'sourceType', 'author', 'siteName']) if (n.source[key] !== undefined && !isText(n.source[key])) throw new Error('Invalid source text in backup.');
        }
    }
    const saved = new Set(existing.map((n) => n.id));
    const additions = incoming.filter((n) => !saved.has(n.id));
    return { additions, skipped: incoming.length - additions.length };
}
