import { TFile } from 'obsidian';
import { i18n } from '../i18n';
import type HighlightCommentsPlugin from '../../main';
import type { Highlight } from '../../main';
import {
    buildNoteVariables,
    buildVariables,
    payloadSize,
    type ContextSource,
    type NoteContextSource
} from './context-builder';
import { buildMessages, type InterpolationResult } from './prompt-library';
import { providerLabel } from './registry';
import type { AiMessage, AiProfile, AiSettings, PromptPreset } from './types';
import { splitNoteIntoChunks } from './note-chunks';
import { applyOutputLanguage, promptFixesItsOwnLanguage, resolveOutputLanguage } from './output-language';
import { loadImageForAi } from './image-loader';
import { imageDisplayName, parseImageEmbed } from '../utils/image-embed';

export interface RunOptions {
    /** Ad-hoc text the user typed when launching the prompt. */
    input?: string;
    /** Overrides the configured default translation target. */
    targetLanguage?: string;
    /** Profile to use instead of the active one. */
    profile?: AiProfile;
}

export interface PreparedRun {
    prompt: PromptPreset;
    profile: AiProfile;
    messages: AiMessage[];
    /** Several requests when a whole document exceeds the per-request limit. */
    messageBatches?: AiMessage[][];
    /** Builds the request that folds several parts' answers into one; see PromptPreset.mergeParts. */
    mergeMessages?: (partTexts: string[]) => AiMessage[];
    interpolation: InterpolationResult;
    /** Characters that will leave the machine, for the pre-send confirmation. */
    payloadChars: number;
    destination: { provider: string; baseUrl: string; model: string };
}

/**
 * Gathers everything a prompt may reference.
 *
 * The note is read from disk only when the setting allows it. Gating at the
 * I/O boundary rather than only when resolving variables means a default
 * install never even loads the file, so there is nothing in memory to leak
 * through a future bug.
 */
export async function collectContextSource(
    plugin: HighlightCommentsPlugin,
    highlight: Highlight
): Promise<ContextSource> {
    const source: ContextSource = {
        highlightText: highlight.text,
        comments: highlight.footnoteContents?.filter(comment => comment.trim() !== ''),
        filePath: highlight.filePath,
        tags: highlight.tags,
        collections: resolveCollectionNames(plugin, highlight),
        highlightOffset: highlight.startOffset
    };

    const file = plugin.app.vault.getAbstractFileByPath(highlight.filePath);
    if (file instanceof TFile) {
        source.noteTitle = file.basename;
        if (plugin.settings.ai.includeNoteContext) {
            source.noteContent = await plugin.app.vault.cachedRead(file);
        }
    }

    return source;
}

/**
 * Everything a whole-note prompt reads, gathered from the vault.
 *
 * The note text is read unconditionally, unlike the highlight path: see
 * `buildNoteVariables` for why running a document prompt is itself the decision
 * to send the document.
 */
export async function collectNoteSource(
    plugin: HighlightCommentsPlugin,
    file: TFile
): Promise<NoteContextSource> {
    return {
        noteContent: await plugin.app.vault.cachedRead(file),
        noteTitle: file.basename,
        filePath: file.path,
        // Document order, which is the order the note makes its points in and
        // the only order a list of passages reads sensibly in.
        highlights: [...(plugin.highlights.get(file.path) ?? [])]
            .sort((a, b) => a.startOffset - b.startOffset)
            .map(highlight => ({
                text: highlight.text,
                // Not gated on includeExistingComments: the note text being
                // sent alongside already contains every footnote definition, so
                // withholding the list would hide nothing.
                comments: highlight.footnoteContents?.filter(comment => comment.trim() !== '')
            }))
    };
}

function resolveCollectionNames(plugin: HighlightCommentsPlugin, highlight: Highlight): string[] {
    if (!highlight.collectionIds?.length) return [];
    return highlight.collectionIds
        .map(id => plugin.collections.get(id)?.name)
        .filter((name): name is string => Boolean(name));
}

/**
 * Resolves the language name to translate into when the user has configured
 * none. Obsidian's own locale is the best available guess at what the reader
 * wants, and it beats leaving {{targetLang}} empty and asking a model to
 * "translate into ".
 */
export function uiLanguageName(locale: string): string {
    return locale.startsWith('zh') ? '简体中文' : 'English';
}

/**
 * Everything needed to show a confirmation and then send, with nothing sent
 * yet. Splitting preparation from dispatch is what lets the confirmation quote
 * a real payload size rather than an estimate.
 */
export async function preparePromptRun(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    highlight: Highlight,
    options: RunOptions = {}
): Promise<PreparedRun> {
    const settings = plugin.settings.ai;
    const profile = options.profile ?? plugin.aiService.getActiveProfile();
    if (!profile) {
        throw new Error('No AI profile is configured');
    }

    const source = await collectContextSource(plugin, highlight);

    // An image highlight sends the picture, not its embed markup: the model
    // is told the image's name in place of the text, and gets the image
    // itself attached to the request.
    const embed = parseImageEmbed(highlight.text);
    const image = embed ? await loadImageForAi(plugin.app, embed, highlight.filePath) : undefined;
    if (embed) source.highlightText = `[image: ${imageDisplayName(embed)}]`;

    const variables = buildVariables(source, settings, {
        input: options.input,
        targetLanguage: options.targetLanguage,
        fallbackLanguage: uiLanguageName(i18n.getLocale())
    });

    const { messages, interpolation } = buildMessages(prompt, variables) as { messages: AiMessage[]; interpolation: InterpolationResult };
    const language = resolveOutputLanguage(settings, uiLanguageName(i18n.getLocale()), options.targetLanguage);
    if (language && !promptFixesItsOwnLanguage(prompt)) {
        applyOutputLanguage(messages, language);
    }
    if (image) {
        const user = messages.find(message => message.role === 'user');
        if (user) user.images = [image];
    }


    return {
        prompt,
        profile,
        messages,
        interpolation,
        payloadChars: payloadSize(messages),
        destination: {
            provider: providerLabel(profile),
            baseUrl: profile.baseUrl,
            model: profile.model
        }
    };
}

export interface PreparedNoteRun extends PreparedRun {
    file: TFile;
    chunkCount: number;
}

/** The whole-note counterpart of preparePromptRun. */
export async function prepareNotePromptRun(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    file: TFile,
    options: RunOptions = {}
): Promise<PreparedNoteRun> {
    const settings = plugin.settings.ai;
    const profile = options.profile ?? plugin.aiService.getActiveProfile();
    if (!profile) {
        throw new Error('No AI profile is configured');
    }

    const source = await collectNoteSource(plugin, file);
    // One limit, used to split and then to bound each piece. buildNoteVariables
    // truncates by `noteCharLimit` of its own accord, so splitting by a larger
    // number than it will accept would cut every chunk short again — which is
    // exactly the silent loss the chunking exists to avoid. The floor is here
    // because a request that carries a few hundred characters of a note is not
    // worth making, however low the setting was left.
    const chunkLimit = Math.max(500, settings.noteCharLimit);
    const chunkSettings = { ...settings, noteCharLimit: chunkLimit };
    const chunks = splitNoteIntoChunks(source.noteContent, chunkLimit);
    const language = promptFixesItsOwnLanguage(prompt)
        ? undefined
        : resolveOutputLanguage(settings, uiLanguageName(i18n.getLocale()), options.targetLanguage);
    let interpolation: InterpolationResult | undefined;
    const messageBatches = chunks.map((noteContent, index) => {
        const variables = buildNoteVariables({ ...source, noteContent }, {
            ...chunkSettings,
            // Atomic frontmatter/code may exceed the target; never truncate it.
            noteCharLimit: Math.max(chunkLimit, noteContent.length)
        }, {
            input: options.input,
            targetLanguage: options.targetLanguage,
            fallbackLanguage: uiLanguageName(i18n.getLocale())
        });
        const built = buildMessages(prompt, variables) as { messages: AiMessage[]; interpolation: InterpolationResult };
        interpolation ??= built.interpolation;
        if (prompt.outputTarget === 'new-markdown') {
            appendSystemInstruction(built.messages, 'Output valid Markdown without wrapping it in a Markdown code fence.');
        } else if (prompt.outputTarget === 'new-html') {
            appendSystemInstruction(built.messages, 'Output only an HTML fragment suitable for a document body. Do not include Markdown fences, <!doctype>, <html>, <head>, or <body> tags.');
        }
        if (chunks.length > 1) {
            appendSystemInstruction(
                built.messages,
                `The source document is split into ${chunks.length} parts. This request contains part ${index + 1}. Process this part in document order, preserve continuity, and do not mention the split.`
            );
        }
        // Last, so the reminder it adds is the final line of the request.
        if (language) applyOutputLanguage(built.messages, language);
        return built.messages;
    });
    const messages = messageBatches[0];

    const mergeMessages = prompt.mergeParts && chunks.length > 1
        ? (partTexts: string[]) => buildMergeMessages(prompt, source, chunkSettings, options, language, partTexts)
        : undefined;

    return {
        prompt,
        profile,
        messages,
        messageBatches,
        mergeMessages,
        interpolation: interpolation ?? { text: '', unknown: [], missing: [] },
        payloadChars: messageBatches.reduce((sum, batch) => sum + payloadSize(batch), 0),
        destination: {
            provider: providerLabel(profile),
            baseUrl: profile.baseUrl,
            model: profile.model
        },
        file,
        chunkCount: chunks.length
    };
}

function appendSystemInstruction(messages: AiMessage[], instruction: string): void {
    const system = messages.find(message => message.role === 'system');
    if (system) system.content += `\n\n${instruction}`;
    else messages.unshift({ role: 'system', content: instruction });
}

/**
 * The request that folds a split document's partial answers into one.
 *
 * It restates the original task — with the document itself left out, since
 * not fitting is why it was split — so the merged answer keeps the shape the
 * prompt asked for rather than the shape of a summary of summaries.
 */
function buildMergeMessages(
    prompt: PromptPreset,
    source: NoteContextSource,
    settings: AiSettings,
    options: RunOptions,
    language: string | undefined,
    partTexts: string[]
): AiMessage[] {
    const variables = buildNoteVariables({ ...source, noteContent: '' }, settings, {
        input: options.input,
        targetLanguage: options.targetLanguage,
        fallbackLanguage: uiLanguageName(i18n.getLocale())
    });
    const task = buildMessages(prompt, { ...variables, note: '[the document, supplied in parts]' }).messages;
    const system = task.find(message => message.role === 'system')?.content;
    const instructions = task.find(message => message.role === 'user')?.content ?? '';

    const parts = partTexts
        .map((text, index) => `--- Partial result ${index + 1} of ${partTexts.length} ---\n${text}`)
        .join('\n\n');

    const messages: AiMessage[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({
        role: 'user',
        content: `A long document was processed in ${partTexts.length} consecutive parts with the task below, producing one partial result per part. Merge them into a single result that completes the task as if the whole document had been read at once: follow the task's required structure exactly, remove repetition, reconcile overlaps, and keep specific numbers, names and terms. Do not mention the parts.\n\n=== Original task ===\n${instructions}\n\n=== Partial results ===\n${parts}`
    });
    if (language) applyOutputLanguage(messages, language);
    return messages;
}
