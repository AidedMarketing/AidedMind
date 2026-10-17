import { callClaude, resolveDepth } from './analyze.js';
import { CONCEPT_SCHEMA, EXTRACTION_RULES, normalizeConcepts, sourceQuality } from './knowledge-extraction.js';
import { HttpError } from './http.js';

export const ORGANIZATION_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['topic', 'concepts', 'tags'],
    properties: {
        topic: { type: 'string', description: 'The main subject in 1–3 words, Title Case. Create a specific subject when appropriate.' },
        concepts: { type: 'array', items: CONCEPT_SCHEMA },
        tags: { type: 'array', items: { type: 'string' } }
    }
};

export async function reviewOrganization(rawSource, env) {
    const source = { title: String(rawSource?.title || '').slice(0, 200),
        sourceType: String(rawSource?.sourceType || 'text').slice(0, 30),
        partial: Boolean(rawSource?.partial), confirmed: Boolean(rawSource?.confirmed), text: String(rawSource?.text || '') };
    if (source.text.length > 600000) throw new HttpError(413, 'This captured source is too long to review in one request.');
    const quality = sourceQuality(source);
    if (quality.status !== 'ready') return { proposal: { quality }, model: null };
    if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, 'The server has no Anthropic API key configured.');
    const { model } = resolveDepth('quick', env, source);
    const { message, parsed } = await callClaude(env, {
        model, max_tokens: 4000, system: `Review the organization of one saved source. Do not rewrite its summary. ${EXTRACTION_RULES}`,
        output_config: { format: { type: 'json_schema', schema: ORGANIZATION_SCHEMA } },
        messages: [{ role: 'user', content: JSON.stringify(source) }]
    }, { timeout: 60000, what: 'review this piece’s organization' });
    const topic = String(parsed.topic || '').trim().replace(/[.#]/g, '').slice(0, 40);
    if (!topic) throw new HttpError(502, 'The organization review did not return a topic. Try again.');
    return { proposal: { topic, concepts: normalizeConcepts(parsed.concepts, source.text),
        tags: [...new Set((Array.isArray(parsed.tags) ? parsed.tags : []).map((tag) => String(tag).trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))].slice(0, 8), quality },
        model: message.model, tokens: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
}
