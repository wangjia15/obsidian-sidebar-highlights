/**
 * Turning a model's answer into a footnote.
 *
 * Pure string work, deliberately: the editor manipulation lives in the view,
 * but which key to allocate, what the text may contain and where the
 * definition goes are the parts that can silently corrupt a note, so they are
 * testable on their own.
 */

/** Matches both references `[^1]` and definitions `[^1]:`. */
const ANY_FOOTNOTE_KEY = /\[\^([A-Za-z0-9_-]+)\]/g;

export type FootnoteStyle = 'inline' | 'standard';

export interface FootnoteInsertion {
    style: FootnoteStyle;
    /** Text to place immediately after the highlight. */
    reference: string;
    /** Line to append at the end of the note; null for inline footnotes. */
    definition: string | null;
    /** Allocated key, or null for inline footnotes. */
    key: string | null;
}

/**
 * Picks a key no existing footnote uses.
 *
 * Scans references as well as definitions: a reference whose definition was
 * deleted still reserves its key, and reusing it would silently adopt the
 * orphan.
 */
export function nextFootnoteKey(content: string): string {
    let highest = 0;
    const taken = new Set<string>();

    for (const match of content.matchAll(ANY_FOOTNOTE_KEY)) {
        const key = match[1];
        taken.add(key);
        if (/^\d+$/.test(key)) {
            highest = Math.max(highest, Number(key));
        }
    }

    let candidate = highest + 1;
    while (taken.has(String(candidate))) candidate++;
    return String(candidate);
}

/**
 * Whether text can live inside `^[...]`.
 *
 * The inline form is delimited by a closing bracket and cannot span lines, so
 * a `]` or a newline in the answer would truncate the comment at that
 * character. Anything failing this test has to become a standard footnote,
 * whatever the user's preferred style is.
 */
export function canUseInlineFootnote(text: string): boolean {
    return !/[\]\n\r]/.test(text);
}

export interface FormatOptions {
    /**
     * Whether the target can hold more than one line.
     *
     * True for standard footnotes: their indented continuation lines are read
     * back whole. False for inline footnotes, which cannot span lines.
     */
    allowMultiline: boolean;
}

/**
 * Normalizes a model answer for storage in a footnote.
 *
 * Collapsing to one line is lossy, so it happens only when the destination
 * truly cannot hold a line break — an inline footnote. Standard footnotes
 * keep the model's paragraphs, lists and fenced blocks intact.
 */
export function formatForFootnote(text: string, options: FormatOptions): string {
    const trimmed = text.replace(/\r\n/g, '\n').trim();
    if (options.allowMultiline) return trimmed;

    return trimmed
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
        .join(' ')
        .replace(/[ \t]{2,}/g, ' ');
}

/**
 * Lays comment text out as a definition: first line on the `[^key]:` line,
 * every later line indented by four spaces, which is what makes the parser —
 * and Obsidian — read the whole block back as one footnote.
 */
function formatDefinition(key: string, commentText: string): string {
    const lines = commentText.split('\n');
    const rest = lines.slice(1).map(line => (line.trim() === '' ? '' : `    ${line}`));
    const continuation = rest.length === 0 ? '' : `\n${rest.join('\n')}`;
    return `[^${key}]: ${lines[0]}${continuation}`;
}

/**
 * Builds the reference and definition for one comment.
 *
 * `preferInline` is the user's setting, not a guarantee: text the inline form
 * cannot hold falls back to a standard footnote rather than being mangled.
 */
export function buildFootnote(
    noteContent: string,
    commentText: string,
    preferInline: boolean
): FootnoteInsertion {
    if (preferInline && canUseInlineFootnote(commentText)) {
        return { style: 'inline', reference: `^[${commentText}]`, definition: null, key: null };
    }

    const key = nextFootnoteKey(noteContent);
    return {
        style: 'standard',
        reference: `[^${key}]`,
        definition: formatDefinition(key, commentText),
        key
    };
}

/**
 * Whether the note's last line belongs to a footnote definition: either the
 * `[^key]:` line itself or one of its indented continuation lines.
 */
function endsWithFootnoteDefinition(body: string): boolean {
    const lines = body.split('\n');
    let i = lines.length - 1;
    // Step back over continuation lines to the definition that owns them.
    while (i > 0 && /^(?:\t| {4,})/.test(lines[i])) i--;
    return /^\[\^[A-Za-z0-9_-]+\]:/.test(lines[i]);
}

/**
 * Appends a definition at the end of the note, which is where Obsidian's own
 * footnote command puts them. Normalizes the gap to exactly one blank line so
 * repeated inserts do not accumulate whitespace.
 */
export function appendFootnoteDefinition(content: string, definition: string): string {
    const body = content.replace(/\s+$/, '');
    if (body === '') return `${definition}\n`;

    // A run of definitions belongs together; anything else gets a blank line.
    const separator = endsWithFootnoteDefinition(body) ? '\n' : '\n\n';

    return `${body}${separator}${definition}\n`;
}

/**
 * The parts of a highlight needed to find it again in the file. Structurally
 * satisfied by `Highlight`, but stated narrowly so this module stays testable
 * with plain objects.
 */
export interface HighlightAnchor {
    text: string;
    startOffset: number;
    isNativeComment?: boolean;
    /** Set for custom-pattern highlights, where the delimiters are user-defined. */
    fullMatch?: string;
    /**
     * How the highlight is written in the note. Only a hint: a highlight that
     * was recoloured after the sidebar last read it has changed form without
     * changing its text, so every form is tried whatever this says.
     */
    type?: 'highlight' | 'comment' | 'html' | 'custom';
}

export interface HighlightLocation {
    matchStart: number;
    matchEnd: number;
    /** Where a new footnote reference belongs: after any already attached. */
    insertAt: number;
}

/** A run of footnote references, standard or inline, directly after a highlight. */
const ATTACHED_FOOTNOTES = /^(\s*(\[\^[A-Za-z0-9_-]+\]|\^\[[^\]]+\]))*/;

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The tags an HTML highlight can be written with; see utils/html-highlight-parser.ts. */
const HTML_HIGHLIGHT_TAGS = 'mark|span|font';

/**
 * The forms this highlight might be written in, most likely first.
 *
 * More than one, because the note is the only source of truth about markup and
 * the sidebar's copy of it can be a step behind. Colouring a highlight rewrites
 * `==text==` as `<mark style="…">text</mark>`, so a stored `==` highlight and a
 * `<mark>` in the note are routinely the same highlight — searching for only
 * one form is what made a coloured highlight read as "moved" and refuse the
 * comment.
 */
function searchPatternsFor(anchor: HighlightAnchor): RegExp[] {
    const exact = anchor.fullMatch ? [new RegExp(escapeRegex(anchor.fullMatch), 'g')] : [];

    // A custom pattern's delimiters are user-defined, so the stored match is the
    // only thing safe to search for — falling back to `==text==` could attach
    // the comment to an unrelated highlight that happens to share the text.
    // Before HTML highlights stored a match of their own, only custom patterns
    // had one, so a missing type here means custom too.
    if (anchor.fullMatch && anchor.type !== 'html') return exact;
    if (!anchor.text) return exact;

    const text = escapeRegex(anchor.text);
    if (anchor.isNativeComment) return [...exact, new RegExp(`%%${text}%%`, 'g')];

    const markdown = new RegExp(`==${text}==`, 'g');
    // Whitespace either side because an HTML highlight's stored text comes from
    // the element's textContent, which a formatter may have padded since.
    const html = new RegExp(`<(${HTML_HIGHLIGHT_TAGS})\\b[^>]*>\\s*${text}\\s*</\\1>`, 'gi');

    return anchor.type === 'html' ? [...exact, html, markdown] : [...exact, markdown, html];
}

/**
 * The occurrence of `pattern` closest to the stored offset.
 *
 * Offsets drift as a note is edited, so the stored offset is a hint rather
 * than an address: every occurrence of the same text is a candidate and the
 * nearest one wins. Identical highlights in one note are the reason this
 * cannot simply take the first match.
 */
function nearestMatch(
    content: string,
    pattern: RegExp,
    offset: number
): { start: number; end: number } | null {
    let best: { start: number; end: number } | null = null;
    let bestDistance = Infinity;

    for (const match of content.matchAll(pattern)) {
        // matchAll always supplies an index; the type does not say so because
        // RegExpExecArray is shared with exec() on a non-global pattern.
        const start = match.index ?? 0;
        const distance = Math.abs(start - offset);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = { start, end: start + match[0].length };
        }
    }

    return best;
}

/** Finds the highlight in the note and says where a new comment attaches. */
export function locateHighlight(content: string, anchor: HighlightAnchor): HighlightLocation | null {
    let best: { start: number; end: number } | null = null;

    for (const pattern of searchPatternsFor(anchor)) {
        best = nearestMatch(content, pattern, anchor.startOffset);
        if (best) break;
    }

    if (!best) return null;

    // Attach after any footnotes already on this highlight, so a second
    // comment lands beside the first rather than between it and the text.
    const attached = ATTACHED_FOOTNOTES.exec(content.slice(best.end));
    const attachedLength = attached ? attached[0].length : 0;

    return { matchStart: best.start, matchEnd: best.end, insertAt: best.end + attachedLength };
}

export interface CommentWrite {
    content: string;
    style: FootnoteStyle;
    key: string | null;
}

/** One range replacement, in offsets over the text the edits were computed from. */
export interface CommentEdit {
    text: string;
    from: number;
    /** Equal to `from` for a pure insertion. */
    to: number;
}

/**
 * The same comment as range edits rather than as new content, for a caller that
 * holds an editor instead of a string.
 *
 * Every offset is in the *pre-edit* text and the edits must be applied in the
 * order returned, which is what makes that safe: the definition goes at the end
 * of the note, so applying it first cannot move the reference position that
 * comes before it.
 *
 * Range edits rather than replacing the whole document, because a document-wide
 * write throws away the editor's undo history and the user's cursor with it.
 */
export function commentEditsForHighlight(
    content: string,
    anchor: HighlightAnchor,
    commentText: string,
    preferInline: boolean
): CommentEdit[] | null {
    const location = locateHighlight(content, anchor);
    if (!location) return null;

    const footnote = buildFootnote(content, commentText, preferInline);
    const edits: CommentEdit[] = [];

    if (footnote.definition) {
        // Everything up to the trailing whitespace is byte-identical either
        // way, so that is all the definition edit has to touch.
        const unchanged = content.replace(/\s+$/, '').length;
        edits.push({
            text: appendFootnoteDefinition(content, footnote.definition).slice(unchanged),
            from: unchanged,
            to: content.length
        });
    }

    edits.push({ text: footnote.reference, from: location.insertAt, to: location.insertAt });

    return edits;
}

/**
 * Produces the note's new content with one comment added, or null when the
 * highlight can no longer be found — which happens when the text was edited
 * after the sidebar last read it, and is a case that must not write anything.
 */
export function writeCommentForHighlight(
    content: string,
    anchor: HighlightAnchor,
    commentText: string,
    preferInline: boolean
): CommentWrite | null {
    const location = locateHighlight(content, anchor);
    if (!location) return null;

    const footnote = buildFootnote(content, commentText, preferInline);
    const withReference =
        content.slice(0, location.insertAt) + footnote.reference + content.slice(location.insertAt);

    const finalContent = footnote.definition
        ? appendFootnoteDefinition(withReference, footnote.definition)
        : withReference;

    return { content: finalContent, style: footnote.style, key: footnote.key };
}
