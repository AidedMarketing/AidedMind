// Turns the monthly cost ledger into an estimate. Claude prices are per
// million tokens (input, output); Anthropic's Console has the exact bill.
export const CLAUDE_PRICES = [
    ['claude-haiku-4-5', 1, 5],
    ['claude-sonnet-5-5', 2, 10],
    ['claude-sonnet-5', 2, 10],
    ['claude-opus-5-5', 4, 20],
    ['claude-opus-5', 5, 25],
    ['claude-opus-4-8', 5, 25],
    ['claude-fable-5', 10, 50]
];

function claudePrice(model) {
    // Longest matching prefix, so 5.5 models aren't priced as their 5 predecessors.
    const matches = CLAUDE_PRICES.filter(([prefix]) => model === prefix || model.startsWith(`${prefix}-`));
    return matches.sort((a, b) => b[0].length - a[0].length)[0] || null;
}

export function summarizeCosts(rows = []) {
    const byModel = {};
    const unpriced = new Set();
    let claudeUsd = 0;
    let geminiVideos = 0;
    let geminiBreakdowns = 0;
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
        else if (item === 'gemini:analysis') geminiBreakdowns += amount;
        else if (item === 'gemini:input' || item === 'gemini:output') geminiTokens += amount;
        else if (item === 'supadata:requests') supadataRequests += amount;
    });
    const round = (n) => Math.round(n * 10000) / 10000;
    return {
        claudeUsd: round(claudeUsd),
        claudeByModel: Object.fromEntries(Object.entries(byModel).map(([m, v]) => [m, round(v)])),
        unpricedModels: [...unpriced],
        geminiVideos,
        geminiBreakdowns,
        geminiTokens,
        supadataRequests
    };
}

// Records one Claude call in the usage totals and the cost ledger. `store` is
// the user's storage (a Durable Object stub or the storage core itself).
export async function recordClaude(store, month, model, tokens) {
    if (!model.startsWith('claude-')) {
        await store.recordTokens(month, tokens.input, tokens.output);
        await store.addCost(month, 'gemini:analysis', 1);
        await store.addCost(month, 'gemini:analysis_input', tokens.input);
        await store.addCost(month, 'gemini:analysis_output', tokens.output);
        return;
    }
    await store.recordTokens(month, tokens.input, tokens.output);
    await store.addCost(month, `claude:${model}:input`, tokens.input);
    await store.addCost(month, `claude:${model}:output`, tokens.output);
}
