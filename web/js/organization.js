import { normalizeKnowledge, sourceVersion, topicMetadata } from './knowledge.js';
import { groundedConcept, sourceQuality } from './source-quality.js';

export const organizationSource = (note) => ({ ...note.source, text: note.sourceText || '',
    confirmed: note.source?.textConfirmedVersion === sourceVersion(note) });
export function organizationStamp(note) {
    return sourceVersion({ sourceText: JSON.stringify([sourceVersion(note), note.source?.sourceType, Boolean(note.source?.partial),
        note.source?.title, note.source?.textConfirmedVersion, topicMetadata(note), note.concepts || [], note.tags || []]) });
}
export function organizationSummary(notes) {
    const id = notes.filter((note) => note.organizationReview?.id)
        .sort((a, b) => b.organizationReview.startedAt.localeCompare(a.organizationReview.startedAt))[0]?.organizationReview.id;
    const members = notes.filter((note) => id && note.organizationReview?.id === id);
    const count = (status) => members.filter((note) => note.organizationReview.status === status).length;
    return { id, members, total: members.length, pending: count('pending'), ready: count('ready'), failed: count('failed'),
        blocked: count('blocked'), stale: count('stale'), applied: count('applied'), restored: count('restored'), corrected: count('corrected'),
        paused: members.some((note) => note.organizationReview.status === 'pending' && note.organizationReview.paused) };
}
export function queueOrganization(notes, id, startedAt) {
    return notes.map((note) => {
        const quality = sourceQuality(organizationSource(note));
        return { ...note, organizationReview: { id, startedAt, stamp: organizationStamp(note),
            status: quality.status === 'ready' ? 'pending' : 'blocked', quality } };
    });
}
const metadata = (note) => ({ ...topicMetadata(note), concepts: note.concepts || [], tags: note.tags || [], processingVersion: note.processingVersion });
export function applyOrganization(notes, selected, reviewId, connectionId, startedAt) {
    const chosen = new Set(selected);
    let applied = 0, stale = 0;
    const updated = notes.map((note) => {
        const review = note.organizationReview;
        if (!chosen.has(note.id) || review?.id !== reviewId || review.status !== 'ready') return note;
        if (review.stamp !== organizationStamp(note)) {
            stale++; return { ...note, organizationReview: { ...review, status: 'stale' } };
        }
        const proposal = review.proposal;
        if (!proposal?.topic || proposal.quality?.status !== 'ready') return note;
        let next = normalizeKnowledge({ ...note,
            ...(note.topicByUser ? {} : { topic: proposal.topic, topicId: undefined, topicAliases: [] }),
            concepts: proposal.concepts.filter((concept) => groundedConcept(concept, note.sourceText)),
            tags: proposal.tags, processingVersion: 3 }, notes);
        const previous = metadata(note);
        next.organizationReview = { ...review, status: 'applied', previous, appliedStamp: organizationStamp(next) };
        applied++; return next;
    });
    return { applied, stale, notes: applied ? queueConnections(updated, connectionId, startedAt) : updated };
}
export function undoOrganization(notes, reviewId, connectionId, startedAt) {
    let restored = 0;
    const updated = notes.map((note) => {
        const review = note.organizationReview;
        if (review?.id !== reviewId || review.status !== 'applied' || review.appliedStamp !== organizationStamp(note)) return note;
        restored++;
        return { ...note, ...review.previous, organizationReview: { ...review, status: 'restored' } };
    });
    return { restored, notes: restored ? queueConnections(updated, connectionId, startedAt) : updated };
}
function queueConnections(notes, reviewId, reviewStartedAt) {
    return notes.map((note) => ({ ...note, linking: { status: 'pending', attempts: 0, reviewId, reviewStartedAt } }));
}
