/**
 * Runtime validation of the streamed `/api/search` body (spec §9.3).
 *
 * The client used to write `JSON.parse(line) as SearchStreamMessage` — a cast, which checks
 * nothing. Two consequences, both reproduced: any line whose `type` was neither `progress` nor
 * `error` fell into the terminal branch and was accepted as a **successful** search, whatever it
 * actually contained; and progress lines were handed to the component without anyone looking at
 * the identifiers they carried.
 *
 * The Worker already validates the provider's JSON field by field (`worker/search/validate.ts`,
 * `call-jev.ts`). This is the same discipline applied in the other direction, in the same style and
 * with no new dependency.
 *
 * Every rejection is a search error. A malformed stream must never become `no_match`, which would
 * report a failure as a statement about the document.
 */
import type { SearchResultRecord, SearchStatus, SearchStreamMessage } from "@/lib/types";
import { isSearchErrorCode } from "@/lib/types";

/** What the caller knows about the search it asked for, and what it has seen so far. */
export type StreamExpectation = {
    documentId: string;
    requestId: string;
    /** Segment IDs that were sent. A result naming anything else cannot be mapped to a passage. */
    segmentIds: ReadonlySet<string>;
    /** How many segments were sent, which is what `total` must equal. */
    total: number;
};

export type StreamProgressSeen = {
    evaluated: number;
    terminated: boolean;
};

export type StreamMessageResult = { ok: true; message: SearchStreamMessage } | { ok: false };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isProbability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const STATUSES: readonly SearchStatus[] = ["matched", "uncertain", "no_match"];

const isStatus = (value: unknown): value is SearchStatus => typeof value === "string" && (STATUSES as readonly string[]).includes(value);

/**
 * One judged passage.
 *
 * `score` is the provider's own scale rather than a probability, so it is bounded only by being
 * finite; the two probabilities are not. A segment ID that was never sent is rejected outright:
 * the client would look it up, find nothing, and silently drop the result.
 */
const validateRecord = (value: unknown, segmentIds: ReadonlySet<string>): SearchResultRecord | null => {
    if (!isRecord(value)) return null;
    const { segmentId, score, relevantProbability, confidence } = value;

    if (typeof segmentId !== "string" || !segmentIds.has(segmentId)) return null;
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    if (!isProbability(relevantProbability) || !isProbability(confidence)) return null;

    return { segmentId, score, relevantProbability, confidence };
};

const validateRecords = (value: unknown, segmentIds: ReadonlySet<string>): SearchResultRecord[] | null => {
    if (!Array.isArray(value)) return null;

    const records: SearchResultRecord[] = [];
    for (const entry of value) {
        const record = validateRecord(entry, segmentIds);
        if (record === null) return null;
        records.push(record);
    }
    return records;
};

/**
 * Validates one parsed line against the search that asked for it.
 *
 * `seen` is read and updated, so ordering rules can be enforced: progress must not go backwards or
 * exceed the total, and nothing may follow the one terminal message.
 */
export const validateStreamMessage = (value: unknown, expected: StreamExpectation, seen: StreamProgressSeen): StreamMessageResult => {
    if (!isRecord(value)) return { ok: false };
    // Anything after the authoritative answer is a stream that did not end when it said it had.
    if (seen.terminated) return { ok: false };

    // Every line names the search it belongs to, so a response from a superseded search or a
    // different document cannot be mistaken for this one's.
    if (value.documentId !== expected.documentId || value.requestId !== expected.requestId) return { ok: false };

    if (value.type === "progress") {
        const { evaluated, total, results } = value;
        if (typeof evaluated !== "number" || !Number.isInteger(evaluated)) return { ok: false };
        if (total !== expected.total) return { ok: false };
        if (evaluated < seen.evaluated || evaluated > expected.total) return { ok: false };

        const validated = validateRecords(results, expected.segmentIds);
        if (validated === null) return { ok: false };

        seen.evaluated = evaluated;
        return {
            ok: true,
            message: { type: "progress", documentId: expected.documentId, requestId: expected.requestId, evaluated, total, results: validated },
        };
    }

    if (value.type === "error") {
        const { error } = value;
        if (!isRecord(error) || !isSearchErrorCode(error.code) || typeof error.message !== "string") return { ok: false };

        seen.terminated = true;
        return {
            ok: true,
            message: { type: "error", documentId: expected.documentId, requestId: expected.requestId, error: { code: error.code, message: error.message } },
        };
    }

    if (value.type === "final") {
        const { status, results, evaluations, evaluatedSegmentCount, requestCount, model, elapsedMs } = value;

        if (!isStatus(status)) return { ok: false };
        if (typeof model !== "string") return { ok: false };
        if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return { ok: false };
        if (!Number.isInteger(requestCount) || (requestCount as number) < 0) return { ok: false };
        // §7 classifies over every segment, so a terminal message that judged fewer than were sent
        // is an incomplete evaluation being presented as an answer.
        if (evaluatedSegmentCount !== expected.total) return { ok: false };

        const validatedResults = validateRecords(results, expected.segmentIds);
        if (validatedResults === null) return { ok: false };

        // Diagnostic and optional, but not exempt: a malformed one still means a malformed line.
        let validatedEvaluations: SearchResultRecord[] | undefined;
        if (evaluations !== undefined) {
            const parsed = validateRecords(evaluations, expected.segmentIds);
            if (parsed === null) return { ok: false };
            validatedEvaluations = parsed;
        }

        seen.terminated = true;
        return {
            ok: true,
            message: {
                type: "final",
                documentId: expected.documentId,
                requestId: expected.requestId,
                status,
                results: validatedResults,
                ...(validatedEvaluations === undefined ? {} : { evaluations: validatedEvaluations }),
                evaluatedSegmentCount,
                requestCount: requestCount as number,
                model,
                elapsedMs,
            },
        };
    }

    // An unknown type used to land in the terminal branch and be reported as a successful search.
    return { ok: false };
};
