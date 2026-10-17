import { verifyEvidence } from './link-evidence.js';
import { terms } from '../../web/js/library.js';

export const LINK_BASES = ['same-mechanism', 'same-framework', 'same-specific-subject', 'direct-extension', 'analogy', 'incidental'];
const GENERIC = new Set('organize organizing organization manage managing management plan plans planning machine algorithm algorithms data technology system systems approach framework frameworks list lists idea ideas ai artificial intelligence tool tools model models work works working life lives people person personal growth development change changes changing action actions act behavior behaviour practice practicing learn learning learned use using used help helps focus time daily way ways health information knowledge understanding process principle principles important first build building better improve different similar common both source sources note notes'.split(' '));

// Confidence is not enough: retain only direct, source-grounded relationships.
// A distinctive shared term in the quoted passages guards against universal
// analogies such as lists -> self-discovery or AI research -> any AI tool.
export function eligibleLink(link, sourceText, candidate) {
    if (!LINK_BASES.slice(0, 4).includes(link.basis)) return null;
    const verified = verifyEvidence(link, sourceText, candidate);
    if (!verified.evidence) return null;
    const left = new Set(terms(verified.evidence.source).filter((term) => !GENERIC.has(term)));
    const anchors = [...new Set(terms(verified.evidence.target).filter((term) => !GENERIC.has(term) && left.has(term)))];
    if (!anchors.length) return null;
    return { ...verified, anchors: anchors.slice(0, 6), qualityVersion: 3 };
}
