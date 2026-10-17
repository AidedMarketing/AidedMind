import { sourceQuality } from './source-quality.js';
// Shared, deterministic vocabulary and processing rules. Knowledge metadata
// travels with each note, so backups retain aliases and manual decisions.
export const KNOWLEDGE_VERSION = 3;
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
    const owner = note.topicByUser && note.topicId ? null : library.find((n) => n.id !== note.id && (n.topicAliases || []).some((alias) => termId(alias) === key));
    const topic = owner?.topic || canonicalName(note.topic);
    const seen = new Set();
    const concepts = (note.concepts || []).map((concept) => {
        const data = typeof concept === 'string' ? { name: concept, description: '' } : concept;
        return { ...data, name: canonicalName(data?.name), id: conceptKey(data) };
    }).filter((concept) => concept.id && !seen.has(concept.id) && seen.add(concept.id));
    return { ...note, topic, topicId: owner?.topicId || note.topicId || termId(topic), concepts,
        topicAliases: [...new Set([...(note.topicAliases || []), ...(owner?.topicAliases || [])])],
        knowledgeVersion: KNOWLEDGE_VERSION, sourceVersion: sourceVersion(note),
        sourceQuality: sourceQuality({ ...note.source, text: note.sourceText || '', confirmed: note.source?.textConfirmedVersion === sourceVersion(note) }),
        knowledgeState: sourceQuality({ ...note.source, text: note.sourceText || '', confirmed: note.source?.textConfirmedVersion === sourceVersion(note) }).status === 'ready' ? 'ready' : 'provisional' };
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
export function topicName(value) {
    const name = canonicalName(value);
    if (!termId(name) || name.length > 40) throw new Error('Use a topic name between 1 and 40 characters.');
    return name;
}
function availableTopicName(notes, value, exceptId) {
    const name = topicName(value), key = termId(name);
    if (notes.some((note) => topicIdentity(note) !== exceptId &&
        [topicIdentity(note), termId(note.topic), ...(note.topicAliases || []).map(termId)].includes(key))) {
        throw new Error('That name already belongs to a topic. Choose another name, or merge the topics.');
    }
    return name;
}
export function renameTopic(notes, id, value) {
    const name = availableTopicName(notes, value, id);
    const members = notes.filter((note) => topicIdentity(note) === id);
    if (!members.length) throw new Error('This topic has changed. Reopen Manage topics and try again.');
    const aliases = [...new Set(members.flatMap((note) => [note.topic, ...(note.topicAliases || []), name]).filter(Boolean))];
    return notes.map((note) => topicIdentity(note) === id
        ? { ...note, topic: name, topicId: id, topicAliases: aliases, topicByUser: true } : note);
}
export function splitTopic(notes, id, selectedIds, value) {
    const name = availableTopicName(notes, value);
    const selected = new Set(selectedIds);
    const members = notes.filter((note) => topicIdentity(note) === id);
    if (!selected.size || selected.size >= members.length || [...selected].some((key) => !members.some((note) => note.id === key))) {
        throw new Error('Select at least one piece and leave at least one in the original topic.');
    }
    return notes.map((note) => selected.has(note.id)
        ? { ...note, topic: name, topicId: termId(name), topicAliases: [name], topicByUser: true } : note);
}
export const topicMetadata = (note) => ({ topic: note.topic, topicId: note.topicId,
    topicAliases: note.topicAliases || [], topicByUser: note.topicByUser });
export function undoTopicChange(notes, change) {
    return notes.map((note) => {
        const after = change.after.find((saved) => saved.id === note.id);
        const before = change.before.find((saved) => saved.id === note.id);
        if (before && after && JSON.stringify(topicMetadata(note)) === JSON.stringify(topicMetadata(after))) {
            return { ...note, ...topicMetadata(before) };
        }
        // Captures made after a rename/merge share that topic's vocabulary.
        // Restore its name/aliases too, so an undone merge cannot silently
        // re-merge future captures. A split's new topic may keep later pieces.
        if (!before) {
            const inherited = change.after.find((saved) => topicIdentity(saved) === topicIdentity(note) &&
                saved.topic === note.topic && JSON.stringify(saved.topicAliases || []) === JSON.stringify(note.topicAliases || []));
            const previous = inherited && change.before.find((saved) => topicIdentity(saved) === topicIdentity(inherited));
            if (previous) return { ...note, topic: previous.topic, topicId: previous.topicId, topicAliases: previous.topicAliases || [] };
        }
        return note;
    });
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
    return note.linking?.status === 'pending' && !note.linking.paused && (note.linking.attempts || 0) < 3 && (note.linking.nextAttemptAt || 0) <= now;
}
export function failedLinking(previous = {}, now = Date.now()) {
    const attempts = (previous.attempts || 0) + 1;
    return { ...previous, status: 'pending', attempts, nextAttemptAt: now + Math.min(600000, 30000 * 4 ** (attempts - 1)) };
}
export function connectionReview(notes, activeId = null) {
    const latest = notes.filter((note) => note.linking?.reviewId)
        .sort((a, b) => (b.linking.reviewStartedAt || '').localeCompare(a.linking.reviewStartedAt || ''))[0]?.linking.reviewId;
    const members = notes.filter((note) => latest ? note.linking?.reviewId === latest : note.linking?.status === 'pending');
    const waiting = members.filter((note) => note.linking?.status === 'pending');
    const failed = waiting.filter((note) => (note.linking.attempts || 0) >= 3);
    const running = waiting.filter((note) => note.id === activeId && (note.linking.attempts || 0) < 3).length;
    return { id: latest, total: members.length, complete: members.length - waiting.length,
        failed: failed.length, running, queued: waiting.length - failed.length - running,
        paused: waiting.some((note) => note.linking.paused), pending: waiting.length, members };
}
