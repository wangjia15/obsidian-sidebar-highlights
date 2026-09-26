/**
 * Turning a model's list of passages into highlights in the note.
 *
 * The hard part is not asking for the passages, it is trusting them. A model
 * asked to quote verbatim will still normalise a run of spaces, drop a stray
 * newline, or wrap the line in quotation marks — and a passage that cannot be
 * found again must never be written into the note as new text, because that
 * would be the plugin inventing content the reader did not write.
 *
 * So nothing here inserts text: every passage is located in the note as it
 * already stands, and only the highlight delimiters are added around it. A
 * passage that cannot be located is reported, not written.
 *
 * Kept free of Obsidian imports so it can be unit tested directly.
 */

import { footnoteDefinitionRanges } from './footnote-parser';
import { createHighlightMarkup } from './highlight-markup';

export interface Range {
    start: number;
    end: number;
}

/**
 * Markup a passage must not be placed inside: an existing highlight, a comment,
 * or a footnote reference. A footnote *definition* spans lines and is found with
 * the footnote parser's own scanner instead of a regex.
 */
const HIGHLIGHT_MARKUP = [
    /==[\s\S]+?==/g,
    /<(mark|span|font)\b[^>]*>[\s\S]*?<\/\1>/gi
] as const;

const EXISTING_MARKUP = [
    ...HIGHLIGHT_MARKUP,
    /%%[\s\S]+?%%/g,
    /\[\^[A-Za-z0-9_-]+\]/g,
    /\^\[[^\]]*\]/g
] as const;

/** Frontmatter, which is metadata rather than text the reader highlights. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---/;

/**
 * Splits a model's answer into candidate passages.
 *
 * Tolerant of the shapes a model reaches for even when told not to — a bullet,
 * a number, surrounding quotes — because rejecting the whole answer over a
 * leading "1. " would be pedantry at the user's expense. What it does not do is
 * repair the passage text itself; that has to match the note.
 */
export function parsePassages(answer: string): string[] {
    const seen = new Set<string>();
    const passages: string[] = [];

    for (const rawLine of answer.replace(/\r\n/g, '\n').split('\n')) {
        const passage = stripListMarkup(rawLine);

        // Length is the only filter, deliberately. Requiring whitespace would
        // have been a way to reject stray one-word lines, but Chinese and
        // Japanese prose has none — it would have thrown away every passage in
        // a CJK note. Filtering barely matters anyway: a stray "Passages:"
        // label is not in the note verbatim, so the matcher drops it for free.
        if (passage.length < MIN_PASSAGE_LENGTH) continue;
        // A heading the model echoed rather than a passage from the body.
        if (/^#{1,6}\s/.test(passage)) continue;
        if (seen.has(passage)) continue;

        seen.add(passage);
        passages.push(passage);
    }

    return passages;
}

/** Shorter than this is a label or a stray word, not a passage worth marking. */
const MIN_PASSAGE_LENGTH = 4;

/** Removes the bullet, numbering and wrapping quotes a model may have added. */
function stripListMarkup(line: string): string {
    let text = line.trim();
    text = text.replace(/^[-*+•]\s+/, '');
    text = text.replace(/^\d+[.)]\s+/, '');
    text = text.replace(/^>\s+/, '');
    // Only a matched pair, so a passage that genuinely opens with a quotation
    // mark keeps it.
    text = text.replace(/^(["'“”‘’«])([\s\S]*)\1$/, '$2');
    text = text.replace(/^[“"«]([\s\S]*)[”"»]$/, '$1');
    return text.trim();
}

export interface MarkOptions {
    /** Hex colour for the highlights written, or empty for plain `==text==`. */
    color?: string;
    /** Ranges nothing may be marked inside, typically code blocks. */
    excludedRanges?: Range[];
}

export interface MarkResult {
    content: string;
    /** Passages marked, in the order they appear in the note. */
    marked: string[];
    /** Passages that could not be found in the note as written. */
    unmatched: string[];
    /** Passages found but already inside a highlight, so left alone. */
    alreadyMarked: string[];
}

/**
 * Wraps each passage in highlight markup, returning the new note text.
 *
 * Edits are applied back to front so that every offset stays valid as the text
 * grows, and each passage is located independently but claims its range, so two
 * passages that overlap cannot both be marked and produce nested delimiters.
 */
export function markPassages(
    content: string,
    passages: string[],
    options: MarkOptions = {}
): MarkResult {
    const highlighted = highlightRanges(content);
    const blocked = [
        ...(options.excludedRanges ?? []),
        ...existingMarkupRanges(content),
        ...frontmatterRange(content)
    ];

    const claimed: Range[] = [];
    const found: { range: Range; passage: string }[] = [];
    const unmatched: string[] = [];
    const alreadyMarked: string[] = [];

    for (const passage of passages) {
        const outcome = findPassage(content, passage, blocked, claimed, highlighted);
        if (outcome === 'blocked') {
            alreadyMarked.push(passage);
            continue;
        }
        if (!outcome) {
            unmatched.push(passage);
            continue;
        }
        claimed.push(outcome);
        found.push({ range: outcome, passage });
    }

    found.sort((a, b) => a.range.start - b.range.start);

    let result = content;
    // Back to front: an earlier edit would move every offset after it.
    for (const { range } of [...found].reverse()) {
        const text = content.slice(range.start, range.end);
        result =
            result.slice(0, range.start) +
            createHighlightMarkup(text, options.color || undefined) +
            result.slice(range.end);
    }

    return {
        content: result,
        marked: found.map(entry => content.slice(entry.range.start, entry.range.end)),
        unmatched,
        alreadyMarked
    };
}

/**
 * Where a passage sits in the note, or why it does not.
 *
 * Returns the range, 'blocked' for an existing highlight, or null when no
 * eligible occurrence exists (including code, metadata and comments).
 */
function findPassage(
    content: string,
    passage: string,
    blocked: Range[],
    claimed: Range[],
    highlighted: Range[]
): Range | 'blocked' | null {
    let sawBlocked = false;

    for (const range of passageCandidates(content, passage)) {
        if (overlapsAny(range, claimed)) continue;
        if (overlapsAny(range, blocked)) {
            if (overlapsAny(range, highlighted)) sawBlocked = true;
            continue;
        }
        return range;
    }

    return sawBlocked ? 'blocked' : null;
}

/** Matching-only normalization, with each unit mapped to original UTF-16 offsets. */
function matchingText(text: string): { text: string; ranges: Range[] } {
    let normalized = '';
    const ranges: Range[] = [];
    for (let start = 0; start < text.length;) {
        let end = start + 1;
        let char = text[start];
        const code = char.charCodeAt(0);
        // Only fullwidth ASCII: avoid compatibility folding unrelated words.
        if (code >= 0xff01 && code <= 0xff5e) char = String.fromCharCode(code - 0xfee0);
        if ('「」“”„‟«»＂'.includes(char)) char = '"';
        if ('『』‘’‚‛‹›＇'.includes(char)) char = "'";
        if (/[-‐‑‒–—―−﹘﹣]/.test(char)) {
            char = '-';
            while (end < text.length && /[-‐‑‒–—―−﹘﹣－]/.test(text[end])) end++;
        }
        if (char === '…' || text.slice(start, start + 3) === '...' || text.slice(start, start + 3) === '．．．') {
            char = '…';
            if (text[start] !== '…') end = start + 3;
        }
        normalized += char;
        ranges.push({ start, end });
        start = end;
    }
    return { text: normalized, ranges };
}

/** Parse each chunk separately, then deduplicate by the same matching rules. */
export function parsePassageAnswers(answers: string[]): string[] {
    const seen = new Set<string>();
    return answers.flatMap(parsePassages).filter(passage => {
        const key = matchingText(passage).text.trim().replace(/[ \t]+/g, ' ');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function passageCandidates(content: string, passage: string): Range[] {
    const original = matchingText(content);
    const parts = matchingText(passage).text.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return [];
    // Preserve the existing single-line whitespace rule.
    const pattern = new RegExp(parts.map(escapeRegex).join('[ \\t]+'), 'g');
    const ranges: Range[] = [];
    for (const match of original.text.matchAll(pattern)) {
        const start = match.index ?? 0;
        ranges.push({ start: original.ranges[start].start, end: original.ranges[start + match[0].length - 1].end });
    }
    return ranges;
}

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function overlapsAny(range: Range, others: Range[]): boolean {
    return others.some(other => range.start < other.end && other.start < range.end);
}

/** Only actual highlights count as already highlighted in completion notices. */
function highlightRanges(content: string): Range[] {
    return HIGHLIGHT_MARKUP.flatMap(pattern =>
        [...content.matchAll(pattern)].map(match => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }))
    );
}

/** Ranges of the note already carrying markup a new highlight must stay out of. */
export function existingMarkupRanges(content: string): Range[] {
    const ranges: Range[] = footnoteDefinitionRanges(content);
    for (const pattern of EXISTING_MARKUP) {
        for (const match of content.matchAll(pattern)) {
            const start = match.index ?? 0;
            ranges.push({ start, end: start + match[0].length });
        }
    }
    return ranges;
}

function frontmatterRange(content: string): Range[] {
    const match = FRONTMATTER.exec(content);
    return match ? [{ start: 0, end: match[0].length }] : [];
}
