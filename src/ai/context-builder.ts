import type { PromptVariables } from './prompt-library';
import type { AiSettings } from './types';

/**
 * Everything a caller has to gather from the vault before a prompt can run.
 *
 * Deliberately plain data rather than an `App` and a `TFile`: the assembly
 * rules — what gets included, how much, where it is cut — are the part worth
 * testing, and keeping Obsidian out of this module means they can be tested
 * without one.
 */
export interface ContextSource {
    /** The highlight or native comment the user acted on. */
    highlightText: string;
    /** Existing comments on that highlight, in document order. */
    comments?: string[];
    noteTitle?: string;
    filePath?: string;
    tags?: string[];
    collections?: string[];
    /** Full note text. Only read when the settings allow it. */
    noteContent?: string;
    /** Character offset of the highlight within noteContent, for {{context}}. */
    highlightOffset?: number;
}

export interface ContextOptions {
    /** Ad-hoc text the user typed when running the prompt. */
    input?: string;
    /** Overrides the configured default target language. */
    targetLanguage?: string;
    /** The UI language, used as the translation target when nothing is configured. */
    fallbackLanguage?: string;
}

/** Marker appended where text was cut, so the model knows it is seeing an excerpt. */
const ELLIPSIS = '…';

/**
 * Cuts to a character budget without splitting a surrogate pair.
 *
 * Slicing a JS string mid-pair leaves a lone high surrogate, which reaches the
 * model as a replacement character — the sort of corruption that only shows up
 * on emoji and on some CJK extension characters, and never in an English test.
 */
export function truncate(text: string, limit: number): string {
    if (limit <= 0) return '';
    if (text.length <= limit) return text;

    let cut = text.slice(0, limit);
    const lastCode = cut.charCodeAt(cut.length - 1);
    const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
    if (isHighSurrogate) cut = cut.slice(0, -1);

    return cut + ELLIPSIS;
}

/**
 * A window of the note centred on the highlight, for prompts that need to know
 * what surrounds the text without being handed the whole file.
 */
export function windowAround(content: string, offset: number, budget: number): string {
    if (budget <= 0 || content === '') return '';
    if (content.length <= budget) return content;

    const half = Math.floor(budget / 2);
    const start = Math.max(0, Math.min(offset - half, content.length - budget));
    const end = Math.min(content.length, start + budget);

    let slice = content.slice(start, end);
    // Trim a partial surrogate at either edge of the window.
    if (start > 0) {
        const first = slice.charCodeAt(0);
        if (first >= 0xdc00 && first <= 0xdfff) slice = slice.slice(1);
    }
    if (end < content.length) {
        const last = slice.charCodeAt(slice.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1);
    }

    return `${start > 0 ? ELLIPSIS : ''}${slice}${end < content.length ? ELLIPSIS : ''}`;
}

/**
 * Resolves the values a template can reference.
 *
 * The privacy-relevant decisions all live here: note content and existing
 * comments are only ever read when the corresponding setting is on, so a
 * template that references {{note}} on a default install resolves to nothing
 * rather than quietly shipping the whole file.
 */
export function buildVariables(
    source: ContextSource,
    settings: AiSettings,
    options: ContextOptions = {}
): PromptVariables {
    const limit = Math.max(0, settings.contextCharLimit);

    const variables: PromptVariables = {
        selection: source.highlightText.trim(),
        noteTitle: source.noteTitle?.trim() || undefined,
        filePath: source.filePath || undefined,
        tags: source.tags?.length ? source.tags.join(' ') : undefined,
        collection: source.collections?.length ? source.collections.join(', ') : undefined,
        targetLang:
            options.targetLanguage?.trim() ||
            settings.defaultTargetLanguage.trim() ||
            options.fallbackLanguage ||
            undefined,
        input: options.input?.trim() || undefined
    };

    if (settings.includeExistingComments && source.comments?.length) {
        const joined = source.comments.map(comment => comment.trim()).filter(Boolean).join('\n\n');
        if (joined) variables.comments = truncate(joined, limit);
    }

    if (settings.includeNoteContext && source.noteContent) {
        variables.note = truncate(source.noteContent, limit);
        variables.context = source.highlightOffset === undefined
            ? truncate(source.noteContent, limit)
            : windowAround(source.noteContent, source.highlightOffset, limit);
    }

    return variables;
}

/** What a whole-note prompt is assembled from. */
export interface NoteContextSource {
    /** The note's full text, frontmatter and all. */
    noteContent: string;
    noteTitle?: string;
    filePath?: string;
    /** The note's highlights in document order, each with its comments. */
    highlights?: { text: string; comments?: string[] }[];
}

/**
 * The note's highlights as a markdown list, comments nested under the passage
 * they belong to. Lets a whole-note prompt reason about what the reader already
 * marked, rather than only about the text.
 */
export function formatHighlightList(highlights: NoteContextSource['highlights']): string {
    if (!highlights?.length) return '';

    const lines: string[] = [];
    for (const highlight of highlights) {
        const text = highlight.text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        lines.push(`- ${text}`);
        for (const comment of highlight.comments ?? []) {
            const flat = comment.replace(/\s+/g, ' ').trim();
            if (flat) lines.push(`    - ${flat}`);
        }
    }
    return lines.join('\n');
}

/**
 * Resolves the values a whole-note template can reference.
 *
 * Unlike the highlight path, the note text is not gated behind
 * `includeNoteContext`: running a prompt whose entire subject is the document
 * *is* the decision to send the document, and gating it would leave the feature
 * silently answering about nothing. The pre-send confirmation still quotes the
 * exact size, and `noteCharLimit` still bounds it.
 */
export function buildNoteVariables(
    source: NoteContextSource,
    settings: AiSettings,
    options: ContextOptions = {}
): PromptVariables {
    const limit = Math.max(0, settings.noteCharLimit);

    const variables: PromptVariables = {
        note: truncate(source.noteContent, limit),
        noteTitle: source.noteTitle?.trim() || undefined,
        filePath: source.filePath || undefined,
        targetLang:
            options.targetLanguage?.trim() ||
            settings.defaultTargetLanguage.trim() ||
            options.fallbackLanguage ||
            undefined,
        input: options.input?.trim() || undefined
    };

    const list = formatHighlightList(source.highlights);
    if (list) variables.highlights = truncate(list, limit);

    return variables;
}

/**
 * How many characters a run would send. Shown in the pre-send confirmation, so
 * the user is agreeing to a concrete amount rather than to the idea of one.
 */
export function payloadSize(messages: { content: string }[]): number {
    return messages.reduce((total, message) => total + message.content.length, 0);
}
