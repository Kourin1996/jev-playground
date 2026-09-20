/** Shared helpers for the unit tests. */

export { LIMITS, THRESHOLDS } from "@/lib/types";

/** Segment ID formatter, duplicated here so the tests do not depend on the browser modules. */
export const formatSegmentIdFallback = (pageNumber: number, sequence: number): string =>
    `p${String(pageNumber).padStart(3, "0")}-s${String(sequence).padStart(3, "0")}`;
