/**
 * Results panel (spec §3, §7).
 *
 * Shows the physical page number, the original extracted text, and the model's own judgement of the
 * passage. Still no generated explanation: nothing here is written about the passage, only quoted
 * from it or reported as the number the provider returned.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import type { SearchHit, SearchMode, SearchStatus } from "@/lib/types";
import { THRESHOLDS } from "@/lib/types";
import { cx } from "@/utils/cx";

export type SearchResultsProps = {
    /** False before a document is open, when the drop zone carries the instruction instead. */
    hasDocument: boolean;
    status: SearchStatus | null;
    results: SearchHit[];
    /**
     * The key of the selected result, not its position.
     *
     * A meaning search re-ranks its list with every batch, so position *n* can be a different
     * passage from one frame to the next — an index would follow the position and quietly move the
     * highlight somewhere the reader never chose.
     */
    selectedKey: string | null;
    onSelect: (key: string) => void;
    errorMessage: string | null;
    locationErrorMessage: string | null;
    /** Physical pages that produced nothing to search, so an empty result can say so. */
    unsearchedPages: number[];
    /**
     * Pages whose layout spec §2 does not claim to handle. They were searched, so they are kept
     * apart from `unsearchedPages` — saying they could not be searched would be untrue.
     */
    unsupportedLayoutPages: number[];
    /** Which mode produced this result; an empty result means different things in each. */
    mode: SearchMode;
    /**
     * The extracted-text view's toggle.
     *
     * It lives in this panel rather than under the viewer because it belongs with the other things
     * said *about* the search — what each passage was judged to be, most of all — and not with the
     * controls for reading the document.
     */
    isShowingExtractedText: boolean;
    onToggleExtractedText: () => void;
    /**
     * The query these results came from, which is not necessarily the one in the search bar.
     *
     * Emphasising the edited text against a list produced by an earlier query annotated results
     * with a search nobody had run.
     */
    query: string;
    /**
     * How far a meaning search has got, or null when none is running.
     *
     * While it is set, the list is whatever currently scores highest and its order is still
     * changing. No verdict is shown: §7 classifies over every segment, so `no_match` announced
     * halfway through would be a claim the search has not earned.
     */
    progress: { evaluated: number; total: number } | null;
};

/**
 * Splits a passage so the parts of the query that literally appear in it can be emphasised.
 *
 * Only literal occurrences, never an inference about which words mattered: §3 forbids generated
 * explanations, and the provider does not report what it read. A Japanese query carries no word
 * boundaries, so it is matched whole; when nothing matches literally, nothing is emphasised, which
 * is the honest outcome for a meaning search that found a paraphrase.
 */
const emphasise = (text: string, query: string): Array<{ text: string; hit: boolean }> => {
    const terms = [...new Set(query.split(/[\s、。,.!?！？]+/u).filter((term) => term.length >= 2))].sort((a, b) => b.length - a.length);
    if (terms.length === 0) return [{ text, hit: false }];

    const parts: Array<{ text: string; hit: boolean }> = [];
    let rest = text;

    while (rest.length > 0) {
        const found = terms
            .map((term) => ({ term, at: rest.toLowerCase().indexOf(term.toLowerCase()) }))
            .filter((candidate) => candidate.at >= 0)
            .sort((a, b) => a.at - b.at || b.term.length - a.term.length)[0];

        if (found === undefined) {
            parts.push({ text: rest, hit: false });
            break;
        }

        if (found.at > 0) parts.push({ text: rest.slice(0, found.at), hit: false });
        parts.push({ text: rest.slice(found.at, found.at + found.term.length), hit: true });
        rest = rest.slice(found.at + found.term.length);
    }

    return parts;
};

/**
 * How the model's own judgement is shown.
 *
 * A number, because hiding it left the reader unable to tell a passage the model was certain about
 * from one it was guessing at. Labelled as the model's confidence and never as a match percentage:
 * §14.19 measured the same passage crossing all three bands depending on which other passages
 * shared its request, so it is a reading rather than a measurement.
 */
const judgementTone = (probability: number) =>
    probability >= THRESHOLDS.matched
        ? { label: "confident", className: "text-success-primary" }
        : probability >= THRESHOLDS.uncertain
          ? { label: "unsure", className: "text-warning-primary" }
          : { label: "weak", className: "text-quaternary" };

/**
 * How many result cards are mounted at a time.
 *
 * Exact search returns every occurrence and spec §6.1 forbids capping that — but rendering every
 * occurrence is a different promise. Measured on the 48-page fixture: a one-word query produced
 * 3,744 results, and mounting all of them took a second to paint and left the search box taking
 * **1.6 seconds to accept four typed characters**. The count stays exact and every result stays
 * reachable; the list simply grows as the reader travels down it.
 */
const REVEAL_STEP = 50;

/** "Page 3 could not be searched." / "Pages 3, 4 could not be searched." */
const describePages = (pages: number[], plural: string, singular = plural): string =>
    pages.length === 1 ? `Page ${pages[0]} ${singular}.` : `Pages ${pages.join(", ")} ${plural}.`;

/**
 * What the panel says about a state, beyond the results themselves.
 *
 * `uncertain` no longer has results to caveat: a passage below the matched threshold is not offered
 * as a candidate at all (§7). The note is what is left of it — something came close, and saying so
 * is more use than either silence or handing over the near miss.
 */
const STATUS_NOTE: Record<SearchStatus, string | null> = {
    matched: null,
    uncertain: "A passage came close to the relevance threshold but did not meet it, so none is offered. Try rewording the question.",
    no_match: null,
};

/**
 * What an empty result actually means, which is not the same in the two modes.
 *
 * Exact search found no such characters — a literal absence. Meaning search evaluated every
 * passage and none reached the §7 threshold, which is a judgement with a number behind it and can
 * be wrong in both directions. Saying "no relevant passage was found" for both read as a statement
 * about the document rather than about the search.
 */
const emptyResultNote = (mode: SearchMode, everyPageSearched: boolean): string => {
    const scope = everyPageSearched ? "the extracted text" : "the text that could be searched";
    return mode === "exact" ? `No matching text was found in ${scope}.` : `No passage in ${scope} met the relevance threshold.`;
};

export const SearchResults = ({
    hasDocument,
    status,
    results,
    selectedKey,
    onSelect,
    errorMessage,
    locationErrorMessage,
    unsearchedPages,
    unsupportedLayoutPages,
    mode,
    isShowingExtractedText,
    onToggleExtractedText,
    query,
    progress,
}: SearchResultsProps) => {
    // Derived here rather than passed in: position is a property of this rendering of the list, and
    // the list is re-ranked while a meaning search streams.
    const selectedIndex = results.findIndex((result) => result.key === selectedKey);

    const [revealed, setRevealed] = useState(REVEAL_STEP);
    const sentinelRef = useRef<HTMLLIElement>(null);

    // A new result set starts short again.
    useEffect(() => setRevealed(REVEAL_STEP), [results]);

    // Whatever is selected must be mounted, however far down the list it is — Previous and Next
    // move through the whole list, not through the part that happens to be rendered.
    useEffect(() => {
        if (selectedIndex >= 0) setRevealed((current) => Math.max(current, selectedIndex + REVEAL_STEP));
    }, [selectedIndex]);

    // Grows as the reader reaches the end of what is mounted.
    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (sentinel === null) return;

        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) setRevealed((current) => current + REVEAL_STEP);
        });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [revealed, results]);

    if (!hasDocument) return null;

    const debugControl = (
        // `px-3` rather than the panel's `px-6`: the button carries its own padding, and what
        // should line up with the text above is the button's label, not its edge.
        <div className="px-3 pt-1 pb-2">
            <Button size="sm" color="tertiary" onClick={onToggleExtractedText}>
                {isShowingExtractedText ? "Hide extracted text" : "View extracted text"}
            </Button>
        </div>
    );

    if (errorMessage !== null) {
        return (
            <div className="flex flex-col">
                <div className="flex flex-col gap-2 px-5 py-4">
                    <p className="text-sm font-semibold text-error-primary">The search could not be completed</p>
                    <p className="text-sm text-tertiary">{errorMessage}</p>
                </div>
                {debugControl}
            </div>
        );
    }

    // While a meaning search is running there is a list but no verdict, so the progress branch
    // comes before both the empty-query branch and the empty-result one.
    const progressNote =
        progress === null ? null : (
            <div className="flex flex-col gap-1.5 px-5 pt-1 pb-3">
                <p className="text-sm text-tertiary">
                    Reading the document — {progress.evaluated.toLocaleString()} of {progress.total.toLocaleString()} passages judged.
                </p>
                <div className="h-1 w-full overflow-hidden rounded-full bg-quaternary">
                    <div
                        className="h-full rounded-full bg-brand-solid transition-[width] duration-200 ease-linear motion-reduce:transition-none"
                        style={{ width: `${Math.round((progress.evaluated / Math.max(1, progress.total)) * 100)}%` }}
                    />
                </div>
                <p className="text-xs text-quaternary">These are the best so far and may still change.</p>
            </div>
        );

    if (progress !== null && results.length === 0)
        return (
            <div className="flex h-full flex-col">
                {progressNote}
                {debugControl}
            </div>
        );

    if (status === null && progress === null) {
        return (
            <div className="flex flex-col">
                <div className="flex flex-col gap-2 px-5 py-4">
                    <p className="text-sm text-tertiary">Enter a query to search this document.</p>
                    {/*
                     * The two modes differ enough that a reader who picks the wrong one reads the
                     * empty result as a statement about the document. Naming both here costs a line
                     * and is the only place it can be said before the first search.
                     */}
                    <p className="text-xs text-quaternary">
                        <span className="font-semibold">Exact text</span> finds the characters you typed. <span className="font-semibold">Meaning</span> asks
                        the model which passage answers the question, and sends the extracted text to do it.
                    </p>
                </div>
                {debugControl}
            </div>
        );
    }

    if (results.length === 0 && status !== null) {
        return (
            <div className="flex flex-col">
                <div className="flex flex-col gap-2 px-5 py-4">
                    {/*
                     * What was searched and what was found are two separate statements. Naming the
                     * pages that were never searched keeps "no relevant passage" from being read as
                     * "the document does not say" (spec §10).
                     */}
                    <p className="text-sm text-tertiary">
                        {status === "uncertain" ? STATUS_NOTE.uncertain : emptyResultNote(mode, unsearchedPages.length === 0)}
                    </p>
                    {unsearchedPages.length > 0 && <p className="text-sm text-warning-primary">{describePages(unsearchedPages, "could not be searched")}</p>}
                    {unsupportedLayoutPages.length > 0 && (
                        <p className="text-sm text-warning-primary">
                            {describePages(
                                unsupportedLayoutPages,
                                "use a layout this proof of concept does not fully support",
                                "uses a layout this proof of concept does not fully support",
                            )}
                        </p>
                    )}
                    {/*
                     * True of every search, because OCR is never run (spec §10). A page whose heading
                     * is text and whose body is an image is not an excluded page — some text came off
                     * it — so nothing above would mention it, and "no relevant passage" would read as
                     * "the document does not say".
                     */}
                    <p className="text-xs text-quaternary">Text inside images was not searched. This does not prove the document has no answer.</p>
                </div>
                {debugControl}
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            {progressNote}
            {progress === null && status !== null && status !== "matched" && STATUS_NOTE[status] !== null && (
                <p className="px-5 pt-1 pb-3 text-sm text-tertiary">{STATUS_NOTE[status]}</p>
            )}

            {locationErrorMessage !== null && (
                <p className="mx-5 mb-2 rounded-lg bg-warning-primary px-3 py-2 text-sm text-warning-primary">{locationErrorMessage}</p>
            )}

            {/*
             * The count and the arrows sit with the list rather than at the foot of the panel,
             * where two results left them stranded a screen away from what they move between.
             */}
            {/*
             * What the percentages are, in text that is always on screen.
             *
             * It was a `title` tooltip first, which a touch or keyboard reader never sees — so the
             * only thing they got was a number that looks like a measured match. §14.19 is why the
             * caveat has to travel with it: the same passage crossed all three §7 bands depending
             * on which others shared its request.
             */}
            {results.some((result) => result.judgement !== undefined) && (
                <p className="px-6 pt-1 pb-2 text-xs text-quaternary">
                    <span className="font-semibold text-tertiary">Model judgment</span> — how relevant the model called each passage, and how certain it was.
                    Not a measured match: both move with the passages the same request carried.
                </p>
            )}

            {debugControl}

            <div className="flex items-center justify-between gap-2 px-6 pt-1 pb-2">
                <p className="text-xs font-semibold text-tertiary">
                    {results.length} {results.length === 1 ? "result" : "results"}
                </p>
                <div className="flex items-center gap-1">
                    {/* Moving between existing results never triggers another search. */}
                    <Button
                        size="sm"
                        color="tertiary"
                        iconLeading={ArrowLeft}
                        aria-label="Previous"
                        isDisabled={selectedIndex <= 0}
                        onClick={() => onSelect(results[selectedIndex - 1].key)}
                    />
                    <Button
                        size="sm"
                        color="tertiary"
                        iconLeading={ArrowRight}
                        aria-label="Next"
                        isDisabled={selectedIndex >= results.length - 1}
                        onClick={() => onSelect(results[selectedIndex + 1].key)}
                    />
                </div>
            </div>

            <ol className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
                {results.slice(0, revealed).map((result, index) => (
                    <li key={result.key}>
                        <button
                            type="button"
                            onClick={() => onSelect(result.key)}
                            aria-current={index === selectedIndex}
                            className={cx(
                                // Selection is carried by the tint alone, which is the same colour
                                // the passage is highlighted in on the page.
                                "flex w-full cursor-pointer flex-col gap-1.5 rounded-xl px-3 py-2.5 text-left outline-brand transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-1",
                                index === selectedIndex ? "bg-brand-primary" : "hover:bg-primary_hover",
                            )}
                        >
                            <span className="flex items-center gap-2">
                                <span className={cx("text-sm font-semibold", index === selectedIndex ? "text-brand-secondary" : "text-tertiary")}>
                                    {index + 1}.
                                </span>
                                <Badge size="sm" color="gray" type="modern">
                                    Page {result.pageNumber}
                                </Badge>
                                {result.judgement !== undefined && (
                                    <span
                                        className={cx(
                                            "ml-auto text-xs font-semibold tabular-nums",
                                            judgementTone(result.judgement.relevantProbability).className,
                                        )}
                                        // Spelled out for anyone who reaches the row through a screen reader, where
                                        // "95% confident · certainty 0.80" on its own says nothing about whose
                                        // judgement it is. The heading above the list carries the same caveat in
                                        // text, so it is not left to a hover.
                                        aria-label={`Model judgment: ${Math.round(result.judgement.relevantProbability * 100)} per cent relevant, certainty ${result.judgement.confidence.toFixed(2)}`}
                                    >
                                        {Math.round(result.judgement.relevantProbability * 100)}%{" "}
                                        <span className="font-normal">
                                            {judgementTone(result.judgement.relevantProbability).label} · certainty {result.judgement.confidence.toFixed(2)}
                                        </span>
                                    </span>
                                )}
                            </span>
                            <span className="line-clamp-4 text-sm text-secondary">
                                {emphasise(result.previewText, query).map((part, position) =>
                                    part.hit ? (
                                        <mark key={position} className="bg-transparent font-semibold text-primary">
                                            {part.text}
                                        </mark>
                                    ) : (
                                        <span key={position}>{part.text}</span>
                                    ),
                                )}
                            </span>
                        </button>
                    </li>
                ))}

                {revealed < results.length && (
                    <li ref={sentinelRef} className="px-3 py-2 text-xs text-quaternary">
                        {(results.length - revealed).toLocaleString()} more — scroll to load
                    </li>
                )}
            </ol>
        </div>
    );
};
