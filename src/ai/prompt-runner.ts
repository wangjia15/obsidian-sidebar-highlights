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
import type { AiMessage, AiProfile, PromptPreset } from './types';
import { splitNoteIntoChunks } from './note-chunks';

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
    const variables = buildVariables(source, settings, {
        input: options.input,
        targetLanguage: options.targetLanguage,
        fallbackLanguage: uiLanguageName(i18n.getLocale())
    });

    const { messages, interpolation } = buildMessages(prompt, variables);
    const language = options.targetLanguage?.trim() || settings.defaultTargetLanguage.trim();
    if (language && prompt.outputTarget !== 'highlights') {
        const instruction = `Output language: ${language}. This overrides any instruction to answer in the source language. Preserve verbatim quotations and code when needed.`;
        const system = messages.find(message => message.role === 'system');
        if (system) system.content += `\n\n${instruction}`;
        else messages.unshift({ role: 'system', content: instruction });
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
    const language = options.targetLanguage?.trim() || settings.defaultTargetLanguage.trim();
    let interpolation: InterpolationResult | undefined;
    const messageBatches = chunks.map((noteContent, index) => {
        const variables = buildNoteVariables({ ...source, noteContent }, chunkSettings, {
            input: options.input,
            targetLanguage: options.targetLanguage,
            fallbackLanguage: uiLanguageName(i18n.getLocale())
        });
        const built = buildMessages(prompt, variables);
        interpolation ??= built.interpolation;

        if (language && prompt.outputTarget !== 'highlights') {
            appendSystemInstruction(
                built.messages,
                `Output language: ${language}. This overrides any instruction to answer in the source language. Preserve verbatim quotations and code when needed.`
            );
        }
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
        return built.messages;
    });
    const messages = messageBatches[0];

    return {
        prompt,
        profile,
        messages,
        messageBatches,
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
