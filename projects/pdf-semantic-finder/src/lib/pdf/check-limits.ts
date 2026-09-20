/**
 * Declared-limit enforcement (spec §2, §10).
 *
 * A document that exceeds a limit is still rendered and readable; only search is blocked, and the
 * reader is told which limit was reached. Nothing is ever silently truncated.
 */
import { LIMITS, countCharacters } from "@/lib/types";
import type { PdfSegment } from "@/lib/types";

export type LimitViolation =
    | { kind: "file_size"; actual: number; limit: number }
    | { kind: "page_count"; actual: number; limit: number }
    | { kind: "extracted_characters"; actual: number; limit: number }
    | { kind: "segment_count"; actual: number; limit: number };

export const checkFileLimits = (byteLength: number): LimitViolation[] =>
    byteLength > LIMITS.maxFileBytes ? [{ kind: "file_size", actual: byteLength, limit: LIMITS.maxFileBytes }] : [];

export const checkPageLimits = (pageCount: number): LimitViolation[] =>
    pageCount > LIMITS.maxPageCount ? [{ kind: "page_count", actual: pageCount, limit: LIMITS.maxPageCount }] : [];

/** Checked after segmentation and before any search is offered. */
export const checkSegmentLimits = (segments: readonly PdfSegment[]): LimitViolation[] => {
    const violations: LimitViolation[] = [];
    const characters = segments.reduce((total, segment) => total + countCharacters(segment.originalText), 0);

    if (characters > LIMITS.maxExtractedCharacters) {
        violations.push({ kind: "extracted_characters", actual: characters, limit: LIMITS.maxExtractedCharacters });
    }

    if (segments.length > LIMITS.maxSegmentCount) {
        violations.push({ kind: "segment_count", actual: segments.length, limit: LIMITS.maxSegmentCount });
    }

    return violations;
};

export const describeLimitViolation = (violation: LimitViolation): string => {
    switch (violation.kind) {
        case "file_size":
            return `This PDF is ${(violation.actual / (1024 * 1024)).toFixed(1)} MB. The limit is ${violation.limit / (1024 * 1024)} MB.`;
        case "page_count":
            return `This PDF has ${violation.actual} pages. The limit is ${violation.limit}.`;
        case "extracted_characters":
            return `This PDF contains ${violation.actual.toLocaleString()} extracted characters. The limit is ${violation.limit.toLocaleString()}.`;
        case "segment_count":
            return `This PDF produced ${violation.actual} searchable segments. The limit is ${violation.limit}.`;
    }
};
