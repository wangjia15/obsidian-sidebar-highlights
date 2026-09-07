/**
 * Writing a highlight's colour into the note itself.
 *
 * A colour used to live only in plugin data, so a note opened without this
 * plugin — or read in any other app — showed every highlight in Obsidian's one
 * default colour. Writing `<mark style="background: …">` instead puts the colour
 * where the text is, and the plugin's own HTML parser reads it straight back, so
 * the colour survives a rescan without depending on stored state at all.
 *
 * Only the two forms this plugin creates are rewritten: `==text==` and a `<mark>`
 * it wrote earlier. Anything else — `<span>`, `<font>`, a custom pattern, a
 * native comment — is left alone and reported as unrecognised, so a colour
 * change on it falls back to plugin data rather than mangling the note.
 *
 * Kept free of Obsidian imports so it can be unit tested directly.
 */

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
export function recolorHighlightMarkup(markup: string, color: string): string | null {
    const markdown = MARKDOWN_HIGHLIGHT.exec(markup);
    if (markdown) {
        return color ? wrapInMark(markdown[1], color) : markup;
    }

    const mark = MARK_ELEMENT.exec(markup);
    if (mark) {
        const [, attributes, text] = mark;
        return color ? wrapInMark(text, color, attributes) : `==${text}==`;
    }

    return null;
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
export function createHighlightMarkup(text: string, color?: string): string {
    return color ? wrapInMark(text, color) : `==${text}==`;
}
