/**
 * Matching re-scanned highlights against the ones already stored.
 *
 * Every edit to a note re-runs detection over the whole file, and each match has
 * to be recognised as an existing highlight or it is replaced by a fresh one —
 * losing its id, and with it its colour, its collections and its creation date.
 *
 * Matching runs in three passes, widening as it goes: exact position, then a
 * nearby position (an edit earlier in the line shifts every offset after it),
 * then text alone when a highlight has moved far and its text is unique in the
 * note. Each stored highlight can only be claimed once, so two identical
 * highlights never collapse into one.
 *
 * Kept free of Obsidian imports so it can be unit tested directly.
 */

export interface ReconcilableHighlight {
    id: string;
    text: string;
    startOffset: number;
    endOffset: number;
    isNativeComment?: boolean;
}

/** How far a highlight may have shifted and still count as the same one. */
export const FUZZY_OFFSET_TOLERANCE = 50;

export type ExistingHighlightMatcher<T extends ReconcilableHighlight> = (
    text: string,
    startOffset: number,
    endOffset: number,
    isComment: boolean
) => T | undefined;

/**
 * A matcher over one file's stored highlights. Stateful by design: it remembers
 * which stored highlights have been claimed, so it must be created fresh for
 * each scan and called in document order.
 */
export function createExistingHighlightMatcher<T extends ReconcilableHighlight>(
    existing: T[]
): ExistingHighlightMatcher<T> {
    const used = new Set<string>();

    // A highlight written by "Create highlight" carries no `isNativeComment` at
    // all, and older stored data may not either. Comparing the raw value against
    // a boolean would make `undefined === false` fail and orphan the highlight
    // on the very next scan, so both sides are normalised.
    const sameKind = (highlight: T, isComment: boolean) => !!highlight.isNativeComment === isComment;

    return (text, startOffset, endOffset, isComment) => {
        const claim = (highlight: T | undefined): T | undefined => {
            if (highlight) used.add(highlight.id);
            return highlight;
        };

        const exact = existing.find(highlight =>
            !used.has(highlight.id) &&
            highlight.text === text &&
            highlight.startOffset === startOffset &&
            highlight.endOffset === endOffset &&
            sameKind(highlight, isComment)
        );
        if (exact) return claim(exact);

        const nearby = existing.find(highlight =>
            !used.has(highlight.id) &&
            highlight.text === text &&
            Math.abs(highlight.startOffset - startOffset) <= FUZZY_OFFSET_TOLERANCE &&
            sameKind(highlight, isComment)
        );
        if (nearby) return claim(nearby);

        // Last resort, and only when the text names exactly one highlight: with
        // duplicates there is no way to tell which one moved where.
        const byText = existing.find(highlight =>
            !used.has(highlight.id) &&
            highlight.text === text &&
            sameKind(highlight, isComment) &&
            !existing.some(other =>
                other !== highlight &&
                other.text === text &&
                sameKind(other, isComment)
            )
        );
        return claim(byText);
    };
}
