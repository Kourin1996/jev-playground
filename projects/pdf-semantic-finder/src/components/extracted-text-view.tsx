/**
 * Debug view of the extraction (spec §3, implementation step 2).
 *
 * Shows segment order, IDs, pages, and extracted text so the segment order can be checked against
 * the rendered page.
 */
import { Badge } from "@/components/base/badges/badges";
import type { PdfSegment } from "@/lib/types";
import { countCharacters } from "@/lib/types";

export type ExtractedTextViewProps = {
    segments: PdfSegment[];
};

export const ExtractedTextView = ({ segments }: ExtractedTextViewProps) => (
    <div className="flex flex-col gap-2 p-6">
        {segments.map((segment, index) => (
            <article key={segment.id} className="flex flex-col gap-1.5 rounded-xl bg-secondary p-4">
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
                <p className="text-sm whitespace-pre-wrap text-secondary">{segment.originalText}</p>
            </article>
        ))}
    </div>
);
