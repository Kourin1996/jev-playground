/**
 * Results panel (spec §3, §7).
 *
 * Shows the physical page number and the original extracted text. No generated explanation and no
 * unsupported precision such as a match percentage.
 */
import { ArrowLeft, ArrowRight } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import type { SearchHit, SearchMode, SearchStatus } from "@/lib/types";
import { cx } from "@/utils/cx";

export type SearchResultsProps = {
    /** False before a document is open, when the drop zone carries the instruction instead. */
    hasDocument: boolean;
    status: SearchStatus | null;
    results: SearchHit[];
    selectedIndex: number;
    onSelect: (index: number) => void;
    errorMessage: string | null;
    locationErrorMessage: string | null;
    /**
     * Opens a neighbouring passage that travelled as context. Null when the caller cannot resolve
     * one, which is the case for exact results.
     */
    onOpenSegment?: (segmentId: string) => void;
    /** Physical pages that produced nothing to search, so an empty result can say so. */
    unsearchedPages: number[];
    /**
     * Pages whose layout spec §2 does not claim to handle. They were searched, so they are kept
     * apart from `unsearchedPages` — saying they could not be searched would be untrue.
     */
    unsupportedLayoutPages: number[];
    /** Which mode produced this result; an empty result means different things in each. */
    mode: SearchMode;
};

/** "Page 3 could not be searched." / "Pages 3, 4 could not be searched." */
const describePages = (pages: number[], plural: string, singular = plural): string =>
    pages.length === 1 ? `Page ${pages[0]} ${singular}.` : `Pages ${pages.join(", ")} ${plural}.`;

const STATUS_NOTE: Record<SearchStatus, string | null> = {
    matched: null,
    uncertain: "These passages may be related. Review them before relying on them.",
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
    selectedIndex,
    onSelect,
    errorMessage,
    locationErrorMessage,
    unsearchedPages,
    unsupportedLayoutPages,
    onOpenSegment,
    mode,
}: SearchResultsProps) => {
    if (!hasDocument) return null;

    if (errorMessage !== null) {
        return (
            <div className="flex flex-col gap-2 px-5 py-4">
                <p className="text-sm font-semibold text-error-primary">The search could not be completed</p>
                <p className="text-sm text-tertiary">{errorMessage}</p>
            </div>
        );
    }

    if (status === null) {
        return (
            <div className="px-5 py-4">
                <p className="text-sm text-tertiary">Enter a query to search this document.</p>
            </div>
        );
    }

    if (results.length === 0) {
        return (
            <div className="flex flex-col gap-2 px-5 py-4">
                {/*
                 * What was searched and what was found are two separate statements. Naming the
                 * pages that were never searched keeps "no relevant passage" from being read as
                 * "the document does not say" (spec §10).
                 */}
                <p className="text-sm text-tertiary">{emptyResultNote(mode, unsearchedPages.length === 0)}</p>
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
        );
    }

    return (
        <div className="flex h-full flex-col">
            {status !== "matched" && STATUS_NOTE[status] !== null && <p className="px-5 pt-1 pb-3 text-sm text-tertiary">{STATUS_NOTE[status]}</p>}

            {locationErrorMessage !== null && (
                <p className="mx-5 mb-2 rounded-lg bg-warning-primary px-3 py-2 text-sm text-warning-primary">{locationErrorMessage}</p>
            )}

            <ol className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pb-2">
                {results.map((result, index) => (
                    <li key={result.key}>
                        <button
                            type="button"
                            onClick={() => onSelect(index)}
                            aria-current={index === selectedIndex}
                            className={cx(
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
                            </span>
                            <span className="line-clamp-4 text-sm text-secondary">{result.previewText}</span>
                        </button>

                        {/*
                         * The neighbours that travelled with this passage, on the selected result
                         * only. §6.3 lets the model read them to resolve what the passage refers
                         * to, so a clause whose limit lives next door — 前項の期限を守った場合に限り
                         * — is unreadable without them.
                         *
                         * "Sent with", never "used": the response does not report which context
                         * influenced the answer, and saying otherwise would invent evidence.
                         */}
                        {index === selectedIndex && (result.contextBefore !== undefined || result.contextAfter !== undefined) && (
                            <details className="px-3 pb-1">
                                <summary className="cursor-pointer py-1 text-xs text-quaternary select-none">Context sent with this passage</summary>
                                <div className="flex flex-col gap-1.5 pt-1 pb-1">
                                    {([result.contextBefore, result.contextAfter] as const).map(
                                        (context, position) =>
                                            context !== undefined && (
                                                <button
                                                    key={context.segmentId}
                                                    type="button"
                                                    onClick={() => onOpenSegment?.(context.segmentId)}
                                                    disabled={onOpenSegment === undefined}
                                                    className="rounded-lg px-2 py-1.5 text-left text-xs text-quaternary not-disabled:cursor-pointer not-disabled:hover:bg-primary_hover"
                                                >
                                                    <span className="font-semibold">{position === 0 ? "before" : "after"}</span>
                                                    <span className="line-clamp-3"> {context.text}</span>
                                                </button>
                                            ),
                                    )}
                                </div>
                            </details>
                        )}
                    </li>
                ))}
            </ol>

            <div className="flex items-center justify-between gap-2 px-5 pt-2 pb-4">
                {/* Moving between existing results never triggers another search. */}
                <Button size="sm" color="secondary" iconLeading={ArrowLeft} isDisabled={selectedIndex <= 0} onClick={() => onSelect(selectedIndex - 1)}>
                    Previous
                </Button>
                <Button
                    size="sm"
                    color="secondary"
                    iconTrailing={ArrowRight}
                    isDisabled={selectedIndex >= results.length - 1}
                    onClick={() => onSelect(Math.max(0, selectedIndex + 1))}
                >
                    Next
                </Button>
            </div>
        </div>
    );
};
