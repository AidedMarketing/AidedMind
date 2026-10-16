// Shared, deterministic vocabulary and processing rules. Knowledge metadata
// travels with each note, so backups retain aliases and manual decisions.
export const KNOWLEDGE_VERSION = 2;
const TERMS = [
    ['Artificial Intelligence', 'AI'], ['Machine Learning', 'ML'],
    ['Large Language Models', 'LLM', 'LLMs', 'Large Language Model'],
    ['Search Engine Optimization', 'SEO'], ['User Experience', 'UX']
];
export const nameKey = (value) => String(value || '').normalize('NFKC').trim().toLowerCase().replace(/[-_\s]+/g, ' ');
const vocabulary = new Map(TERMS.flatMap(([name, ...aliases]) => [name, ...aliases].map((alias) => [nameKey(alias), name])));
export function canonicalName(value) {
    const clean = String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    return vocabulary.get(nameKey(clean)) || clean;
}
export function termId(value) {
    return nameKey(canonicalName(value)).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}
export function conceptKey(concept) {
    return termId(typeof concept === 'string' ? concept : concept?.name);
}
export function topicIdentity(note) {
    return note?.topicId || termId(note?.topic);
}
export function sourceVersion(note) {
    const text = String(note?.sourceText || '');
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return `${text.length}-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}
export function normalizeKnowledge(note, library = []) {
    const key = termId(note.topic);
    // Explicit merged aliases take precedence over the built-in vocabulary.
    const owner = library.find((n) => n.id !== note.id && (n.topicAliases || []).some((alias) => termId(alias) === key));
    const topic = owner?.topic || canonicalName(note.topic);
    const seen = new Set();
    const concepts = (note.concepts || []).map((concept) => {
        const data = typeof concept === 'string' ? { name: concept, description: '' } : concept;
        return { ...data, name: canonicalName(data?.name), id: conceptKey(data) };
    }).filter((concept) => concept.id && !seen.has(concept.id) && seen.add(concept.id));
    return { ...note, topic, topicId: owner?.topicId || note.topicId || termId(topic), concepts,
        topicAliases: [...new Set([...(note.topicAliases || []), ...(owner?.topicAliases || [])])],
        knowledgeVersion: KNOWLEDGE_VERSION, sourceVersion: sourceVersion(note),
        knowledgeState: note.source?.partial ? 'provisional' : 'ready' };
}
export function mergeTopics(notes, fromId, toId) {
    const from = notes.filter((n) => topicIdentity(n) === fromId);
    const target = notes.find((n) => topicIdentity(n) === toId);
    if (!from.length || !target || fromId === toId) return notes;
    const aliases = [...new Set([...from, ...notes.filter((n) => topicIdentity(n) === toId)]
        .flatMap((n) => [n.topic, ...(n.topicAliases || [])]).filter(Boolean))];
    return notes.map((note) => [fromId, toId].includes(topicIdentity(note))
        ? { ...note, topic: target.topic, topicId: toId, topicAliases: aliases, topicByUser: true } : note);
}
export function linkBlocked(a, b) {
    const blocked = (note, id) => (note?.removedLinks || []).includes(id) ||
        (note?.rejectedLinks || []).some((entry) => (typeof entry === 'string' ? entry : entry?.noteId) === id);
    return blocked(a, b?.id) || blocked(b, a?.id);
}
export function mergeConnections(fresh = [], previous = []) {
    const links = new Map(fresh.map((link) => [link.noteId, link]));
    previous.filter((link) => link.origin === 'user').forEach((link) => links.set(link.noteId, link));
    return [...links.values()];
}
export function matchesNote(note, query) {
    const expand = (value) => nameKey(String(value || '').replace(/\b(?:ai|ml|llms?|seo|ux)\b/gi, (word) => canonicalName(word)));
    const q = expand(query);
    return !q || expand([note.title, note.topic, note.tldr, ...(note.tags || []),
        ...(note.topicAliases || []), ...(note.concepts || []).map((c) => typeof c === 'string' ? c : c.name)].join(' ')).includes(q);
}

export function retryDue(note, now = Date.now()) {
    return note.linking?.status === 'pending' && (note.linking.attempts || 0) < 3 && (note.linking.nextAttemptAt || 0) <= now;
}
export function failedLinking(previous = {}, now = Date.now()) {
    const attempts = (previous.attempts || 0) + 1;
    return { status: 'pending', attempts, nextAttemptAt: now + Math.min(600000, 30000 * 4 ** (attempts - 1)) };
}
