import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKnowledge, topicIdentity, mergeTopics, matchesNote, sourceVersion, retryDue, failedLinking } from '../js/knowledge.js';
import { preserveUpdatedNote, relatedNotes } from '../js/library.js';
import { buildThemes } from '../js/themes.js';
import { buildGraph, GraphView } from '../js/graph.js';
import { evidencePassages } from '../js/api.js';

const piece = (id, topic, extra = {}) => ({ id, title: id, topic, tags: [], concepts: [], connections: [], createdAt: '2026-10-01', ...extra });
test('canonical aliases merge acronyms without conflating related concepts', () => {
    const a = normalizeKnowledge(piece('a', 'AI', { concepts: [{ name: 'LLM' }, { name: 'Large Language Models' }, { name: 'Neuroplasticity' }] }));
    const b = normalizeKnowledge(piece('b', 'Artificial Intelligence'));
    assert.equal(a.topicId, b.topicId);
    assert.equal(a.concepts.length, 2);
    assert.equal(a.concepts[1].name, 'Neuroplasticity');
    assert.equal(buildThemes([a, b]).themes.length, 1);
    assert.ok(matchesNote(a, 'AI'));
    assert.ok(matchesNote(a, 'LLM'));
    assert.ok(matchesNote(piece('title', 'News', { title: 'AI: a new tool' }), 'AI'));
    assert.equal(matchesNote(piece('unrelated', 'News', { title: 'Paid subscriptions' }), 'AI'), false);
});
test('merged aliases survive backup and classify subsequent captures', () => {
    const notes = ['Habit building', 'Habit formation'].map((topic, i) => normalizeKnowledge(piece(String(i), topic)));
    const merged = JSON.parse(JSON.stringify(mergeTopics(notes, topicIdentity(notes[0]), topicIdentity(notes[1]))));
    const incoming = normalizeKnowledge(piece('new', 'Habit building'), merged);
    assert.equal(incoming.topic, 'Habit formation');
    assert.equal(incoming.topicId, merged[1].topicId);
    assert.equal(merged[0].topicByUser, true);
    assert.ok(matchesNote(incoming, 'habit building'));
});
test('normalization is idempotent and marks partial knowledge provisional', () => {
    const old = piece('a', 'AI', { sourceText: 'Original source', source: { partial: true } });
    const normalized = normalizeKnowledge(old);
    assert.deepEqual(normalizeKnowledge(normalized), normalized);
    assert.equal(normalized.knowledgeState, 'provisional');
    assert.notEqual(sourceVersion(old), sourceVersion({ ...old, sourceText: 'Changed source' }));
});
test('source updates refresh automatic links and retain manual decisions', () => {
    const before = piece('saved', 'Learning', { topicByUser: true, removedLinks: ['blocked'], connections: [
        { noteId: 'manual', origin: 'user', reason: 'My reason' }, { noteId: 'old', origin: 'aidedmind', reason: 'Obsolete' },
        { noteId: 'same', origin: 'aidedmind', reason: 'Old explanation' }
    ] });
    const after = preserveUpdatedNote(piece('fresh', 'Other', { connections: [{ noteId: 'same', origin: 'aidedmind', reason: 'New explanation' }] }), before);
    assert.equal(after.id, 'saved');
    assert.equal(after.topic, 'Learning');
    assert.deepEqual(after.removedLinks, ['blocked']);
    assert.equal(after.connections.find((c) => c.noteId === 'same').reason, 'New explanation');
    assert.equal(after.connections.find((c) => c.noteId === 'manual').reason, 'My reason');
    assert.equal(after.connections.some((c) => c.noteId === 'old'), false);
});
test('common concepts cannot turn a focused map into the entire library', () => {
    const notes = Array.from({ length: 24 }, (_, i) => piece(`n${i}`, `Subject ${Math.floor(i / 2)}`, { concepts: [{ name: 'AI' }] }));
    const graph = buildGraph(notes, { themes: buildThemes(notes), focusId: 'n0' });
    assert.equal(graph.shownNotes, 1);
    assert.equal(graph.links.length, 0);
});
test('focused concepts expand by note distance and respect rejected pairs', () => {
    const notes = [piece('a', 'One', { sourceText: 'A specific idea developed in this captured source.', concepts: [{ name: 'Specific idea', evidence: 'A specific idea developed in this captured source.' }], removedLinks: ['c'] }),
        piece('b', 'Two', { sourceText: 'A specific idea developed in this captured source.', concepts: [{ name: 'Specific idea', evidence: 'A specific idea developed in this captured source.' }], connections: [{ noteId: 'c', confidence: .9 }] }), piece('c', 'Three'), piece('d', 'Four')];
    assert.deepEqual(buildGraph(notes, { focusId: 'a', depth: 1 }).nodes.filter((n) => n.isNote).map((n) => n.id), ['a', 'b']);
    assert.equal(buildGraph(notes, { focusId: 'a', depth: 3 }).nodes.some((n) => n.id === 'c'), false);
    notes[0].removedLinks = [];
    assert.equal(buildGraph(notes, { focusId: 'a', depth: 2 }).nodes.some((n) => n.id === 'c'), true);
});
test('focus budgets prevent an inbound hub from flooding the view', () => {
    const notes = [piece('hub', 'Main'), ...Array.from({ length: 100 }, (_, i) => piece(`n${i}`, 'Main', { connections: [{ noteId: 'hub', confidence: .9 }] }))];
    const graph = buildGraph(notes, { focusId: 'hub', depth: 1, maxNotes: 16 });
    assert.equal(graph.shownNotes, 16);
    assert.equal(graph.totalNotes, 101);
    assert.equal(buildGraph(notes, { focusId: 'hub', depth: 2, maxNotes: 48 }).shownNotes, 48);
});
test('canvas and text list share filtering by concepts, aliases, and summaries', () => {
    const notes = [piece('a', 'Learning', { tldr: 'Memory improves with practice', concepts: [{ name: 'Spacing effect' }] }), piece('b', 'Marketing')];
    for (const query of ['memory', 'spacing']) {
        const graph = buildGraph(notes, { query });
        assert.deepEqual(graph.nodes.filter((n) => n.isNote).map((n) => n.id), notes.filter((n) => matchesNote(n, query)).map((n) => n.id));
    }
});
test('single-piece topics are browsable and membership survives unrelated growth', () => {
    const notes = [piece('a', 'Learning'), piece('b', 'Marketing')];
    const before = buildThemes(notes);
    const grown = buildThemes([...notes, ...Array.from({ length: 20 }, (_, i) => piece(`m${i}`, 'Marketing'))]);
    assert.equal(before.byNote.get('a'), grown.byNote.get('a'));
    assert.ok(before.byNote.has('a'));
});
test('persisted neighborhood anchors never move when another topic becomes largest', () => {
    const layout = { anchors: {}, positions: {} };
    const fake = (groups) => ({ nodes: groups.flatMap(([id, count]) => Array.from({ length: count }, () => ({ isNote: true, layoutGroup: id }))),
        themes: groups.map(([id]) => ({ id })), layout });
    const before = GraphView.prototype.computeClusterAnchors.call(fake([['alpha', 3], ['beta', 2]]));
    const after = GraphView.prototype.computeClusterAnchors.call(fake([['beta', 8], ['new', 5], ['alpha', 3]]));
    assert.deepEqual(after.get('alpha'), before.get('alpha'));
    assert.deepEqual(after.get('beta'), before.get('beta'));
});
test('failed linking persists bounded retries separately from capture', () => {
    const first = failedLinking({}, 1000);
    assert.equal(retryDue({ linking: first }, 1001), false);
    assert.equal(retryDue({ linking: first }, first.nextAttemptAt), true);
    const exhausted = failedLinking(failedLinking(first, 2000), 3000);
    assert.equal(exhausted.status, 'pending');
    assert.equal(retryDue({ linking: exhausted }, 9999999), false);
});
test('candidate evidence consists only of original captured passages', () => {
    const text = 'A source passage about marketing strategy. Another original passage about spaced practice and memory.';
    const passages = evidencePassages(text, 'spaced practice memory');
    assert.match(passages[0], /spaced practice/);
    assert.ok(passages.every((p) => text.includes(p)));
});

test('candidate retrieval recognizes canonical topics and acronym aliases', () => {
    const notes = [piece('relevant', 'Artificial Intelligence', { title: 'A useful collection' }),
        ...Array.from({ length: 30 }, (_, i) => piece(`other${i}`, 'Woodworking', { title: 'Another piece', createdAt: '2026-10-16' }))];
    assert.equal(relatedNotes(notes, { text: 'AI' }, { limit: 1 })[0].id, 'relevant');
});

test('rename retains topic identity and aliases for future captures', async () => {
    const { renameTopic } = await import('../js/knowledge.js');
    const original = [normalizeKnowledge(piece('a', 'Learning')), normalizeKnowledge(piece('b', 'Learning'))];
    const renamed = JSON.parse(JSON.stringify(renameTopic(original, original[0].topicId, 'Memory and practice')));
    assert.equal(renamed[0].topicId, original[0].topicId);
    assert.equal(renamed[0].topicByUser, true);
    for (const name of ['Learning', 'Memory and practice']) {
        const incoming = normalizeKnowledge(piece('new', name), renamed);
        assert.equal(incoming.topic, 'Memory and practice');
        assert.equal(incoming.topicId, original[0].topicId);
    }
    assert.equal(normalizeKnowledge(renamed[0], renamed).topic, 'Memory and practice');
});
test('split moves selected pieces without making the broad topic an alias', async () => {
    const { splitTopic } = await import('../js/knowledge.js');
    const original = ['a', 'b', 'c'].map((id) => normalizeKnowledge(piece(id, 'Marketing')));
    const split = splitTopic(original, 'marketing', ['b', 'c'], 'Brand strategy');
    assert.equal(split[0], original[0]);
    assert.equal(split[1].topicId, 'brand-strategy');
    assert.deepEqual(split[1].topicAliases, ['Brand strategy']);
    assert.equal(normalizeKnowledge(piece('new', 'Marketing'), split).topic, 'Marketing');
    assert.equal(normalizeKnowledge(split[1], split).topic, 'Brand strategy');
});
test('topic edits reject ambiguous names, empty selections and stale pieces', async () => {
    const { renameTopic, splitTopic } = await import('../js/knowledge.js');
    const original = [normalizeKnowledge(piece('a', 'Learning')), normalizeKnowledge(piece('b', 'Learning')), normalizeKnowledge(piece('c', 'AI'))];
    assert.throws(() => renameTopic(original, 'learning', 'AI'), /already belongs/);
    assert.throws(() => renameTopic(original, 'learning', '  '), /between 1 and 40/);
    assert.throws(() => splitTopic(original, 'learning', [], 'Memory'), /Select at least one/);
    assert.throws(() => splitTopic(original, 'learning', ['a', 'b'], 'Memory'), /Select at least one/);
    assert.throws(() => splitTopic(original, 'learning', ['c'], 'Memory'), /Select at least one/);
    assert.throws(() => splitTopic(original, 'learning', ['a'], 'Learning'), /already belongs/);
    assert.throws(() => renameTopic(original, 'gone', 'Memory'), /has changed/);
});
test('topic Undo preserves intervening content, links and separate topic choices', async () => {
    const { renameTopic, undoTopicChange } = await import('../js/knowledge.js');
    const before = ['a', 'b'].map((id) => normalizeKnowledge(piece(id, 'Learning')));
    const after = renameTopic(before, 'learning', 'Memory');
    const current = [{ ...after[0], userNotes: 'New thought', connections: [{ noteId: 'b', origin: 'user' }] },
        { ...after[1], topic: 'Other', topicId: 'other', topicAliases: [] }, normalizeKnowledge(piece('new', 'Memory'), after)];
    const undone = undoTopicChange(current, { before, after });
    assert.equal(undone[0].topic, 'Learning');
    assert.equal(undone[0].userNotes, 'New thought');
    assert.equal(undone[0].connections[0].origin, 'user');
    assert.equal(undone[1].topic, 'Other');
    assert.equal(undone[2].topic, 'Learning');
});
test('Undo removes merged aliases from later captures so future pieces stay separate', async () => {
    const { undoTopicChange } = await import('../js/knowledge.js');
    const before = [normalizeKnowledge(piece('a', 'Habits')), normalizeKnowledge(piece('b', 'Habit formation'))];
    const after = mergeTopics(before, 'habits', 'habit-formation');
    const later = normalizeKnowledge(piece('new', 'Habits'), after);
    const undone = undoTopicChange([...after, later], { before, after });
    assert.equal(undone[2].topic, 'Habit formation');
    assert.deepEqual(undone[2].topicAliases, []);
    assert.equal(normalizeKnowledge(piece('next', 'Habits'), undone).topic, 'Habits');
});
test('paused connection reviews retain their queue and retry metadata', async () => {
    const { connectionReview } = await import('../js/knowledge.js');
    const linking = { status: 'pending', attempts: 0, paused: true, reviewId: 'r', reviewStartedAt: '2026-10-16' };
    assert.equal(retryDue({ linking }, 999999), false);
    const failed = failedLinking(linking, 0);
    assert.equal(failed.reviewId, 'r');
    assert.equal(failed.paused, true);
    const notes = [piece('a', '', { linking }), piece('b', '', { linking: { ...linking, status: 'complete' } }),
        piece('c', '', { linking: { ...linking, attempts: 3 } })];
    const review = connectionReview(notes, 'a');
    assert.deepEqual([review.total, review.complete, review.running, review.queued, review.failed, review.paused], [3, 1, 1, 0, 1, true]);
});
test('review totals survive backup and exclude an older review', async () => {
    const { connectionReview } = await import('../js/knowledge.js');
    const notes = [piece('a', '', { linking: { reviewId: 'old', reviewStartedAt: '2026-10-15', status: 'complete' } }),
        piece('b', '', { linking: { reviewId: 'new', reviewStartedAt: '2026-10-16', status: 'pending', attempts: 3 } })];
    const review = connectionReview(JSON.parse(JSON.stringify(notes)));
    assert.equal(review.id, 'new'); assert.equal(review.total, 1); assert.equal(review.failed, 1);
});
