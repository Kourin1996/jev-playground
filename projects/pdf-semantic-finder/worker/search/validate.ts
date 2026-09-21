/**
 * Request and response validation for the application API (spec §9.3).
 *
 * Every function here is pure and free of Workers runtime types, so the whole module is unit
 * testable. No error ever interpolates the query, segment text, or any document content: that
 * would leak content into logs, which spec §10 forbids.
 */
import type { SearchErrorCode, SearchRequest } from "@/lib/types";
import { LIMITS, PROBABILITY_SUM_TOLERANCE, SEGMENT_ID_PATTERN, countCharacters } from "@/lib/types";

export type ValidationFailure = { code: SearchErrorCode };

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: ValidationFailure };

const fail = (code: SearchErrorCode): ValidationResult<never> => ({ ok: false, error: { code } });

/** Echoed identifiers are bounded so arbitrary client input is never reflected back. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validates a `/api/search` request body.
 *
 * Segment IDs are checked against their grammar here, before anything downstream interpolates one
 * into a Jev `instructions` string. That interpolation is trusted prompt position, so an
 * unchecked ID would be a direct injection point.
 */
export const validateSearchRequest = (body: unknown, bodyByteLength: number): ValidationResult<SearchRequest> => {
    if (bodyByteLength > LIMITS.maxRequestBodyBytes) return fail("request_body_too_large");
    if (!isRecord(body)) return fail("invalid_request");

    const { documentId, requestId, query, segments } = body;

    if (typeof documentId !== "string" || !ID_PATTERN.test(documentId)) return fail("invalid_request");
    if (typeof requestId !== "string" || !ID_PATTERN.test(requestId)) return fail("invalid_request");
    if (typeof query !== "string") return fail("invalid_request");

    const trimmedQuery = query.trim();
    if (trimmedQuery === "") return fail("query_empty");
    if (countCharacters(query) > LIMITS.maxQueryCharacters) return fail("query_too_long");

    if (!Array.isArray(segments)) return fail("invalid_request");
    if (segments.length === 0) return fail("segments_empty");
    if (segments.length > LIMITS.maxSegmentCount) return fail("too_many_segments");

    const seenIds = new Set<string>();
    const validated: SearchRequest["segments"] = [];
    let aggregateCharacters = 0;

    for (const segment of segments) {
        if (!isRecord(segment)) return fail("invalid_request");

        const { id, text, contextBefore, contextAfter } = segment;

        if (typeof id !== "string" || !SEGMENT_ID_PATTERN.test(id)) return fail("malformed_segment_id");
        if (seenIds.has(id)) return fail("duplicate_segment_id");
        seenIds.add(id);

        if (typeof text !== "string") return fail("invalid_request");
        if (text.trim() === "") return fail("segment_text_empty");

        const length = countCharacters(text);
        if (length > LIMITS.maxSegmentCharacters) return fail("segment_text_too_long");
        aggregateCharacters += length;

        // Context is a *neighbouring segment's* text (`buildSegments` takes it from the adjacent
        // group), so the same per-segment limit applies to it and `segment_text_too_long` is
        // literally accurate. Unbounded, it defeated the batch budget entirely: a short target
        // with 100,000 characters of context packed one batch of 100,018 against a stated
        // maximum of 10,000.
        //
        // `countCharacters`, not `.length`, for the reason the target text uses it — a Japanese
        // document of surrogate pairs would otherwise be refused at half the stated limit.
        if (contextBefore !== undefined) {
            if (typeof contextBefore !== "string") return fail("invalid_request");
            if (countCharacters(contextBefore) > LIMITS.maxSegmentCharacters) return fail("segment_text_too_long");
        }
        if (contextAfter !== undefined) {
            if (typeof contextAfter !== "string") return fail("invalid_request");
            if (countCharacters(contextAfter) > LIMITS.maxSegmentCharacters) return fail("segment_text_too_long");
        }

        validated.push({
            id,
            text,
            ...(typeof contextBefore === "string" ? { contextBefore } : {}),
            ...(typeof contextAfter === "string" ? { contextAfter } : {}),
        });
    }

    // Target text only, deliberately. Each segment's text travels three times — itself and as each
    // neighbour's context — so a document at exactly the character cap bills about three times it.
    // Counting context here would reject a document the client had already accepted, and the reader
    // would see a search error where a limit message belongs; that is the regression
    // `maxRequestBodyBytes` records from when it was 256 KiB. The aggregate bound on everything
    // transmitted is `maxRequestBodyBytes`, enforced in `worker/http/read-body.ts`.
    if (aggregateCharacters > LIMITS.maxExtractedCharacters) return fail("extracted_text_too_long");

    return { ok: true, value: { documentId, requestId, query, segments: validated } };
};

/** A validated Jev score answer (spec §6.3). */
export type JevScoreAnswer = {
    score: number;
    confidence: number;
    probabilities: Record<"0" | "1" | "2", number>;
};

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Validates one Jev answer.
 *
 * The level count is fixed at three by spec §6.2, so an answer carrying any other set of levels is
 * a malformed response rather than something to interpret.
 */
export const validateJevAnswer = (answer: unknown): ValidationResult<JevScoreAnswer> => {
    if (!isRecord(answer)) return fail("provider_malformed_response");
    if (answer.type !== "score") return fail("provider_malformed_response");

    const { score, confidence, probabilities } = answer;

    // `score` is the probability-weighted level, so it lies on the level number line.
    if (!isFiniteNumber(score) || score < 0 || score > 2) return fail("provider_malformed_response");
    if (!isFiniteNumber(confidence) || confidence < 0 || confidence > 1) return fail("provider_malformed_response");
    if (!isRecord(probabilities)) return fail("provider_malformed_response");

    const keys = Object.keys(probabilities).sort();
    if (keys.length !== 3 || keys[0] !== "0" || keys[1] !== "1" || keys[2] !== "2") {
        return fail("provider_malformed_response");
    }

    let total = 0;
    for (const key of keys) {
        const probability = probabilities[key];
        if (!isFiniteNumber(probability) || probability < 0 || probability > 1) {
            return fail("provider_malformed_response");
        }
        total += probability;
    }

    if (Math.abs(total - 1) > PROBABILITY_SUM_TOLERANCE) return fail("provider_malformed_response");

    return {
        ok: true,
        value: {
            score,
            confidence,
            probabilities: probabilities as Record<"0" | "1" | "2", number>,
        },
    };
};
