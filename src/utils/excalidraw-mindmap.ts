/**
 * Turning highlights (and the comments attached to them) into an Excalidraw mind map.
 *
 * The shape of the map follows the note itself: the note title is the root, its
 * headings nest underneath by level, every highlight hangs off the heading it sits
 * under, and each of a highlight's comments hangs off that highlight. A highlight's
 * colour becomes its node's fill, so the map carries the same colour coding the
 * sidebar shows.
 *
 * Kept free of Obsidian imports so the generated scene can be unit tested directly.
 * The caller resolves headings (from the metadata cache) and colours (from the
 * palette) and passes plain data in.
 */

import { headingForLine } from './heading-group';

/** File extension the Obsidian Excalidraw plugin owns. */
export const EXCALIDRAW_EXTENSION = '.excalidraw.md';

// --------------------------------------------------------------------------
// Input
// --------------------------------------------------------------------------

export interface MindmapHeadingInput {
    heading: string;
    /** 1 for `#`, 2 for `##`, … */
    level: number;
    /** 0-based line of the heading in the note. */
    line: number;
}

export interface MindmapHighlightInput {
    text: string;
    /** Already resolved to a concrete hex value by the caller. */
    color?: string;
    comments?: string[];
    line: number;
}

export interface MindmapNoteInput {
    title: string;
    headings: MindmapHeadingInput[];
    highlights: MindmapHighlightInput[];
    /**
     * Vault path of the note, without the extension. Every node built from this
     * note gets an Excalidraw element link back to it — to the heading it sits
     * under where there is one — which the Excalidraw plugin surfaces as a small
     * link badge on the shape. Omit to draw a map with no links.
     */
    path?: string;
}

// --------------------------------------------------------------------------
// Tree
// --------------------------------------------------------------------------

export type MindmapNodeKind = 'root' | 'note' | 'heading' | 'highlight' | 'comment';

export interface MindmapNode {
    kind: MindmapNodeKind;
    label: string;
    /** Fill colour for highlight nodes; the other kinds derive theirs from the kind. */
    color?: string;
    /** Source line, used only to keep siblings in reading order. */
    line?: number;
    /** Obsidian wiki link back to the place in the note this node came from. */
    link?: string;
    children: MindmapNode[];
}

export interface BuildTreeOptions {
    /** Root label used when more than one note is exported. */
    rootLabel?: string;
    /** Render each highlight's comments as child nodes. Defaults to true. */
    includeComments?: boolean;
}

/**
 * Build the mind map tree.
 *
 * A single note becomes its own root, which is the common case: the note title is
 * the centre of the map. Several notes get a shared root above them so one export
 * is still one drawing.
 *
 * Returns null when nothing would be drawn.
 */
export function buildMindmapTree(notes: MindmapNoteInput[], options: BuildTreeOptions = {}): MindmapNode | null {
    const includeComments = options.includeComments !== false;
    const noteNodes: MindmapNode[] = [];

    for (const note of notes) {
        const node = buildNoteNode(note, includeComments);
        if (node) noteNodes.push(node);
    }

    if (noteNodes.length === 0) return null;
    if (noteNodes.length === 1) return noteNodes[0];

    return {
        kind: 'root',
        label: options.rootLabel || 'Highlights',
        children: noteNodes
    };
}

function buildNoteNode(note: MindmapNoteInput, includeComments: boolean): MindmapNode | null {
    const root: MindmapNode = {
        kind: 'note',
        label: cleanLabel(note.title),
        link: noteLink(note.path),
        children: []
    };

    // Nest headings by level. A heading closes every open heading at its level or
    // deeper, which is what makes `###` land under the `##` above it.
    const headings = [...note.headings].sort((a, b) => a.line - b.line);
    const stack: Array<{ level: number; node: MindmapNode }> = [];
    const byLine = new Map<number, MindmapNode>();

    for (const heading of headings) {
        while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
            stack.pop();
        }
        const parent = stack.length > 0 ? stack[stack.length - 1].node : root;
        const node: MindmapNode = {
            kind: 'heading',
            label: cleanLabel(heading.heading),
            line: heading.line,
            link: noteLink(note.path, heading.heading),
            children: []
        };
        parent.children.push(node);
        stack.push({ level: heading.level, node });
        byLine.set(heading.line, node);
    }

    // Attach every highlight to the nearest heading above it; highlights that
    // precede the first heading hang off the note itself.
    for (const highlight of [...note.highlights].sort((a, b) => a.line - b.line)) {
        const owner = headingForLine(headings, highlight.line);
        const parent = owner ? byLine.get(owner.line) ?? root : root;
        parent.children.push(highlightNode(highlight, includeComments, noteLink(note.path, owner?.heading)));
    }

    sortChildren(root);
    pruneEmptyHeadings(root);

    return root.children.length > 0 ? root : null;
}

function highlightNode(
    highlight: MindmapHighlightInput,
    includeComments: boolean,
    link: string | undefined
): MindmapNode {
    const children: MindmapNode[] = [];
    if (includeComments) {
        for (const comment of highlight.comments ?? []) {
            const label = cleanLabel(comment);
            // A comment's link is its highlight's: the comment is a footnote
            // attached to that spot, so that is where reading it starts.
            if (label) children.push({ kind: 'comment', label, color: highlight.color, link, children: [] });
        }
    }
    return {
        kind: 'highlight',
        label: cleanLabel(highlight.text),
        color: highlight.color,
        line: highlight.line,
        link,
        children
    };
}

/**
 * A wiki link to a note, or to a heading inside it.
 *
 * Obsidian resolves this natively and the Excalidraw plugin turns it into the
 * link badge on a shape, so clicking through needs no protocol handler of ours.
 * Heading granularity is as precise as a wiki link goes without writing block
 * ids into the user's note.
 */
function noteLink(path: string | undefined, heading?: string): string | undefined {
    if (!path) return undefined;

    const target = path.replace(/\.md$/i, '');
    if (!heading) return `[[${target}]]`;

    // `#`, `|` and brackets would end the link or start an alias.
    const anchor = heading.replace(/[#|[\]]/g, '').trim();
    return anchor ? `[[${target}#${anchor}]]` : `[[${target}]]`;
}

/** Keep siblings in reading order, so a heading's own highlights are not pushed below its subheadings. */
function sortChildren(node: MindmapNode): void {
    if (node.kind === 'highlight' || node.kind === 'comment') return;
    node.children.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    node.children.forEach(sortChildren);
}

/** Drop headings that contain no highlights, so filtered exports stay readable. */
function pruneEmptyHeadings(node: MindmapNode): boolean {
    node.children = node.children.filter(child =>
        child.kind === 'heading' ? pruneEmptyHeadings(child) : true
    );
    return node.children.length > 0;
}

/** Collapse the whitespace a multi-line highlight carries so it reads as one label. */
function cleanLabel(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

// --------------------------------------------------------------------------
// Layout
// --------------------------------------------------------------------------

const LINE_HEIGHT = 1.25;
const H_PADDING = 12;
const V_PADDING = 10;
const H_GAP = 80;
const V_GAP = 16;
const MIN_BOX_WIDTH = 90;

interface KindStyle {
    fontSize: number;
    maxTextWidth: number;
    maxLines: number;
    background: string;
    stroke: string;
    strokeStyle: 'solid' | 'dashed';
    strokeWidth: number;
}

const KIND_STYLES: Record<MindmapNodeKind, KindStyle> = {
    root: { fontSize: 20, maxTextWidth: 240, maxLines: 3, background: '#a5d8ff', stroke: '#1971c2', strokeStyle: 'solid', strokeWidth: 2 },
    note: { fontSize: 20, maxTextWidth: 240, maxLines: 3, background: '#a5d8ff', stroke: '#1971c2', strokeStyle: 'solid', strokeWidth: 2 },
    heading: { fontSize: 16, maxTextWidth: 220, maxLines: 3, background: '#e9ecef', stroke: '#495057', strokeStyle: 'solid', strokeWidth: 2 },
    highlight: { fontSize: 14, maxTextWidth: 300, maxLines: 8, background: '#ffec99', stroke: '#1e1e1e', strokeStyle: 'solid', strokeWidth: 1 },
    comment: { fontSize: 13, maxTextWidth: 260, maxLines: 6, background: '#f8f9fa', stroke: '#868e96', strokeStyle: 'dashed', strokeWidth: 1 }
};

interface LaidOutNode {
    node: MindmapNode;
    depth: number;
    /** Position among its siblings, which is what Mindmap Builder's `mindmapOrder` records. */
    orderIndex: number;
    lines: string[];
    fontSize: number;
    x: number;
    y: number;
    width: number;
    height: number;
    textWidth: number;
    textHeight: number;
    background: string;
    stroke: string;
    textColor: string;
    strokeStyle: 'solid' | 'dashed';
    strokeWidth: number;
    children: LaidOutNode[];
}

/**
 * Width of one character at a given font size.
 *
 * Excalidraw measures text with the real font; this only has to be close enough
 * that a box is not visibly too tight or too loose. Full-width characters (CJK,
 * kana, full-width punctuation) take roughly the full em, everything else about
 * half of it.
 */
export function measureText(text: string, fontSize: number): number {
    let width = 0;
    for (const char of text) {
        width += isFullWidth(char) ? fontSize : fontSize * 0.55;
    }
    return width;
}

function isFullWidth(char: string): boolean {
    const code = char.codePointAt(0) ?? 0;
    return (
        (code >= 0x1100 && code <= 0x115f) ||   // Hangul Jamo
        (code >= 0x2e80 && code <= 0x303e) ||   // CJK radicals, punctuation
        (code >= 0x3041 && code <= 0x33ff) ||   // Kana, CJK compatibility
        (code >= 0x3400 && code <= 0x4dbf) ||   // CJK ext A
        (code >= 0x4e00 && code <= 0x9fff) ||   // CJK unified
        (code >= 0xa000 && code <= 0xa4cf) ||   // Yi
        (code >= 0xac00 && code <= 0xd7a3) ||   // Hangul syllables
        (code >= 0xf900 && code <= 0xfaff) ||   // CJK compatibility ideographs
        (code >= 0xfe30 && code <= 0xfe6f) ||   // CJK compatibility forms
        (code >= 0xff00 && code <= 0xff60) ||   // Full-width forms
        (code >= 0xffe0 && code <= 0xffe6)
    );
}

/**
 * Wrap a single-line label to fit `maxWidth`.
 *
 * Latin text breaks on spaces; full-width text breaks between any two characters,
 * because CJK is written without them. A word longer than the line is broken
 * mid-word rather than allowed to overflow.
 */
export function wrapLabel(text: string, maxWidth: number, fontSize: number, maxLines: number): string[] {
    const tokens = tokenize(text);
    const lines: string[] = [];
    let current = '';

    const push = () => {
        if (current.length > 0) lines.push(current);
        current = '';
    };

    for (const token of tokens) {
        const candidate = current + token;
        if (current.length > 0 && measureText(candidate, fontSize) > maxWidth) {
            push();
            // A leading space after a break would look like an indent.
            current = token === ' ' ? '' : token;
        } else {
            current = candidate;
        }

        // Break a single token that cannot fit on a line of its own.
        while (measureText(current, fontSize) > maxWidth && current.length > 1) {
            let cut = current.length - 1;
            while (cut > 1 && measureText(current.slice(0, cut), fontSize) > maxWidth) cut--;
            lines.push(current.slice(0, cut));
            current = current.slice(cut);
        }
    }
    push();

    if (lines.length === 0) return [''];
    if (lines.length <= maxLines) return lines;

    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/\s+$/, '')}…`;
    return kept;
}

/** Split into wrap points: runs of latin word characters, single full-width characters, single spaces. */
function tokenize(text: string): string[] {
    const tokens: string[] = [];
    let buffer = '';

    for (const char of text) {
        if (char === ' ') {
            if (buffer) { tokens.push(buffer); buffer = ''; }
            tokens.push(' ');
        } else if (isFullWidth(char)) {
            if (buffer) { tokens.push(buffer); buffer = ''; }
            tokens.push(char);
        } else {
            buffer += char;
        }
    }
    if (buffer) tokens.push(buffer);
    return tokens;
}

function measureNode(node: MindmapNode, depth: number, orderIndex = 0): LaidOutNode {
    const style = KIND_STYLES[node.kind];
    const lines = wrapLabel(node.label || ' ', style.maxTextWidth, style.fontSize, style.maxLines);
    const textWidth = Math.max(...lines.map(line => measureText(line, style.fontSize)));
    const textHeight = lines.length * style.fontSize * LINE_HEIGHT;

    const background = node.kind === 'highlight' && node.color
        ? node.color
        : node.kind === 'comment' && node.color
            ? mixWithWhite(node.color, 0.72)
            : style.background;
    const stroke = (node.kind === 'highlight' || node.kind === 'comment') && node.color
        ? darken(node.color, 0.45)
        : style.stroke;

    return {
        node,
        depth,
        orderIndex,
        lines,
        fontSize: style.fontSize,
        x: 0,
        y: 0,
        width: Math.max(MIN_BOX_WIDTH, Math.ceil(textWidth) + H_PADDING * 2),
        height: Math.ceil(textHeight) + V_PADDING * 2,
        textWidth: Math.ceil(textWidth),
        textHeight: Math.ceil(textHeight),
        background,
        stroke,
        textColor: readableTextColor(background),
        strokeStyle: style.strokeStyle,
        strokeWidth: style.strokeWidth,
        children: node.children.map((child, index) => measureNode(child, depth + 1, index))
    };
}

/**
 * Place every node: one column per depth, children stacked vertically, each parent
 * centred on the block its children occupy. A parent taller than that block keeps
 * its own height and its children are nudged down to stay centred on it.
 */
function positionNodes(root: LaidOutNode): LaidOutNode {
    const columnWidth = new Map<number, number>();
    forEachNode(root, node => {
        columnWidth.set(node.depth, Math.max(columnWidth.get(node.depth) ?? 0, node.width));
    });

    const columnX = new Map<number, number>();
    let x = 0;
    for (let depth = 0; columnWidth.has(depth); depth++) {
        columnX.set(depth, x);
        x += (columnWidth.get(depth) ?? 0) + H_GAP;
    }

    let cursorY = 0;

    const place = (node: LaidOutNode): void => {
        node.x = columnX.get(node.depth) ?? 0;

        if (node.children.length === 0) {
            node.y = cursorY;
            cursorY += node.height + V_GAP;
            return;
        }

        const start = cursorY;
        node.children.forEach(place);
        const span = cursorY - V_GAP - start;

        if (span < node.height) {
            shift(node.children, (node.height - span) / 2);
            node.y = start;
            cursorY = start + node.height + V_GAP;
        } else {
            const first = node.children[0];
            const last = node.children[node.children.length - 1];
            const centre = (first.y + first.height / 2 + last.y + last.height / 2) / 2;
            node.y = centre - node.height / 2;
        }
    };

    place(root);
    return root;
}

function shift(nodes: LaidOutNode[], dy: number): void {
    for (const node of nodes) {
        node.y += dy;
        shift(node.children, dy);
    }
}

function forEachNode(node: LaidOutNode, fn: (node: LaidOutNode) => void): void {
    fn(node);
    node.children.forEach(child => forEachNode(child, fn));
}

/**
 * A stable name for every node: the labels from the root down, with an
 * occurrence number when siblings share a label. Adding or removing a highlight
 * elsewhere in the note leaves the others' names untouched, which is what keeps
 * their element ids — and any `^id` reference into the drawing — stable when the
 * map is refreshed.
 */
function nodeKeys(root: LaidOutNode): Map<LaidOutNode, string> {
    const keys = new Map<LaidOutNode, string>();

    const visit = (node: LaidOutNode, prefix: string) => {
        const seen = new Map<string, number>();
        for (const child of node.children) {
            const label = child.node.label;
            const occurrence = seen.get(label) ?? 0;
            seen.set(label, occurrence + 1);
            const key = `${prefix} ${occurrence === 0 ? label : `${label}~${occurrence}`}`;
            keys.set(child, key);
            visit(child, key);
        }
    };

    keys.set(root, root.node.label);
    visit(root, root.node.label);
    return keys;
}

// --------------------------------------------------------------------------
// Colour helpers
// --------------------------------------------------------------------------

function parseHex(hex: string): [number, number, number] | null {
    const value = hex.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(value)) {
        return [
            parseInt(value[0] + value[0], 16),
            parseInt(value[1] + value[1], 16),
            parseInt(value[2] + value[2], 16)
        ];
    }
    if (/^[0-9a-f]{6}$/i.test(value)) {
        return [
            parseInt(value.slice(0, 2), 16),
            parseInt(value.slice(2, 4), 16),
            parseInt(value.slice(4, 6), 16)
        ];
    }
    return null;
}

function toHex(rgb: [number, number, number]): string {
    return `#${rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

/** Wash a colour out toward white, so a comment reads as a lighter echo of its highlight. */
export function mixWithWhite(hex: string, amount: number): string {
    const rgb = parseHex(hex);
    if (!rgb) return '#f8f9fa';
    return toHex(rgb.map(c => c + (255 - c) * amount) as [number, number, number]);
}

/** A darker version of a colour, used for the node outline so the fill stays readable. */
export function darken(hex: string, amount: number): string {
    const rgb = parseHex(hex);
    if (!rgb) return '#1e1e1e';
    return toHex(rgb.map(c => c * (1 - amount)) as [number, number, number]);
}

/**
 * Ink for a node filled with `background`.
 *
 * A highlight's own colour becomes its node's fill, and users pick those for how
 * they read behind text in a note, not for how they read behind Excalidraw's
 * default near-black. A deep red or blue swallows it. This returns a very dark
 * shade of the fill itself on light backgrounds — so the label is tinted to
 * match its highlight rather than being uniformly black — and near-white on dark
 * ones, using the WCAG relative-luminance threshold to choose.
 */
export function readableTextColor(background: string): string {
    const rgb = parseHex(background);
    if (!rgb) return '#1e1e1e';

    const channel = (value: number) => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    const luminance =
        0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);

    return luminance > 0.45 ? darken(background, 0.82) : '#ffffff';
}

// --------------------------------------------------------------------------
// Excalidraw scene
// --------------------------------------------------------------------------

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function hashString(input: string, seed: number): number {
    let hash = (2166136261 ^ seed) >>> 0;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
}

/**
 * Excalidraw element ids are eight characters here, not because Excalidraw cares
 * but because the Obsidian plugin's markdown format does: it reads the
 * `## Text Elements` and `## Element Links` sections back with `^(.{8})`
 * patterns, so any other length silently fails to round-trip.
 */
const ID_LENGTH = 8;

/**
 * Ids are a pure function of where the node sits in the map, not random.
 *
 * That is what lets a refresh rewrite the drawing without renaming everything:
 * a node still in the same place under the same heading keeps the id it had, so
 * `^id` block references into the drawing survive.
 */
function deterministicId(key: string, role: string, seed: number): string {
    let id = '';
    for (let round = 0; id.length < ID_LENGTH; round++) {
        let hash = hashString(`${role}:${key}`, (seed + round * 0x9e3779b9) >>> 0);
        for (let i = 0; i < 5 && id.length < ID_LENGTH; i++) {
            id += ID_ALPHABET[hash % ID_ALPHABET.length];
            hash = Math.floor(hash / ID_ALPHABET.length);
        }
    }
    return id;
}

export interface ExcalidrawElement {
    id: string;
    type: string;
    [key: string]: unknown;
}

export interface ExcalidrawScene {
    type: 'excalidraw';
    version: 2;
    source: string;
    elements: ExcalidrawElement[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
}

export interface SceneOptions {
    /**
     * Mixed into every element id. Ids are otherwise a pure function of the map,
     * which is what makes a refresh keep them stable; change this only to make
     * two maps of the same content deliberately distinct.
     */
    seed?: number;
    /** `updated` stamp on every element. Defaults to now. */
    updated?: number;
    /**
     * Direction Mindmap Builder grows the map in when it takes over. One of its
     * GROWTH values: Radial, Right-facing, Left-facing, Right-Left, Up-facing,
     * Down-facing, Up-Down. Defaults to Right-facing, matching how we draw it.
     */
    growthMode?: string;
}

/**
 * The `customData` that makes a drawing a mind map to the Excalidraw plugin's
 * **Mindmap Builder** script, so an exported map can be extended, re-laid out,
 * folded and recoloured by it rather than being a static picture.
 *
 * Its contract (from the script's own traversal):
 * - a root is any element carrying `growthMode` with no branch arrow pointing at it
 * - every other node carries `mindmapOrder`, its 0-based position among siblings
 * - parent and child are joined by an `arrow` carrying `isBranch`, bound
 *   start-to-parent and end-to-child
 *
 * The rest of its per-root configuration (arrow type, font scale, palette…) is
 * deliberately left off, so the map adopts whatever the user has set globally.
 */
export const DEFAULT_GROWTH_MODE = 'Right-facing';

const EXCALIDRAW_SOURCE = 'https://github.com/trevware/obsidian-sidebar-highlights';

/** Build the Excalidraw scene for a mind map tree. */
export function buildMindmapScene(root: MindmapNode, options: SceneOptions = {}): ExcalidrawScene {
    const seed = options.seed ?? 0;
    const updated = options.updated ?? Date.now();

    const taken = new Set<string>();
    const idFor = (key: string, role: string) => {
        let id = deterministicId(key, role, seed);
        // Two different nodes hashing alike would silently merge in Excalidraw.
        for (let attempt = 1; taken.has(id); attempt++) {
            id = deterministicId(`${key}#${attempt}`, role, seed);
        }
        taken.add(id);
        return id;
    };
    const noiseFor = (id: string, salt: number) => hashString(id, salt) % 2 ** 31;

    const laidOut = positionNodes(measureNode(root, 0));

    const containers: ExcalidrawElement[] = [];
    const texts: ExcalidrawElement[] = [];
    const arrows: ExcalidrawElement[] = [];
    const ids = new Map<LaidOutNode, string>();
    const keys = nodeKeys(laidOut);

    forEachNode(laidOut, node => {
        const key = keys.get(node) ?? node.node.label;
        const containerId = idFor(key, 'box');
        const textId = idFor(key, 'text');
        ids.set(node, containerId);

        containers.push({
            id: containerId,
            type: 'rectangle',
            x: round(node.x),
            y: round(node.y),
            width: node.width,
            height: node.height,
            angle: 0,
            strokeColor: node.stroke,
            backgroundColor: node.background,
            fillStyle: 'solid',
            strokeWidth: node.strokeWidth,
            strokeStyle: node.strokeStyle,
            roughness: 1,
            opacity: 100,
            groupIds: [],
            frameId: null,
            roundness: { type: 3 },
            seed: noiseFor(containerId, 1),
            version: 1,
            versionNonce: noiseFor(containerId, 2),
            isDeleted: false,
            boundElements: [{ id: textId, type: 'text' }],
            updated,
            // The Excalidraw plugin draws a link badge on any element with a
            // link, which is how a node gets you back to the note it came from.
            link: node.node.link ?? null,
            locked: false,
            customData: node.depth === 0
                ? { growthMode: options.growthMode || DEFAULT_GROWTH_MODE }
                : { mindmapOrder: node.orderIndex }
        });

        texts.push({
            id: textId,
            type: 'text',
            x: round(node.x + (node.width - node.textWidth) / 2),
            y: round(node.y + (node.height - node.textHeight) / 2),
            width: node.textWidth,
            height: node.textHeight,
            angle: 0,
            strokeColor: node.textColor,
            backgroundColor: 'transparent',
            fillStyle: 'solid',
            strokeWidth: 1,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 100,
            groupIds: [],
            frameId: null,
            roundness: null,
            seed: noiseFor(textId, 1),
            version: 1,
            versionNonce: noiseFor(textId, 2),
            isDeleted: false,
            boundElements: [],
            updated,
            link: null,
            locked: false,
            fontSize: node.fontSize,
            fontFamily: 2,
            text: node.lines.join('\n'),
            // The Obsidian Excalidraw plugin keeps a text element's markdown
            // source here, and writes *that* back into the `## Text Elements`
            // section every time it saves. A text element without it saves as an
            // empty entry, and the label vanishes on the next load — which is
            // exactly what happened when Mindmap Builder re-laid out the map.
            rawText: node.node.label,
            originalText: node.node.label,
            textAlign: 'center',
            verticalAlign: 'middle',
            containerId,
            autoResize: true,
            lineHeight: LINE_HEIGHT
        });
    });

    // Arrows are added after every container has an id, so both bindings resolve.
    forEachNode(laidOut, parent => {
        const parentId = ids.get(parent);
        if (!parentId) return;

        for (const child of parent.children) {
            const childId = ids.get(child);
            if (!childId) continue;

            const startX = parent.x + parent.width;
            const startY = parent.y + parent.height / 2;
            const endX = child.x;
            const endY = child.y + child.height / 2;
            const arrowId = idFor(`${keys.get(parent) ?? ''}>${keys.get(child) ?? ''}`, 'branch');

            arrows.push({
                id: arrowId,
                type: 'arrow',
                x: round(startX),
                y: round(startY),
                width: round(Math.abs(endX - startX)),
                height: round(Math.abs(endY - startY)),
                angle: 0,
                strokeColor: child.stroke,
                backgroundColor: 'transparent',
                fillStyle: 'solid',
                strokeWidth: 1,
                strokeStyle: 'solid',
                roughness: 1,
                opacity: 100,
                groupIds: [],
                frameId: null,
                roundness: { type: 2 },
                seed: noiseFor(arrowId, 1),
                version: 1,
                versionNonce: noiseFor(arrowId, 2),
                isDeleted: false,
                boundElements: null,
                updated,
                link: null,
                locked: false,
                points: [[0, 0], [round(endX - startX), round(endY - startY)]],
                lastCommittedPoint: null,
                startBinding: { elementId: parentId, focus: 0, gap: 4 },
                endBinding: { elementId: childId, focus: 0, gap: 4 },
                startArrowhead: null,
                endArrowhead: null,
                elbowed: false,
                customData: { isBranch: true }
            });

            appendBoundElement(containers, parentId, arrowId);
            appendBoundElement(containers, childId, arrowId);
        }
    });

    return {
        type: 'excalidraw',
        version: 2,
        source: EXCALIDRAW_SOURCE,
        elements: [...containers, ...texts, ...arrows],
        appState: {
            gridSize: null,
            gridStep: 5,
            gridModeEnabled: false,
            viewBackgroundColor: '#ffffff'
        },
        files: {}
    };
}

function appendBoundElement(elements: ExcalidrawElement[], elementId: string, arrowId: string): void {
    const element = elements.find(candidate => candidate.id === elementId);
    if (!element) return;
    const bound = (element.boundElements as Array<{ id: string; type: string }> | null) ?? [];
    bound.push({ id: arrowId, type: 'arrow' });
    element.boundElements = bound;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

// --------------------------------------------------------------------------
// Markdown wrapper
// --------------------------------------------------------------------------

const EXCALIDRAW_BANNER =
    '==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==\n\n' +
    "You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. " +
    "For more info check in plugin settings under 'Saving'";

/**
 * Frontmatter keys that mark a drawing as one of ours and record where its
 * contents came from, so it can be refreshed later rather than re-exported
 * beside itself. The Excalidraw plugin rewrites this file whenever the drawing
 * is edited, but it edits frontmatter key by key and leaves keys it does not
 * own alone, so these survive.
 */
export const MINDMAP_FLAG_KEY = 'sidebar-highlights-mindmap';
export const MINDMAP_SOURCES_KEY = 'sidebar-highlights-sources';

export interface MarkdownOptions {
    /** Note paths the map was built from, recorded for refreshes. */
    sources?: string[];
}

/**
 * Wrap a scene in the markdown envelope the Obsidian Excalidraw plugin reads:
 * frontmatter marking the file as a drawing, a searchable `## Text Elements`
 * list, and the scene JSON inside a `%%`-hidden `## Drawing` section.
 */
export function buildExcalidrawMarkdown(scene: ExcalidrawScene, options: MarkdownOptions = {}): string {
    const textElements = scene.elements
        .filter(element => element.type === 'text')
        .map(element => {
            const label = typeof element.originalText === 'string'
                ? element.originalText
                : typeof element.text === 'string' ? element.text : '';
            return `${label} ^${element.id}`;
        })
        .join('\n\n');

    const sources = options.sources ?? [];
    const provenance = [
        `${MINDMAP_FLAG_KEY}: true`,
        ...(sources.length > 0
            // JSON quoting is also valid YAML, and handles a path with a colon
            // or a quote in it without a YAML library.
            ? [`${MINDMAP_SOURCES_KEY}:`, ...sources.map(path => `  - ${JSON.stringify(path)}`)]
            : [])
    ];

    return [
        '---',
        '',
        'excalidraw-plugin: parsed',
        'tags: [excalidraw]',
        ...provenance,
        '',
        '---',
        EXCALIDRAW_BANNER,
        '',
        '',
        '# Excalidraw Data',
        '',
        '## Text Elements',
        textElements,
        '',
        '%%',
        '## Drawing',
        '```json',
        JSON.stringify(scene, null, '\t'),
        '```',
        '%%',
        ''
    ].join('\n');
}

export interface MindmapFileOptions extends BuildTreeOptions, SceneOptions, MarkdownOptions {}

/**
 * One call from notes to finished `.excalidraw.md` content.
 * Returns null when there is nothing to draw.
 */
export function buildExcalidrawMindmapFile(notes: MindmapNoteInput[], options: MindmapFileOptions = {}): string | null {
    const tree = buildMindmapTree(notes, options);
    if (!tree) return null;
    return buildExcalidrawMarkdown(buildMindmapScene(tree, options), options);
}

/** Strip the characters Obsidian will not accept in a file name. */
export function sanitizeFileName(name: string): string {
    const cleaned = name.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim();
    return cleaned || 'Highlights';
}
