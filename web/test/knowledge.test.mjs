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
    const notes = [piece('a', 'One', { concepts: [{ name: 'Specific idea' }], removedLinks: ['c'] }),
        piece('b', 'Two', { concepts: [{ name: 'Specific idea' }], connections: [{ noteId: 'c', confidence: .9 }] }), piece('c', 'Three'), piece('d', 'Four')];
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
