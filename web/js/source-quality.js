// A review flag, not a claim about whether the original publisher has more text.
export function sourceQuality(source = {}) {
    const text = String(source.text ?? source.sourceText ?? '').trim();
    const words = (text.match(/\S+/g) || []).length;
    if (!text) return { status: 'needs-review', words, reason: 'No captured text is available. Add the source text before reviewing organization.' };
    if (source.partial) return { status: 'needs-review', words, reason: 'This capture is marked partial. Add the full text before reviewing organization.' };
    if (source.sourceType === 'article' && words < 120 && !source.confirmed) {
        return { status: 'needs-review', words, reason: `Only ${words} words were captured. Check that the article text is complete before reviewing organization.` };
    }
    return { status: 'ready', words, reason: '' };
}

export function groundedConcept(concept, text = '') {
    const evidence = String(concept?.evidence || '').trim();
    return evidence.length >= 20 && String(text).includes(evidence);
}
