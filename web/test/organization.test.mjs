import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceQuality } from '../js/source-quality.js';
import { queueOrganization, applyOrganization, undoOrganization, organizationStamp } from '../js/organization.js';
import { buildGraph } from '../js/graph.js';

const text = 'Spaced repetition improves recall by separating practice across days.';
const piece = (id, extra = {}) => ({ id, title: id, source: { sourceType: 'text' }, sourceText: text,
    topic: 'Personal Development', topicId: 'personal-development', concepts: [], tags: [], connections: [], ...extra });
const ready = (notes) => queueOrganization(notes, 'review', '2026-10-17').map((note) => ({ ...note, organizationReview: {
    ...note.organizationReview, status: 'ready', proposal: { topic: 'Memory', concepts: [
        { name: 'Spaced repetition', description: 'Separating practice over days.', evidence: text }], tags: ['memory'], quality: { status: 'ready' } }
} }));

test('short articles are review flags while short original notes remain valid', () => {
    assert.equal(sourceQuality({ sourceType: 'article', text }).status, 'needs-review');
    assert.equal(sourceQuality({ sourceType: 'text', text }).status, 'ready');
    assert.equal(sourceQuality({ sourceType: 'tiktok', text, partial: true }).status, 'needs-review');
});
test('organization proposals preserve manual topics, personal text, links and source identity', () => {
    const before = ready([piece('a'), piece('b', { topic: 'Marketing', topicId: 'marketing', topicByUser: true, userNotes: 'My note',
        connections: [{ noteId: 'a', origin: 'user' }], rejectedLinks: [{ noteId: 'x' }] })]);
    const result = applyOrganization(before, ['a', 'b'], 'review', 'links', '2026-10-17');
    assert.equal(result.applied, 2);
    assert.equal(result.notes[0].topic, 'Memory');
    assert.equal(result.notes[1].topic, 'Marketing');
    assert.equal(result.notes[1].topicByUser, true);
    assert.equal(result.notes[1].userNotes, 'My note');
    assert.equal(result.notes[1].connections[0].origin, 'user');
    assert.deepEqual(result.notes[1].rejectedLinks, [{ noteId: 'x' }]);
    assert.equal(result.notes[1].sourceText, text);
    assert.equal(result.notes[0].linking.status, 'pending');
    assert.equal(result.notes[0].organizationReview.status, 'applied');
});
test('changed sources or manual topic decisions invalidate previews without overwriting them', () => {
    const before = ready([piece('a'), piece('b')]);
    before[0].sourceText = 'New source replaces the old source.';
    before[1].topicByUser = true;
    const result = applyOrganization(before, ['a', 'b'], 'review', 'links', '2026-10-17');
    assert.equal(result.applied, 0);
    assert.equal(result.stale, 2);
    assert.equal(result.notes[0].sourceText, before[0].sourceText);
    assert.equal(result.notes[1].topicByUser, true);
});
test('selection is explicit and proposals from a superseded review cannot apply', () => {
    const before = ready([piece('a'), piece('b')]);
    assert.equal(applyOrganization(before, ['a'], 'old-review', 'links', '2026-10-17').applied, 0);
    const result = applyOrganization(before, ['a'], 'review', 'links', '2026-10-17');
    assert.equal(result.applied, 1);
    assert.equal(result.notes[1].topic, 'Personal Development');
});
test('Undo restores only unchanged metadata and preserves subsequent personal notes', () => {
    const before = ready([piece('a'), piece('b')]);
    const { notes } = applyOrganization(before, ['a', 'b'], 'review', 'links', '2026-10-17');
    notes[0].userNotes = 'Written after the cleanup';
    notes[1].topic = 'A later choice';
    const result = undoOrganization(notes, 'review', 'new-links', '2026-10-17');
    assert.equal(result.restored, 1);
    assert.equal(result.notes[0].topic, 'Personal Development');
    assert.equal(result.notes[0].userNotes, 'Written after the cleanup');
    assert.equal(result.notes[1].topic, 'A later choice');
});
test('ungrounded legacy concept names cannot create map bridges', () => {
    const before = [piece('a', { concepts: [{ name: 'Act first, identity catches up later' }] }),
        piece('b', { concepts: [{ name: 'Act first, identity catches up later' }] }), piece('c')];
    assert.equal(buildGraph(before, { focusId: 'a' }).shownNotes, 1);
    assert.notEqual(organizationStamp(before[0]), organizationStamp({ ...before[0], source: { ...before[0].source, partial: true } }));
});

test('confirmation applies only to the exact reviewed source text', async () => {
    const { sourceVersion, normalizeKnowledge } = await import('../js/knowledge.js');
    const note = piece('short', { source: { sourceType: 'article' } });
    assert.equal(normalizeKnowledge(note).sourceQuality.status, 'needs-review');
    const checked = { ...note, source: { ...note.source, textConfirmedVersion: sourceVersion(note) } };
    assert.equal(normalizeKnowledge(checked).sourceQuality.status, 'ready');
    assert.equal(normalizeKnowledge({ ...checked, sourceText: text + ' Changed.' }).sourceQuality.status, 'needs-review');
    assert.equal(sourceQuality({ sourceType: 'article', text, confirmed: true, partial: true }).status, 'needs-review');
});
