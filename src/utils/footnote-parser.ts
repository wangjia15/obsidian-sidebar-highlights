/**
 * Reading and removing footnote definitions, multi-line ones included.
 *
 * Obsidian follows the MultiMarkdown convention: a `[^key]:` line starts a
 * definition at column zero, and the definition owns every later line indented
 * by four spaces or a tab (blank lines included, as long as indented content
 * follows them). The sidebar used to read only the first line, so a footnote
 * holding a mermaid fence showed up truncated. Everything here works on that
 * same line-based model so writing, reading back and deleting cannot disagree
 * about where a definition ends.
 */

/** The `[^key]: content` line that opens a definition. Column zero only. */
const DEFINITION_START = /^\[\^([A-Za-z0-9_-]+)\]:[ \t]*(.*)$/;

/** A line indented far enough to belong to the definition above it. */
const CONTINUATION_INDENT = /^(?:\t| {4,})/;

/** Strips one level of the definition's shared indentation. */
function dedent(line: string): string {
    return line.replace(/^(?:\t| {1,4})/, '');
}

function isBlank(line: string): boolean {
    return line.trim() === '';
}

export interface DefinitionSpan {
    key: string;
    /** Index of the `[^key]:` line. */
    startLine: number;
    /** Index of the last line the definition owns, continuations included. */
    endLine: number;
    /** The definition's text with the shared indentation removed. */
    content: string;
}

/**
 * Walks the note line by line and returns one span per definition, in order.
 *
 * Continuation rules, matching what Obsidian renders:
 * - an indented line extends the current definition;
 * - a run of blank lines extends it only when indented content follows;
 * - any other line ends it.
 */
function scanDefinitionSpans(cleanLines: string[]): DefinitionSpan[] {
    const spans: DefinitionSpan[] = [];
    let i = 0;

    while (i < cleanLines.length) {
        const start = DEFINITION_START.exec(cleanLines[i]);
        if (!start || start[2].trim() === '') {
            // No content on the definition line means no definition; the old
            // parser absorbed the next line as content, which attributed a
            // random paragraph to the footnote.
            i++;
            continue;
        }

        const contentLines = [start[2].trim()];
        let j = i + 1;

        while (j < cleanLines.length) {
            if (CONTINUATION_INDENT.test(cleanLines[j])) {
                contentLines.push(dedent(cleanLines[j]));
                j++;
                continue;
            }
            if (isBlank(cleanLines[j])) {
                // Blank lines only bridge into a further indented paragraph.
                let k = j;
                while (k < cleanLines.length && isBlank(cleanLines[k])) k++;
                if (k < cleanLines.length && CONTINUATION_INDENT.test(cleanLines[k])) {
                    for (let blank = j; blank < k; blank++) contentLines.push('');
                    j = k;
                    continue;
                }
            }
            break;
        }

        spans.push({ key: start[1], startLine: i, endLine: j - 1, content: contentLines.join('\n') });
        i = j;
    }

    return spans;
}

/**
 * All footnote definitions in the note, keyed by footnote name. Later
 * definitions overwrite earlier ones with the same key, as the old single-line
 * parser did.
 */
export function extractFootnoteDefinitions(content: string): Map<string, string> {
    const cleanLines = content.split('\n').map(line => line.replace(/\r$/, ''));
    return new Map(scanDefinitionSpans(cleanLines).map(span => [span.key, span.content]));
}

/**
 * Deletes one definition together with all of its continuation lines.
 *
 * When a blank line follows the block and body text follows that, the blank is
 * removed too — otherwise every deleted comment would leave the note with an
 * extra empty line.
 */
export function removeFootnoteDefinition(content: string, key: string): string {
    const lines = content.split('\n');
    const cleanLines = lines.map(line => line.replace(/\r$/, ''));

    const span = scanDefinitionSpans(cleanLines).find(candidate => candidate.key === key);
    if (!span) return content;

    let removeThrough = span.endLine;
    if (
        removeThrough + 1 < lines.length &&
        cleanLines[removeThrough + 1].trim() === '' &&
        cleanLines.slice(removeThrough + 2).some(line => line.trim() !== '')
    ) {
        removeThrough++;
    }

    const kept = lines.slice(0, span.startLine).concat(lines.slice(removeThrough + 1));
    return kept.join('\n');
}

/**
 * Every definition's span in character offsets, in document order.
 *
 * For callers that need to know which parts of the note are footnote text
 * rather than prose — writing new markup into a definition would break the
 * footnote instead of marking anything. Shares the scanner above so the
 * continuation rules cannot drift from how definitions are read and deleted.
 */
export function footnoteDefinitionRanges(content: string): { start: number; end: number }[] {
    const lines = content.split('\n');
    const cleanLines = lines.map(line => line.replace(/\r$/, ''));

    // Offsets are line starts in the original text, so the '\n' each split
    // removed has to be counted back in.
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of lines) {
        lineStarts.push(offset);
        offset += line.length + 1;
    }

    return scanDefinitionSpans(cleanLines).map(span => ({
        start: lineStarts[span.startLine],
        end: lineStarts[span.endLine] + cleanLines[span.endLine].length
    }));
}

export interface DefinitionOffsets {
    /** Offset of the `[^key]:` line start. */
    start: number;
    /** Offset just past the definition's last owned line. */
    end: number;
    /** Offset where the comment text itself begins, after `[^key]: `. */
    contentStart: number;
    /** Offset just past the comment text. */
    contentEnd: number;
}

/**
 * Where one definition sits in the note, in character offsets.
 *
 * Callers that put a cursor or a selection on a comment need the whole block,
 * not just the opening line — selecting the first line of a footnote holding a
 * mermaid fence would look like the rest of it is not part of the comment.
 */
export function locateFootnoteDefinition(content: string, key: string): DefinitionOffsets | null {
    const lines = content.split('\n');
    const cleanLines = lines.map(line => line.replace(/\r$/, ''));

    const span = scanDefinitionSpans(cleanLines).find(candidate => candidate.key === key);
    if (!span) return null;

    // Offsets are line starts in the original text, so the '\n' each split
    // removed has to be counted back in.
    const offsetOf = (lineIndex: number): number =>
        lines.slice(0, lineIndex).reduce((total, line) => total + line.length + 1, 0);

    const start = offsetOf(span.startLine);
    const end = offsetOf(span.endLine) + cleanLines[span.endLine].length;

    const prefix = /^\[\^[A-Za-z0-9_-]+\]:[ \t]*/.exec(cleanLines[span.startLine]);
    const contentStart = start + (prefix ? prefix[0].length : 0);

    return { start, end, contentStart, contentEnd: end };
}
