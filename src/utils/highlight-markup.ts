/**
 * Writing a highlight's colour into the note itself.
 *
 * A colour used to live only in plugin data, so a note opened without this
 * plugin — or read in any other app — showed every highlight in Obsidian's one
 * default colour. Writing `<mark style="background: …">` instead puts the colour
 * where the text is, and the plugin's own HTML parser reads it straight back, so
 * the colour survives a rescan without depending on stored state at all.
 *
 * Colours use Obsidian 1.14's own syntax where there is one: a colour emoji at
 * the start of the highlight, `==🔴 text==`. Colours with no emoji (teal, a
 * custom hex) still use `<mark>`.
 *
 * Only the two forms this plugin creates are rewritten: `==text==` and a `<mark>`
 * it wrote earlier. Anything else — `<span>`, `<font>`, a custom pattern, a
 * native comment — is left alone and reported as unrecognised, so a colour
 * change on it falls back to plugin data rather than mangling the note.
 *
 * Kept free of Obsidian imports so it can be unit tested directly.
 */

/**
 * Obsidian 1.14 colour highlights: the emoji that starts a highlight picks its
 * colour. Yellow is the default highlight, so it has no emoji.
 */
export type ColorEmoji = '🔴' | '🟠' | '🟢' | '🔵' | '🟣';

export interface ColorEmojiPalette {
    /** The user's own palette slots; one left out falls back to a fixed default. */
    red?: string;
    green?: string;
    blue?: string;
    orange?: string;
    purple?: string;
}

const FIXED_EMOJI_COLORS = { '🟠': '#ff9f43', '🟣': '#a78bfa' } as const;
const EMOJI_LIST: ColorEmoji[] = ['🔴', '🟠', '🟢', '🔵', '🟣'];

/** Regex source for an optional leading colour emoji, for building `==…==` search patterns. */
export const COLOR_EMOJI_PREFIX = `(?:(?:${EMOJI_LIST.join('|')})\\s*)?`;

/** The `==text==` pattern for a highlight whose text is already regex-escaped, with or without its colour emoji. */
export function highlightSourcePattern(escapedText: string): string {
    return `==${COLOR_EMOJI_PREFIX}${escapedText}==`;
}

const LEADING_EMOJI = new RegExp(`^(${EMOJI_LIST.join('|')})\\s*`);

/** Split a leading colour emoji off a highlight's text. */
export function splitColorEmoji(text: string): { emoji?: ColorEmoji; text: string } {
    const match = LEADING_EMOJI.exec(text);
    return match ? { emoji: match[1] as ColorEmoji, text: text.slice(match[0].length) } : { text };
}

/** The colour an emoji stands for. */
export function colorForEmoji(emoji: ColorEmoji, palette: ColorEmojiPalette = {}): string {
    switch (emoji) {
        case '🔴': return palette.red ?? '#ff6b6b';
        case '🟢': return palette.green ?? '#96ceb4';
        case '🔵': return palette.blue ?? '#45b7d1';
        case '🟠': return palette.orange ?? FIXED_EMOJI_COLORS['🟠'];
        default: return palette.purple ?? FIXED_EMOJI_COLORS['🟣'];
    }
}

/** The emoji for a colour, or undefined when none stands for it. */
export function emojiForColor(color: string, palette: ColorEmojiPalette): ColorEmoji | undefined {
    const wanted = color.trim().toLowerCase();
    return EMOJI_LIST.find(emoji => colorForEmoji(emoji, palette).toLowerCase() === wanted);
}

/** `==text==`, allowing the newlines a multi-paragraph highlight can contain. */
const MARKDOWN_HIGHLIGHT = /^==([\s\S]+)==$/;

/** A `<mark>` element with its attributes and its inner text. */
const MARK_ELEMENT = /^<mark([^>]*)>([\s\S]*)<\/mark>$/i;

/** The `background` (or `background-color`) declaration inside a style attribute. */
const BACKGROUND_DECLARATION = /background(-color)?\s*:\s*[^;"']+;?\s*/i;

const STYLE_ATTRIBUTE = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i;

/**
 * Rewrite one highlight's source markup so it carries `color`.
 *
 * `color` is a hex value, or an empty string to drop the colour and return the
 * highlight to plain `==text==`. Returns null when the markup is not a form this
 * function owns, and the unchanged string when there is nothing to do.
 */
export function recolorHighlightMarkup(markup: string, color: string, palette?: ColorEmojiPalette): string | null {
    const markdown = MARKDOWN_HIGHLIGHT.exec(markup);
    if (markdown) {
        // A colour change replaces any emoji the highlight already had.
        const text = splitColorEmoji(markdown[1]).text;
        const rewritten = color ? colouredMarkup(text, color, palette) : `==${text}==`;
        return rewritten === markup ? markup : rewritten;
    }

    const mark = MARK_ELEMENT.exec(markup);
    if (mark) {
        const [, attributes, text] = mark;
        const emoji = color && palette ? emojiForColor(color, palette) : undefined;
        if (emoji) return `==${emoji} ${text}==`;
        return color ? wrapInMark(text, color, attributes) : `==${text}==`;
    }

    return null;
}

function colouredMarkup(text: string, color: string, palette?: ColorEmojiPalette): string {
    const emoji = palette ? emojiForColor(color, palette) : undefined;
    return emoji ? `==${emoji} ${text}==` : wrapInMark(text, color);
}

/** True for markup this module can recolour, so a caller can offer the choice. */
export function isRecolorable(markup: string): boolean {
    return MARKDOWN_HIGHLIGHT.test(markup) || MARK_ELEMENT.test(markup);
}

/**
 * Build the `<mark>`, preserving any attributes the existing element carried
 * (a class, an id) and replacing only the background it declares.
 */
function wrapInMark(text: string, color: string, attributes = ''): string {
    const rest = attributes.replace(STYLE_ATTRIBUTE, '').trim();
    const existingStyle = STYLE_ATTRIBUTE.exec(attributes)?.[2] ?? '';

    // Drop the old background but keep anything else the style declared.
    const otherDeclarations = existingStyle
        .replace(BACKGROUND_DECLARATION, '')
        .split(';')
        .map(declaration => declaration.trim())
        .filter(declaration => declaration.length > 0);

    const style = [`background: ${color}`, ...otherDeclarations].join('; ');
    return `<mark${rest ? ` ${rest}` : ''} style="${style};">${text}</mark>`;
}

/** The markup a newly created highlight is written as. */
export function createHighlightMarkup(text: string, color?: string, palette?: ColorEmojiPalette): string {
    return color ? colouredMarkup(text, color, palette) : `==${text}==`;
}
