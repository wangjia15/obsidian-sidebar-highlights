/**
 * Expressing a rewritten document as the one range that actually changed.
 *
 * Whole-note AI produces a new version of the note as a string, but handing an
 * open editor a whole new document throws away the user's undo history and
 * cursor along with it. Reducing the rewrite to a single range replacement
 * keeps both, and keeps the change legible in the editor's own undo stack —
 * one step named after what it did, not "everything changed".
 *
 * Kept free of Obsidian imports so it can be unit tested directly.
 */

export interface TextEdit {
    /** Offset in the original text where the replacement starts. */
    from: number;
    /** Offset in the original text where the replacement ends. */
    to: number;
    text: string;
}

/** True when cutting here would split a surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
    if (index <= 0 || index >= text.length) return false;
    const high = text.charCodeAt(index - 1);
    const low = text.charCodeAt(index);
    return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * The smallest single replacement that turns `before` into `after`, or null
 * when they are already the same.
 *
 * Found by trimming the shared prefix and the shared suffix, which for the
 * rewrites here — a section replaced, a set of passages wrapped — narrows to
 * the part of the note that was actually touched. It is one range rather than a
 * true diff, so scattered edits collapse into the span that contains them; that
 * is still far better than replacing the document, and it can never be wrong,
 * only wider than necessary.
 */
export function minimalEdit(before: string, after: string): TextEdit | null {
    if (before === after) return null;

    let start = 0;
    const maxStart = Math.min(before.length, after.length);
    while (start < maxStart && before[start] === after[start]) start++;
    // Never cut between the halves of an astral character.
    if (splitsSurrogatePair(before, start) || splitsSurrogatePair(after, start)) start--;

    let end = 0;
    const maxEnd = Math.min(before.length, after.length) - start;
    while (
        end < maxEnd &&
        before[before.length - 1 - end] === after[after.length - 1 - end]
    ) end++;
    if (
        splitsSurrogatePair(before, before.length - end) ||
        splitsSurrogatePair(after, after.length - end)
    ) end--;

    return {
        from: start,
        to: before.length - end,
        text: after.slice(start, after.length - end)
    };
}
