// Relationship claims need literal evidence from both captured sources.
export const EVIDENCE_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['source', 'target'],
    properties: {
        source: { type: 'string', description: 'A short verbatim passage from the new source, or empty if unavailable' },
        target: { type: 'string', description: 'A short verbatim passage from this library note, or empty if unavailable' }
    }
};
export function verifyEvidence(link, sourceText = '', candidate = {}) {
    const source = String(link.evidence?.source || '').trim().slice(0, 500);
    const target = String(link.evidence?.target || '').trim().slice(0, 500);
    const verified = source.length >= 20 && target.length >= 20 && sourceText.includes(source) &&
        (candidate?.passages || []).some((passage) => passage.includes(target));
    return { ...link, relation: verified || link.relation === 'related' ? link.relation : 'related',
        evidence: verified ? { source, target } : null };
}
