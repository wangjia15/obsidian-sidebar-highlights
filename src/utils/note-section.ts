/**
 * Writing a named section into a note, and rewriting it on the next run.
 *
 * Used by whole-note prompts whose answer belongs in the note: the prompt's
 * name becomes a heading, and running it again replaces what is under that
 * heading instead of leaving a second copy below the first.
 *
 * Two things it is careful about, both learned from what else writes to the end
 * of a note:
 *
 * - A trailing run of footnote definitions is the note's comment store, and
 *   this plugin appends to it. A section is inserted *above* that run, and a
 *   section's body never extends across a definition — otherwise adding a
 *   comment and then re-running the prompt would delete the comment.
 * - Frontmatter is never a section and is never touched.
 *
 * Kept free of Obsidian imports so it can be unit tested directly.
 */

import { footnoteDefinitionRanges } from './footnote-parser';

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

export const SECTION_HEADING_LEVEL = 2;

interface Lines {
    lines: string[];
    /** True for a line that belongs to a footnote definition block. */
    isDefinition: boolean[];
}

function splitLines(content: string): Lines {
    const lines = content.split('\n');

    const lineOfOffset: number[] = [];
    let offset = 0;
    lines.forEach((line, index) => {
        for (let i = 0; i <= line.length; i++) lineOfOffset[offset + i] = index;
        offset += line.length + 1;
    });

    const isDefinition = lines.map(() => false);
    for (const range of footnoteDefinitionRanges(content)) {
        const first = lineOfOffset[range.start] ?? 0;
        const last = lineOfOffset[Math.max(range.start, range.end - 1)] ?? first;
        for (let i = first; i <= last; i++) isDefinition[i] = true;
    }

    return { lines, isDefinition };
}

function headingAt(line: string): { level: number; title: string } | null {
    const match = HEADING.exec(line);
    return match ? { level: match[1].length, title: match[2] } : null;
}

/** Where the note's frontmatter ends, as a line index. */
function bodyStart(lines: string[]): number {
    if (lines[0]?.trim() !== '---') return 0;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') return i + 1;
    }
    return 0;
}

/**
 * The line holding the named heading, or -1. Compared on the heading text and
 * ignoring its level, so a user who demoted the heading by hand keeps their
 * section rather than gaining a second one.
 */
function findHeading(lines: string[], heading: string): number {
    const wanted = heading.trim();
    for (let i = bodyStart(lines); i < lines.length; i++) {
        if (headingAt(lines[i])?.title === wanted) return i;
    }
    return -1;
}

/**
 * The last line the section owns: up to the next heading at the same level or
 * higher, the first footnote definition, or the end of the note.
 */
function sectionEnd(state: Lines, headingLine: number, level: number): number {
    const { lines, isDefinition } = state;
    for (let i = headingLine + 1; i < lines.length; i++) {
        if (isDefinition[i]) return i - 1;
        const found = headingAt(lines[i]);
        if (found && found.level <= level) return i - 1;
    }
    return lines.length - 1;
}

/**
 * The line a new section should go before: the start of the trailing run of
 * footnote definitions, or the end of the note when there is none.
 */
function insertionPoint(state: Lines): number {
    const { lines, isDefinition } = state;

    let candidate = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (isDefinition[i]) {
            candidate = i;
            continue;
        }
        if (lines[i].trim() === '') continue;
        break;
    }
    return candidate;
}

function trimBlankEdges(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === '') start++;
    while (end > start && lines[end - 1].trim() === '') end--;
    return lines.slice(start, end);
}

/**
 * Adds or replaces the section under `heading`, returning the new note text.
 *
 * The body is written as given, between one blank line and the next, and the
 * note always ends in a single newline — so the result is stable under repeated
 * runs: replacing a section produces exactly what creating it would have.
 */
export function replaceSection(content: string, heading: string, body: string): string {
    const title = heading.trim() || 'AI';
    const bodyLines = trimBlankEdges(body.replace(/\r\n/g, '\n').split('\n'));
    if (bodyLines.length === 0) return content;

    const state = splitLines(content);
    const { lines } = state;
    const existing = findHeading(lines, title);

    const join = (before: string[], section: string[], after: string[]): string => [
        ...(before.length > 0 ? [...before, ''] : []),
        ...section,
        ...(after.length > 0 ? ['', ...after] : []),
        ''
    ].join('\n');

    if (existing !== -1) {
        const level = headingAt(lines[existing])?.level ?? SECTION_HEADING_LEVEL;
        const end = sectionEnd(state, existing, level);
        return join(
            trimBlankEdges(lines.slice(0, existing)),
            [lines[existing], '', ...bodyLines],
            trimBlankEdges(lines.slice(end + 1))
        );
    }

    const at = insertionPoint(state);
    return join(
        trimBlankEdges(lines.slice(0, at)),
        [`${'#'.repeat(SECTION_HEADING_LEVEL)} ${title}`, '', ...bodyLines],
        trimBlankEdges(lines.slice(at))
    );
}
