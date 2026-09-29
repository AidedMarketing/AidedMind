// Spotting paywalled articles, shared by the phone and the server (plain
// functions, no DOM). A page counts as paywalled when it says so (markup or
// wording) AND what we got is only the start of an article.
const MARKERS = [
    /"isAccessibleForFree"\s*:\s*(?:false|"false"|"False")/,
    /<meta[^>]+(?:name|property)=["']article:content_tier["'][^>]*content=["'](?:locked|metered|premium)/i,
    /<meta[^>]+content=["'](?:locked|metered|premium)["'][^>]*(?:name|property)=["']article:content_tier["']/i,
    /class=["'][^"']*(?:paywall|subscriber-only|subscribers-only|premium-content|locked-content)/i,
    /\bdata-paywall\b/i
];

const PHRASES = new RegExp([
    'subscribe (?:now )?to (?:continue|keep) reading',
    'subscribe to read',
    'to continue reading,? (?:please )?(?:log ?in|sign ?in|subscribe)',
    'already a (?:paid )?subscriber',
    'this (?:article|post|story) is (?:only )?for (?:paid )?(?:subscribers|members)',
    '(?:paid )?(?:subscribers|members) only',
    'create a (?:free )?account to (?:continue|read|keep reading)',
    'unlock (?:this|the full) (?:article|story|post)',
    'you(?:\'ve| have) reached your (?:free )?(?:article|reading)? ?limit',
    '(?:log ?in|sign ?in|register) to (?:continue|read|view the (?:full|rest))',
    'read the full (?:article|story) with a subscription',
    'upgrade to (?:paid|continue reading)'
].join('|'), 'i');

export function countWords(text) {
    const matches = String(text || '').match(/\S+/g);
    return matches ? matches.length : 0;
}

// html: the page's markup (may be empty); text: the article text we managed to read.
export function looksPaywalled(html, text) {
    const words = countWords(text);
    if (html && words < 700 && MARKERS.some((marker) => marker.test(html))) return true;
    // Wording near the end of a short read: "Subscribe to continue reading".
    return words < 1200 && PHRASES.test(String(text || '').slice(-1500));
}
