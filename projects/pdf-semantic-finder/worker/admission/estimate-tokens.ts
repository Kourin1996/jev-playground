/**
 * How much provider capacity one search will spend, estimated before it spends it (spec §9.3).
 *
 * The numbers come from the measurements in `docs/spec.md` §14.20 and nowhere else. They are an
 * estimate for admission, not a billing figure: what matters is that it never comes out *below*
 * what a real search consumed, which `tests/admission.test.ts` checks against all three measured
 * rows.
 */
import { billedCharacters } from "../search/build-jev-request";
import type { JevBatch } from "../search/build-jev-request";

/**
 * Input tokens for one question's instruction string.
 *
 * §14.20: a four-passage request measured 3,092 input tokens, of which 1,044 were the four
 * instruction strings — 261 a question.
 */
const TOKENS_PER_QUESTION = 261;

/**
 * Input tokens per billed character of state.
 *
 * Derived from §14.20's near-limit row: 1,126,884 input tokens less 1,872 × 261 of instructions
 * leaves 638,292 for a state of about 406,647 billed characters — 1.57 tokens a character. Rounded
 * up to 1.7 so the estimate is not fitted exactly to the one document it came from.
 *
 * Japanese is the dense case and this is taken from it. English costs about 0.39 tokens a
 * character, so an English search is over-estimated roughly two and a half times and is admitted
 * at well under the capacity it could actually use. That is the safe direction for an admission
 * check, and this is a Japanese-first PoC (§2); a second rate per script would be a guess about
 * mixed documents rather than a measurement.
 */
const TOKENS_PER_STATE_CHARACTER = 1.7;

export const estimateBatchInputTokens = (batch: JevBatch): number => {
    const state = batch.state.reduce((total, segment) => total + billedCharacters(segment), 0);
    return batch.evaluate.length * TOKENS_PER_QUESTION + Math.ceil(state * TOKENS_PER_STATE_CHARACTER);
};

export const estimateSearchInputTokens = (batches: readonly JevBatch[]): number => batches.reduce((total, batch) => total + estimateBatchInputTokens(batch), 0);
