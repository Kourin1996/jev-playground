/**
 * Query entry and mode selection (spec §3).
 *
 * No request is made while typing: a search runs only on submit or Enter.
 */
import type { FormEvent } from "react";
import { SearchLg } from "@untitledui/icons";
import { Input } from "@/components/base/input/input";
import { LIMITS } from "@/lib/types";
import type { SearchMode } from "@/lib/types";
import { cx } from "@/utils/cx";

export type SearchBarProps = {
    query: string;
    onQueryChange: (query: string) => void;
    mode: SearchMode;
    onModeChange: (mode: SearchMode) => void;
    onSubmit: () => void;
    isSearching: boolean;
    isDisabled: boolean;
    disabledReason?: string;
};

const MODES: ReadonlyArray<{ value: SearchMode; label: string }> = [
    { value: "exact", label: "Exact text" },
    { value: "meaning", label: "Meaning" },
];

export const SearchBar = ({ query, onQueryChange, mode, onModeChange, onSubmit, isSearching, isDisabled, disabledReason }: SearchBarProps) => {
    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!isDisabled) onSubmit();
    };

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="relative">
                <Input
                    size="md"
                    aria-label="Search query"
                    icon={SearchLg}
                    placeholder="If I cancel halfway, do I get my money back?"
                    value={query}
                    onChange={onQueryChange}
                    isDisabled={isDisabled}
                    maxLength={LIMITS.maxQueryCharacters}
                    wrapperClassName="flex-1"
                    inputClassName="pr-24"
                />
                {/*
                 * Inside the field rather than beside it. Enter already submits, so a second solid
                 * button competed with Open PDF for the eye without carrying any more meaning.
                 */}
                <button
                    type="submit"
                    disabled={isDisabled}
                    className="disabled:text-disabled absolute inset-y-1 right-1 flex items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-brand-secondary transition duration-100 ease-linear not-disabled:cursor-pointer not-disabled:hover:bg-brand-primary"
                >
                    {isSearching && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
                    Search
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {/*
                 * A segmented control rather than two radios: the two modes are one choice, and
                 * the selected half reads at a glance.
                 */}
                <div role="radiogroup" aria-label="Search mode" className="inline-flex rounded-lg bg-secondary p-0.5">
                    {MODES.map((entry) => (
                        <button
                            key={entry.value}
                            type="button"
                            role="radio"
                            aria-checked={mode === entry.value}
                            disabled={isDisabled}
                            onClick={() => onModeChange(entry.value)}
                            className={cx(
                                "disabled:text-disabled rounded-md px-3 py-1.5 text-sm font-semibold outline-brand transition duration-100 ease-linear not-disabled:cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-1",
                                mode === entry.value ? "bg-primary text-primary shadow-xs" : "text-tertiary not-disabled:hover:text-secondary",
                            )}
                        >
                            {entry.label}
                        </button>
                    ))}
                </div>
            </div>

            {disabledReason !== undefined && <p className="text-sm text-error-primary">{disabledReason}</p>}
        </form>
    );
};
