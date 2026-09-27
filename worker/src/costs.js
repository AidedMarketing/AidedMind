// Turns the monthly cost ledger into an estimate. Claude prices are per
// million tokens (input, output); Anthropic's Console has the exact bill.
export const CLAUDE_PRICES = [
    ['claude-haiku-4-5', 1, 5],
    ['claude-sonnet-5', 2, 10],
    ['claude-opus-5-5', 4, 20],
    ['claude-opus-5', 5, 25],
    ['claude-opus-4-8', 5, 25],
    ['claude-fable-5', 10, 50]
];

function claudePrice(model) {
    // Longest matching prefix, so claude-opus-5-5 isn't priced as claude-opus-5.
    const matches = CLAUDE_PRICES.filter(([prefix]) => model === prefix || model.startsWith(`${prefix}-`));
    return matches.sort((a, b) => b[0].length - a[0].length)[0] || null;
}

export function summarizeCosts(rows = []) {
    const byModel = {};
    const unpriced = new Set();
    let claudeUsd = 0;
    let geminiVideos = 0;
    let geminiTokens = 0;
    let supadataRequests = 0;
    rows.forEach(({ item, amount }) => {
        const claude = item.match(/^claude:(.+):(input|output)$/);
        if (claude) {
            const [, model, kind] = claude;
            const price = claudePrice(model);
            if (!price) {
                unpriced.add(model);
                return;
            }
            const usd = (amount / 1e6) * (kind === 'input' ? price[1] : price[2]);
            byModel[model] = (byModel[model] || 0) + usd;
            claudeUsd += usd;
        } else if (item === 'gemini:videos') geminiVideos += amount;
        else if (item === 'gemini:input' || item === 'gemini:output') geminiTokens += amount;
        else if (item === 'supadata:requests') supadataRequests += amount;
    });
    const round = (n) => Math.round(n * 10000) / 10000;
    return {
        claudeUsd: round(claudeUsd),
        claudeByModel: Object.fromEntries(Object.entries(byModel).map(([m, v]) => [m, round(v)])),
        unpricedModels: [...unpriced],
        geminiVideos,
        geminiTokens,
        supadataRequests
    };
}
