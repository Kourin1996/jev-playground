/**
 * Query entry and mode selection (spec §3).
 *
 * No request is made while typing: a search runs only on submit or Enter.
 */
import type { FormEvent } from "react";
import { SearchLg } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { RadioButton, RadioGroup } from "@/components/base/radio-buttons/radio-buttons";
import { LIMITS } from "@/lib/types";
import type { SearchMode } from "@/lib/types";

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

export const SearchBar = ({ query, onQueryChange, mode, onModeChange, onSubmit, isSearching, isDisabled, disabledReason }: SearchBarProps) => {
    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!isDisabled) onSubmit();
    };

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="flex items-end gap-2">
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
                />
                <Button type="submit" size="md" isDisabled={isDisabled} isLoading={isSearching} showTextWhileLoading>
                    Search
                </Button>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <RadioGroup
                    aria-label="Search mode"
                    value={mode}
                    onChange={(value) => onModeChange(value as SearchMode)}
                    isDisabled={isDisabled}
                    className="flex-row gap-5"
                >
                    <RadioButton value="exact" label="Exact text" />
                    <RadioButton value="meaning" label="Meaning" />
                </RadioGroup>

                {/*
                 * Spec §10's disclosure. It is shown here, beside the control it describes, rather
                 * than as a dialog that has to be dismissed before the first meaning search.
                 */}
                {mode === "meaning" && (
                    <p className="text-xs text-tertiary">
                        Meaning search sends your query and text extracted from the PDF to TypeSafe AI. Use only documents you are permitted to send.
                    </p>
                )}
            </div>

            {disabledReason !== undefined && <p className="text-sm text-error-primary">{disabledReason}</p>}
        </form>
    );
};
