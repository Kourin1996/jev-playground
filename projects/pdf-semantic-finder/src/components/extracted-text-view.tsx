/**
 * Debug view of the extraction and of what Jev made of it (spec §3, §7, implementation step 2).
 *
 * Two things are visible here that are visible nowhere else. The segment order and item counts say
 * how the document was divided, which can be checked against the rendered page. The judgement of
 * every evaluated segment — not just the three that were returned — says whether a passage was
 * passed over because Jev scored it low or because it was never a search unit to begin with.
 */
import { ArrowLeft, ArrowRight } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
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
    /** Closes the view and returns to the document. */
    onClose: () => void;
    /** Leaves the view and takes the reader to this passage on the page it sits on. */
    onOpenSegment: (segmentId: string) => void;
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

/**
 * The order the passages are listed in.
 *
 * Document order until a search has run, because that is what this view is for: the segment order
 * checked against the rendered page is one of the two things visible nowhere else.
 *
 * After a search, the passages that cleared either §7 threshold come first, highest first, and
 * everything else follows in document order. The judgements are the reason to open this view after
 * a search, and hunting for the few that scored through hundreds that did not is not reading.
 *
 * The number on each card stays its **document** position, so reordering the list does not cost the
 * information the list was ordered by in the first place.
 */
const listOrder = (segments: readonly PdfSegment[], evaluations: Map<string, SearchResultRecord> | null) => {
    const numbered = segments.map((segment, index) => ({ segment, position: index + 1, evaluation: evaluations?.get(segment.id) }));
    if (evaluations === null) return numbered;

    const scoreOf = (entry: (typeof numbered)[number]) => entry.evaluation?.relevantProbability ?? -1;
    const judged = numbered.filter((entry) => scoreOf(entry) >= THRESHOLDS.uncertain);
    const rest = numbered.filter((entry) => scoreOf(entry) < THRESHOLDS.uncertain);

    // Same tie-break as the result list (§7), so the two cannot disagree about which is higher.
    judged.sort((a, b) => scoreOf(b) - scoreOf(a) || (b.evaluation?.score ?? 0) - (a.evaluation?.score ?? 0));

    return [...judged, ...rest];
};

export const ExtractedTextView = ({ segments, evaluations, onClose, onOpenSegment }: ExtractedTextViewProps) => (
    <div className="flex flex-col gap-2 p-6">
        {/*
         * Sticky rather than at the top of the scroll: this view is hundreds of cards long, and a
         * way out that is only reachable by scrolling back is not a way out.
         */}
        <div className="sticky top-0 z-10 -mt-2 flex justify-end pt-2 pb-2">
            <Button size="sm" color="secondary" iconLeading={ArrowLeft} onClick={onClose}>
                Back to document
            </Button>
        </div>

        {evaluations === null && (
            <p className="px-1 pb-1 text-sm text-tertiary">
                Run a meaning search to see what each passage was judged to be. Until then this shows the extraction only.
            </p>
        )}

        {evaluations !== null && (
            <p className="px-1 pb-1 text-sm text-tertiary">
                Passages that met either threshold come first, highest first. The rest follow in document order, and the number on each card is always its
                position in the document.
            </p>
        )}

        {listOrder(segments, evaluations).map(({ segment, position, evaluation }) => {
            return (
                <article key={segment.id} className="flex flex-col gap-2 rounded-xl bg-secondary p-4">
                    <header className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-primary">#{position}</span>
                        <Badge size="sm" color="gray" type="modern">
                            {segment.id}
                        </Badge>
                        <Badge size="sm" color="gray" type="modern">
                            Page {segment.pageNumber}
                        </Badge>
                        <span className="text-xs text-quaternary">
                            {countCharacters(segment.originalText)} chars · {segment.itemIndexes.length} items
                        </span>

                        {/*
                         * The way back to the thing being described. Reading a judgement and then
                         * having to find the passage by eye is the part of this view that was
                         * missing — the segment ID says where it is, but only to someone willing
                         * to count.
                         */}
                        <Button
                            size="sm"
                            color="tertiary"
                            className="ml-auto"
                            iconLeading={ArrowRight}
                            aria-label={`Show ${segment.id} in the document`}
                            onClick={() => onOpenSegment(segment.id)}
                        >
                            Show
                        </Button>
                    </header>

                    {evaluation !== undefined && <Judgement evaluation={evaluation} />}
                    {evaluations !== null && evaluation === undefined && <p className="text-xs text-quaternary">Not evaluated in the last search.</p>}

                    <p className="text-sm whitespace-pre-wrap text-secondary">{segment.originalText}</p>
                </article>
            );
        })}
    </div>
);
