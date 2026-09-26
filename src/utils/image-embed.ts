/**
 * Image highlights: `==![[photo.png]]==` or `==![alt](photo.png)==`.
 *
 * A highlight whose whole text is one image embed is treated as an image
 * rather than as text — the sidebar shows the picture, and AI prompts send the
 * picture itself to a vision model instead of the embed's markup.
 */

const IMAGE_MIME_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    avif: 'image/avif'
};

/** Formats every vision API we talk to accepts. SVG, BMP and AVIF are not among them. */
const VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface ImageEmbed {
    /** `wiki` for `![[…]]`, `markdown` for `![…](…)`. */
    syntax: 'wiki' | 'markdown';
    /** Vault link path or URL, with any `|size` suffix and angle brackets removed. */
    target: string;
    /** Alt text or wiki alias, when it is not just a size. */
    alt?: string;
}

const WIKI_EMBED = /^!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]$/;
const MARKDOWN_EMBED = /^!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)$/;

export function extensionOf(path: string): string {
    const clean = path.split(/[?#]/)[0];
    const dot = clean.lastIndexOf('.');
    return dot === -1 ? '' : clean.slice(dot + 1).toLowerCase();
}

export function isRemoteUrl(target: string): boolean {
    return /^https?:\/\//i.test(target);
}

/** A `|300` or `|300x200` alias sizes the image; it is not a caption. */
function captionFrom(alias: string | undefined): string | undefined {
    const trimmed = alias?.trim();
    if (!trimmed || /^\d+(x\d+)?$/.test(trimmed)) return undefined;
    return trimmed;
}

/**
 * Parses a highlight's text as an image embed, or returns null when it is
 * anything else — including text that merely contains an image.
 */
export function parseImageEmbed(text: string): ImageEmbed | null {
    const trimmed = text.trim();

    const wiki = WIKI_EMBED.exec(trimmed);
    if (wiki) {
        const target = wiki[1].trim();
        if (!IMAGE_MIME_TYPES[extensionOf(target)]) return null;
        return { syntax: 'wiki', target, alt: captionFrom(wiki[2]) };
    }

    const markdown = MARKDOWN_EMBED.exec(trimmed);
    if (markdown) {
        let target = markdown[2].replace(/^<|>$/g, '').trim();
        if (!isRemoteUrl(target)) {
            try {
                target = decodeURI(target);
            } catch {
                // Leave a malformed escape as written.
            }
            if (!IMAGE_MIME_TYPES[extensionOf(target)]) return null;
        }
        return { syntax: 'markdown', target, alt: captionFrom(markdown[1]) };
    }

    return null;
}

export function isImageHighlightText(text: string): boolean {
    return parseImageEmbed(text) !== null;
}

/** MIME type from a file name or URL, or undefined when it is not an image we know. */
export function imageMimeType(pathOrUrl: string): string | undefined {
    return IMAGE_MIME_TYPES[extensionOf(pathOrUrl)];
}

export function isVisionMimeType(mimeType: string): boolean {
    return VISION_MIME_TYPES.has(mimeType);
}

/** A short name for an image, for prompts and confirmations. */
export function imageDisplayName(embed: ImageEmbed): string {
    const base = embed.target.split(/[?#]/)[0].split('/').pop() || embed.target;
    return embed.alt ? `${embed.alt} (${base})` : base;
}

export interface EmbedRange {
    /** Column range on the line, end exclusive. */
    from: number;
    to: number;
    /** Already wrapped in `==…==`. */
    highlighted: boolean;
}

const EMBED_ON_LINE = /!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^)\n]+\)/.source;

/**
 * The image embed on `line` that column `ch` falls in or touches, so the
 * editor can offer to highlight the image under the cursor.
 */
export function findImageEmbedAt(line: string, ch: number): EmbedRange | null {
    const pattern = new RegExp(EMBED_ON_LINE, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
        const from = match.index;
        const to = from + match[0].length;
        if (ch < from || ch > to) continue;
        if (!parseImageEmbed(match[0])) continue;
        const highlighted = line.slice(Math.max(0, from - 2), from) === '=='
            && line.slice(to, to + 2) === '==';
        return { from, to, highlighted };
    }
    return null;
}

export interface ImageEmbedMatch extends EmbedRange {
    embed: ImageEmbed;
}

/**
 * Every image embed in a note, with document offsets. `highlighted` covers
 * both `==…==` and an HTML `<mark …>…</mark>` wrapper.
 */
export function findImageEmbeds(content: string): ImageEmbedMatch[] {
    const found: ImageEmbedMatch[] = [];
    const pattern = new RegExp(EMBED_ON_LINE, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
        const embed = parseImageEmbed(match[0]);
        if (!embed) continue;
        const from = match.index;
        const to = from + match[0].length;
        const markdown = content.slice(Math.max(0, from - 2), from) === '==' && content.slice(to, to + 2) === '==';
        const html = /<(mark|span|font)\b[^>]*>\s*$/i.test(content.slice(Math.max(0, from - 200), from))
            && /^\s*<\/(mark|span|font)>/i.test(content.slice(to, to + 20));
        found.push({ from, to, highlighted: markdown || html, embed });
    }
    return found;
}
