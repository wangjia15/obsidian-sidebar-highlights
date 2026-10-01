/**
 * Rich content in a mind-map label: LaTeX, images and tables.
 *
 * A highlight or comment is markdown, and a plain-text node turns `$E=mc^2$`,
 * `![[figure.png]]` and a pipe table into unreadable source. This splits a
 * label into blocks the Excalidraw scene can draw properly: math becomes a
 * LaTeX image (the Excalidraw plugin renders `$$…$$` entries of its
 * `## Embedded Files` section), an image becomes an embedded-file image, and a
 * table becomes a grid of cells.
 *
 * Pure and free of Obsidian imports, like the rest of the scene builder. What
 * only the app can know — where an image lives, how large it is, how big a
 * formula renders — comes in through `RichAssets`.
 */

export type RichBlock =
    | { type: 'text'; text: string }
    /** A formula shown as an image. `formula` is complete LaTeX, ready to render. */
    | { type: 'latex'; formula: string }
    /** A paragraph with inline `$…$` in it: text and math flowed together as one LaTeX image. */
    | { type: 'inline-math'; source: string }
    | { type: 'image'; target: string; width?: number }
    | { type: 'table'; header: string[]; rows: string[][]; align: Array<'left' | 'center' | 'right'> };

export interface ImageAsset {
    /** What goes inside `[[…]]` (a vault path) or a bare URL, in `## Embedded Files`. */
    link: string;
    /** True for http(s)/file URLs, which are written without brackets. */
    external?: boolean;
    width: number;
    height: number;
}

export interface FormulaSize {
    width: number;
    height: number;
}

export interface RichAssets {
    /** Resolve an image reference found in a note; null leaves the source text visible. */
    image(target: string, notePath: string | undefined): ImageAsset | null;
    /** Measured size of a rendered formula, when the app could render it. */
    formula(formula: string): FormulaSize | null;
}

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

const IMAGE_TOKEN = /!\[\[([^\]\n]+?)\]\]|!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** `$…$`, or `$$…$$` written inline in a sentence. The formula is in group 1 or 2. */
const INLINE_MATH = /(?<![\\$])(?:\$\$((?:\\.|[^$\\\n])+?)\$\$|\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?![\d$]))/g;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** True when the label has anything an image-based rendering would improve on plain text. */
export function hasRichContent(blocks: RichBlock[]): boolean {
    return blocks.some(block => block.type !== 'text');
}

/**
 * Split a label's markdown into blocks. A label with nothing special in it comes
 * back as one `text` block, which the caller draws exactly as before.
 */
export function parseRichBlocks(markdown: string): RichBlock[] {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    const blocks: RichBlock[] = [];
    let paragraph: string[] = [];

    const flush = () => {
        const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
        paragraph = [];
        if (text) blocks.push(...paragraphBlocks(text));
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith('$$')) {
            const math = takeDisplayMath(lines, i);
            if (math) {
                flush();
                if (math.formula) blocks.push({ type: 'latex', formula: math.formula });
                i = math.last;
                continue;
            }
        }

        if (trimmed.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes('-')) {
            const header = splitRow(line);
            const separator = splitRow(lines[i + 1]);
            if (header.length > 1 || separator.length > 1) {
                flush();
                const rows: string[][] = [];
                let j = i + 2;
                while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
                    rows.push(splitRow(lines[j]));
                    j++;
                }
                blocks.push({
                    type: 'table',
                    header,
                    rows,
                    align: header.map((_, column) => alignOf(separator[column] ?? ''))
                });
                i = j - 1;
                continue;
            }
        }

        paragraph.push(line);
    }
    flush();

    return blocks.length > 0 ? blocks : [{ type: 'text', text: markdown.replace(/\s+/g, ' ').trim() }];
}

/** `$$ … $$` starting on line `start`, on one line or across several. */
function takeDisplayMath(lines: string[], start: number): { formula: string; last: number } | null {
    const first = lines[start].trim().slice(2);
    const sameLine = first.indexOf('$$');
    if (sameLine >= 0) {
        // Text after the closing `$$` on the same line is not ours to swallow.
        if (first.slice(sameLine + 2).trim()) return null;
        return { formula: first.slice(0, sameLine).trim(), last: start };
    }

    const body = [first];
    for (let i = start + 1; i < lines.length; i++) {
        const close = lines[i].indexOf('$$');
        if (close >= 0) {
            if (lines[i].slice(close + 2).trim()) return null;
            body.push(lines[i].slice(0, close));
            return { formula: body.join('\n').trim(), last: i };
        }
        body.push(lines[i]);
    }
    return null;
}

function splitRow(line: string): string[] {
    let row = line.trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);

    const cells: string[] = [];
    let cell = '';
    for (let i = 0; i < row.length; i++) {
        if (row[i] === '\\' && row[i + 1] === '|') {
            cell += '|';
            i++;
        } else if (row[i] === '|') {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += row[i];
        }
    }
    cells.push(cell.trim());
    return cells;
}

function alignOf(separatorCell: string): 'left' | 'center' | 'right' {
    const cell = separatorCell.trim();
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    return cell.endsWith(':') ? 'right' : 'left';
}

/** A paragraph of prose: images lifted out of it, and math pulled together into one block. */
function paragraphBlocks(text: string): RichBlock[] {
    const blocks: RichBlock[] = [];
    let cursor = 0;

    const emitText = (segment: string) => {
        const trimmed = segment.trim();
        if (!trimmed) return;
        blocks.push(...proseBlocks(trimmed));
    };

    for (const match of text.matchAll(IMAGE_TOKEN)) {
        emitText(text.slice(cursor, match.index));
        const target = match[1] !== undefined ? match[1] : match[3];
        const size = match[1] !== undefined ? sizeHint(match[1]) : sizeHint(match[2]);
        blocks.push({ type: 'image', target: stripSizeHint(target, match[1] !== undefined), width: size });
        cursor = (match.index ?? 0) + match[0].length;
    }
    emitText(text.slice(cursor));
    return blocks;
}

/** `![[a.png|300]]` / `![alt|300](a.png)` carry a width after a pipe. */
function sizeHint(text: string): number | undefined {
    const match = /\|\s*(\d+)(?:x\d+)?\s*$/.exec(text);
    return match ? Number(match[1]) : undefined;
}

function stripSizeHint(target: string, wiki: boolean): string {
    return wiki ? target.replace(/\|[^|]*$/, '').trim() : target.trim();
}

function proseBlocks(text: string): RichBlock[] {
    INLINE_MATH.lastIndex = 0;
    const matches = [...text.matchAll(INLINE_MATH)];
    if (matches.length === 0) return [{ type: 'text', text }];

    // A paragraph that is nothing but one formula is the formula, with no text around it to flow with.
    if (matches.length === 1 && matches[0][0] === text) {
        return [{ type: 'latex', formula: (matches[0][1] ?? matches[0][2]).trim() }];
    }
    return [{ type: 'inline-math', source: text }];
}

// --------------------------------------------------------------------------
// LaTeX
// --------------------------------------------------------------------------

/** Rendered formulas are measured at roughly this text size; nodes scale them to their own font. */
export const LATEX_NATURAL_FONT = 20;

/** Characters that mean something to LaTeX, made literal for use inside `\text{…}`. */
function escapeLatexText(text: string): string {
    return text.replace(/[\\{}$&#^_%~]/g, char => {
        switch (char) {
            case '\\': return '\\textbackslash{}';
            case '~': return '\\textasciitilde{}';
            case '^': return '\\textasciicircum{}';
            default: return `\\${char}`;
        }
    });
}

interface InlinePiece {
    kind: 'text' | 'math';
    value: string;
}

function splitInline(source: string): InlinePiece[] {
    INLINE_MATH.lastIndex = 0;
    const pieces: InlinePiece[] = [];
    let cursor = 0;
    for (const match of source.matchAll(INLINE_MATH)) {
        if (match.index! > cursor) pieces.push({ kind: 'text', value: source.slice(cursor, match.index) });
        pieces.push({ kind: 'math', value: (match[1] ?? match[2]).trim() });
        cursor = match.index! + match[0].length;
    }
    if (cursor < source.length) pieces.push({ kind: 'text', value: source.slice(cursor) });
    return pieces;
}

/**
 * Rough width of a formula, for wrapping and for when it cannot be measured.
 * Commands count as one glyph and structure characters as none, which is close
 * enough that a box is not wildly the wrong size.
 */
export function estimateFormulaSize(formula: string): FormulaSize {
    const lines = formula.split(/\\\\/).map(line => line.trim()).filter(Boolean);
    let width = 0;
    for (const line of lines.length > 0 ? lines : ['']) {
        const glyphs = line
            .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^}]*)\}/g, '$1')
            .replace(/\\(?:begin|end)\s*\{[^}]*\}(?:\{[^}]*\})?/g, '')
            .replace(/\\[a-zA-Z]+/g, '#')
            .replace(/[{}^_&\\]/g, '');
        let line_width = 0;
        for (const char of glyphs) {
            line_width += isWide(char) ? LATEX_NATURAL_FONT : LATEX_NATURAL_FONT * 0.55;
        }
        width = Math.max(width, line_width);
    }
    const tall = /\\(?:frac|sum|int|prod|sqrt|begin|binom|lim)/.test(formula);
    const rowHeight = LATEX_NATURAL_FONT * (tall ? 2.2 : 1.5);
    return { width: Math.ceil(Math.max(width, LATEX_NATURAL_FONT)), height: Math.ceil(rowHeight * Math.max(lines.length, 1)) };
}

function isWide(char: string): boolean {
    const code = char.codePointAt(0) ?? 0;
    return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xff00 && code <= 0xffef);
}

/**
 * Turn a paragraph with inline math into one LaTeX formula that wraps at
 * `maxWidth` (in the formula's natural size): prose becomes `\text{…}`, math
 * stays math, and the lines are stacked in a left-aligned array.
 */
export function buildInlineFormula(source: string, maxWidth: number): string {
    const lines: string[][] = [[]];
    let used = 0;

    const place = (latex: string, width: number) => {
        if (used + width > maxWidth && lines[lines.length - 1].length > 0) {
            lines.push([]);
            used = 0;
        }
        lines[lines.length - 1].push(latex);
        used += width;
    };

    for (const piece of splitInline(source)) {
        if (piece.kind === 'math') {
            place(piece.value, estimateFormulaSize(piece.value).width + LATEX_NATURAL_FONT * 0.3);
            continue;
        }
        // Words (and single CJK characters) are the wrap points; a trailing space stays with its word.
        for (const word of piece.value.match(/[^\s⺀-鿿＀-￯]+\s*|\s+|[⺀-鿿＀-￯]/g) ?? []) {
            const width = [...word].reduce((sum, char) => sum + (isWide(char) ? LATEX_NATURAL_FONT : LATEX_NATURAL_FONT * 0.5), 0);
            place(`\\text{${escapeLatexText(word)}}`, width);
        }
    }

    // Neighbouring prose pieces become one `\text`.
    const rows = lines.filter(line => line.length > 0).map(line => line.join('').replace(/\}\\text\{/g, ''));
    if (rows.length <= 1) return rows[0] ?? '';
    return `\\begin{array}{l}${rows.join(' \\\\ ')}\\end{array}`;
}

/** Stable 40-hex file id for an embedded file, as the Excalidraw plugin's own are. */
export function fileIdFor(content: string): string {
    let id = '';
    for (let round = 0; id.length < 40; round++) {
        let hash = (2166136261 ^ Math.imul(round + 1, 0x9e3779b9)) >>> 0;
        for (let i = 0; i < content.length; i++) {
            hash ^= content.charCodeAt(i);
            hash = Math.imul(hash, 16777619) >>> 0;
        }
        id += hash.toString(16).padStart(8, '0');
    }
    return id.slice(0, 40);
}

// --------------------------------------------------------------------------
// Image fitting
// --------------------------------------------------------------------------

export const IMAGE_MAX_WIDTH = 320;
export const IMAGE_MAX_HEIGHT = 320;
export const IMAGE_FALLBACK_SIZE: FormulaSize = { width: 240, height: 160 };

/** Scale an image down to fit the node, never up, honouring a width hint like `![[a.png|200]]`. */
export function fitImage(width: number, height: number, widthHint?: number): FormulaSize {
    if (!(width > 0) || !(height > 0)) return { ...IMAGE_FALLBACK_SIZE };
    const targetWidth = Math.min(widthHint && widthHint > 0 ? widthHint : width, IMAGE_MAX_WIDTH);
    const scale = Math.min(targetWidth / width, IMAGE_MAX_HEIGHT / height);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
