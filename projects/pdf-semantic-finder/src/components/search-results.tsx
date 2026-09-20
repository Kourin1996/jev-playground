/**
 * Results panel (spec §3, §7).
 *
 * Shows the physical page number and the original extracted text. No generated explanation and no
 * unsupported precision such as a match percentage.
 */
import { ArrowLeft, ArrowRight } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import type { SearchHit, SearchStatus } from "@/lib/types";
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
    /** Physical pages that produced nothing to search, so an empty result can say so. */
    unsearchedPages: number[];
};

const STATUS_NOTE: Record<SearchStatus, string | null> = {
    matched: null,
    uncertain: "These passages may be related. Review them before relying on them.",
    no_match: "No relevant passage was found.",
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
                <p className="text-sm text-tertiary">
                    {unsearchedPages.length === 0 ? STATUS_NOTE.no_match : "No relevant passage was found in the text that could be searched."}
                </p>
                {unsearchedPages.length > 0 && (
                    <p className="text-sm text-warning-primary">
                        {unsearchedPages.length === 1
                            ? `Page ${unsearchedPages[0]} could not be searched.`
                            : `Pages ${unsearchedPages.join(", ")} could not be searched.`}
                    </p>
                )}
                <p className="text-xs text-quaternary">This does not prove the document has no answer.</p>
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
