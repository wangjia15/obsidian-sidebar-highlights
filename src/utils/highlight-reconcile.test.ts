import { createExistingHighlightMatcher, type ReconcilableHighlight } from './highlight-reconcile';

const highlight = (overrides: Partial<ReconcilableHighlight> & { id: string }): ReconcilableHighlight => ({
    text: 'quote',
    startOffset: 0,
    endOffset: 5,
    ...overrides
});

describe('createExistingHighlightMatcher', () => {
    it('matches a highlight at the same position', () => {
        const stored = highlight({ id: 'a', isNativeComment: false });
        const match = createExistingHighlightMatcher([stored]);

        expect(match('quote', 0, 5, false)).toBe(stored);
    });

    it('matches a highlight that shifted within tolerance', () => {
        const stored = highlight({ id: 'a', startOffset: 100, endOffset: 105, isNativeComment: false });
        const match = createExistingHighlightMatcher([stored]);

        expect(match('quote', 130, 135, false)).toBe(stored);
    });

    it('does not match a highlight that shifted beyond tolerance unless its text is unique', () => {
        const near = highlight({ id: 'a', text: 'shared', startOffset: 0, endOffset: 6 });
        const far = highlight({ id: 'b', text: 'shared', startOffset: 900, endOffset: 906 });
        const match = createExistingHighlightMatcher([near, far]);

        // Both carry the same text, so the text-only pass is off the table and a
        // position 500 characters from either is genuinely unrecognisable.
        expect(match('shared', 500, 506, false)).toBeUndefined();
    });

    it('falls back to text alone when the text names exactly one highlight', () => {
        const stored = highlight({ id: 'a', startOffset: 0, endOffset: 5 });
        const match = createExistingHighlightMatcher([stored]);

        expect(match('quote', 900, 905, false)).toBe(stored);
    });

    it('claims each stored highlight only once', () => {
        const first = highlight({ id: 'a', startOffset: 0, endOffset: 5 });
        const second = highlight({ id: 'b', startOffset: 200, endOffset: 205 });
        const match = createExistingHighlightMatcher([first, second]);

        expect(match('quote', 0, 5, false)).toBe(first);
        expect(match('quote', 200, 205, false)).toBe(second);
        expect(match('quote', 400, 405, false)).toBeUndefined();
    });

    it('keeps highlights and native comments apart', () => {
        const comment = highlight({ id: 'a', isNativeComment: true });
        const match = createExistingHighlightMatcher([comment]);

        expect(match('quote', 0, 5, false)).toBeUndefined();
        expect(match('quote', 0, 5, true)).toBe(comment);
    });

    // The regression this module exists for: "Create highlight" stored a
    // highlight without the flag, so the next scan a second later treated it as
    // brand new and the colour picked in the context menu vanished.
    it('matches a stored highlight that carries no isNativeComment flag', () => {
        const stored = highlight({ id: 'a' });
        const match = createExistingHighlightMatcher([stored]);

        expect(match('quote', 0, 5, false)).toBe(stored);
    });

    it('still keeps an unflagged highlight away from a native comment match', () => {
        const stored = highlight({ id: 'a' });
        const match = createExistingHighlightMatcher([stored]);

        expect(match('quote', 0, 5, true)).toBeUndefined();
    });

    it('matches when only the end offset moved, as it does when markers are added', () => {
        // createHighlight stores the selection's own offsets, then wraps it in
        // `==…==`, so the re-scan sees the same start but an end four wider.
        const stored = highlight({ id: 'a', startOffset: 10, endOffset: 15 });
        const match = createExistingHighlightMatcher([stored]);

        expect(match('quote', 10, 19, false)).toBe(stored);
    });
});
