/**
 * Debug view of the extraction and of what Jev made of it (spec §3, §7, implementation step 2).
 *
 * Two things are visible here that are visible nowhere else. The segment order and item counts say
 * how the document was divided, which can be checked against the rendered page. The judgement of
 * every evaluated segment — not just the three that were returned — says whether a passage was
 * passed over because Jev scored it low or because it was never a search unit to begin with.
 *
 * The context is shown alongside, because what was sent is not the passage alone.
 */
import { Badge } from "@/components/base/badges/badges";
import type { PdfSegment, SearchResultRecord } from "@/lib/types";
import { THRESHOLDS, countCharacters } from "@/lib/types";
import { cx } from "@/utils/cx";

export type ExtractedTextViewProps = {
    segments: PdfSegment[];
    /**
     * Every segment's judgement from the last meaning search, or null before one has run. Keyed by
     * segment ID rather than by position: a response is only applied when its identifiers match,
     * but the lookup must not depend on the two lists staying in step.
     */
    evaluations: Map<string, SearchResultRecord> | null;
};

/** The three levels Jev is asked to choose between (spec §6.3). */
const LEVEL_LABEL = ["not relevant", "partly relevant", "relevant"] as const;

/**
 * How a probability reads against the thresholds search uses.
 *
 * The same numbers spec §7 classifies on, so the bar and the result list cannot disagree.
 */
const verdictOf = (relevantProbability: number) =>
    relevantProbability >= THRESHOLDS.matched
        ? { label: "matched", tone: "bg-success-solid", text: "text-success-primary" }
        : relevantProbability >= THRESHOLDS.uncertain
          ? { label: "uncertain", tone: "bg-warning-solid", text: "text-warning-primary" }
          : { label: "below threshold", tone: "bg-quaternary", text: "text-quaternary" };

const Judgement = ({ evaluation }: { evaluation: SearchResultRecord }) => {
    const verdict = verdictOf(evaluation.relevantProbability);
    const percentage = Math.round(evaluation.relevantProbability * 100);

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={cx("text-sm font-semibold tabular-nums", verdict.text)}>{percentage}%</span>
                <span className={cx("text-xs", verdict.text)}>
                    P(&ldquo;{LEVEL_LABEL[2]}&rdquo;) · {verdict.label}
                </span>
                <span className="text-xs text-quaternary tabular-nums">
                    score {evaluation.score.toFixed(2)} · confidence {evaluation.confidence.toFixed(2)}
                </span>
            </div>
            {/*
             * The thresholds are drawn on the track, so a bar can be read without knowing them.
             * The track itself stays visible at 0%: an empty bar has to read as a zero reading on
             * a scale, not as a missing one.
             */}
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-quaternary">
                <div className={cx("h-full rounded-full", verdict.tone)} style={{ width: `${percentage}%` }} />
                <span className="absolute inset-y-0 w-0.5 bg-primary" style={{ left: `${THRESHOLDS.uncertain * 100}%` }} aria-hidden="true" />
                <span className="absolute inset-y-0 w-0.5 bg-primary" style={{ left: `${THRESHOLDS.matched * 100}%` }} aria-hidden="true" />
            </div>
        </div>
    );
};

export const ExtractedTextView = ({ segments, evaluations }: ExtractedTextViewProps) => (
    <div className="flex flex-col gap-2 p-6">
        {evaluations === null && (
            <p className="px-1 pb-1 text-sm text-tertiary">
                Run a meaning search to see what each passage was judged to be. Until then this shows the extraction only.
            </p>
        )}

        {segments.map((segment, index) => {
            const evaluation = evaluations?.get(segment.id);

            return (
                <article key={segment.id} className="flex flex-col gap-2 rounded-xl bg-secondary p-4">
                    <header className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-primary">#{index + 1}</span>
                        <Badge size="sm" color="gray" type="modern">
                            {segment.id}
                        </Badge>
                        <Badge size="sm" color="gray" type="modern">
                            Page {segment.pageNumber}
                        </Badge>
                        <span className="text-xs text-quaternary">
                            {countCharacters(segment.originalText)} chars · {segment.itemIndexes.length} items
                        </span>
                    </header>

                    {evaluation !== undefined && <Judgement evaluation={evaluation} />}
                    {evaluations !== null && evaluation === undefined && <p className="text-xs text-quaternary">Not evaluated in the last search.</p>}

                    <p className="text-sm whitespace-pre-wrap text-secondary">{segment.originalText}</p>

                    {/*
                     * What travelled with the passage. Dimmed, because it is not what a result
                     * points at — it is only there so a 前項 or a pronoun resolves (spec §6.3).
                     */}
                    {(segment.contextBefore !== undefined || segment.contextAfter !== undefined) && (
                        <details className="text-xs text-quaternary">
                            <summary className="cursor-pointer select-none">Context sent with this passage</summary>
                            <div className="mt-1.5 flex flex-col gap-1.5">
                                {segment.contextBefore !== undefined && <p className="whitespace-pre-wrap">before: {segment.contextBefore}</p>}
                                {segment.contextAfter !== undefined && <p className="whitespace-pre-wrap">after: {segment.contextAfter}</p>}
                            </div>
                        </details>
                    )}
                </article>
            );
        })}
    </div>
);
