import { MarkdownView, Menu, Notice, TFile, normalizePath } from 'obsidian';
import type HighlightCommentsPlugin from '../../main';
import { t } from '../i18n';
import { describeAiError, logSafe } from '../ai/ai-service';
import { enabledPromptsForScope } from '../ai/prompt-library';
import { prepareNotePromptRun, type PreparedNoteRun } from '../ai/prompt-runner';
import { AiConfirmSendModal } from '../modals/ai-confirm-send-modal';
import { openAiResultView } from './ai-result-view';
import type { AiResult, PromptOutputTarget, PromptPreset } from '../ai/types';
import { markPassages, parsePassages } from '../utils/passage-marker';
import { replaceSection } from '../utils/note-section';
import { minimalEdit } from '../utils/text-edit';
import { sanitizeFileName } from '../utils/excalidraw-mindmap';
import { runAiMessageBatches } from '../ai/multi-part-runner';

/**
 * Whole-note AI: prompts that read the document rather than one highlight.
 *
 * The things a note prompt can do are deliberately different in kind, and
 * the difference is what the output target names:
 *
 * - `preview` answers a question about the note and touches nothing.
 * - `append` writes the answer into the note under its own heading, replacing
 *   what a previous run of the same prompt left there.
 * - `highlights` finds the passages the model picked out and marks them where
 *   they already are, so they appear in the sidebar like any other highlight.
 * - `new-markdown` and `new-html` stream into a result panel like `preview`,
 *   and offer to save the finished answer as a document. Nothing is written
 *   until the user asks: a document is a thing in the vault, and one made from
 *   an answer nobody has read yet is as likely to be deleted as kept.
 * Only `highlights` needs explaining: it never writes the model's text into
 * the note. See utils/passage-marker.ts.
 */

/** Whether the toolbar button and its commands should exist at all. */
export function noteAiAvailable(plugin: HighlightCommentsPlugin): boolean {
    return plugin.settings.ai.enabled && enabledPromptsForScope(plugin.settings.ai.prompts, 'note').length > 0;
}

/** The menu behind the toolbar's whole-note AI button. */
export function showNoteAiMenu(plugin: HighlightCommentsPlugin, file: TFile, event: MouseEvent): void {
    const menu = new Menu();
    for (const prompt of enabledPromptsForScope(plugin.settings.ai.prompts, 'note')) {
        menu.addItem(item => {
            item.setTitle(prompt.name)
                .setIcon(prompt.icon ?? 'sparkles')
                .onClick(() => { void runNotePrompt(plugin, prompt, file); });
        });
    }
    menu.showAtMouseEvent(event);
}

/** Runs one whole-note prompt end to end: readiness, confirmation, dispatch. */
export async function runNotePrompt(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    file: TFile
): Promise<void> {
    const problem = plugin.aiService.checkReadiness();
    if (problem) {
        new Notice(t(problem.reasonKey));
        return;
    }

    let prepared: PreparedNoteRun;
    try {
        prepared = await prepareNotePromptRun(plugin, prompt, file);
    } catch (error) {
        new Notice(describeAiError(error));
        return;
    }

    if (prepared.chunkCount > 1) {
        new Notice(t('ai.note.chunked', { count: prepared.chunkCount }), 6000);
    }

    const proceed = () => {
        // Everything that ends in a human deciding goes to the panel; only the
        // two targets that write into the note itself run headless.
        if (prompt.outputTarget === 'append' || prompt.outputTarget === 'highlights') {
            void runNoteWrite(plugin, prompt, file, prepared);
            return;
        }
        void openNotePanel(plugin, prompt, file, prepared);
    };

    // "Don't ask again" was answered about an ordinary run — one request, one
    // note's worth of cost. A note that splits into this many is a different
    // question, and the difference is money, so it is put to the user even
    // though the answer to the smaller one was no.
    const forced = prepared.chunkCount >= MANY_REQUESTS;
    if (!plugin.settings.ai.confirmBeforeSend && !forced) {
        proceed();
        return;
    }

    new AiConfirmSendModal(plugin.app, prepared, dontAskAgain => {
        if (dontAskAgain) {
            plugin.settings.ai.confirmBeforeSend = false;
            void plugin.saveSettings();
        }
        proceed();
    }, { forced: forced && !plugin.settings.ai.confirmBeforeSend }).open();
}

/**
 * How many requests a whole-note run may take before it is confirmed whatever
 * the confirmation setting says. Ten is where a run stops being one call with
 * a rounding error of a cost and starts being a decision.
 */
const MANY_REQUESTS = 10;

/**
 * Opens the result panel for a whole-note prompt and starts the run in it.
 *
 * A `preview` prompt gets the "write it into the note" button; the two
 * document targets get the pair that saves the answer as a file. The document
 * targets deliberately do not get the section-write button: the user chose a
 * separate document, and the note they ran this on is not where it goes.
 */
async function openNotePanel(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    file: TFile,
    prepared: PreparedNoteRun
): Promise<void> {
    const format = formatForTarget(prompt.outputTarget);

    await openAiResultView(plugin, {
        prompt,
        source: {
            sourcePath: file.path,
            prepare: profile => prepareNotePromptRun(plugin, prompt, file, { profile })
        },
        prepared,
        // A document target is the one case where a chunked answer's own fences
        // matter, because the text becomes a file rather than something read.
        joinParts: format ? joinAnswerParts : undefined,
        actions: format
            ? {
                preferredFormat: format,
                createDocument: async (text, chosen) => {
                    await createGeneratedDocument(plugin, prompt, file, chosen, text);
                }
            }
            : {
                // Even a read-only prompt is worth being able to keep, and the
                // section write is the same one `append` performs.
                insertLabel: t('modals.aiResult.insertSection'),
                onInsert: async text => {
                    await appendAnswerToNote(plugin, prompt, file, text);
                    return true;
                }
            }
    });
}

/**
 * Runs all chunks and writes the combined answer into the note itself.
 *
 * Only `append` and `highlights` end up here. Their result belongs in the note
 * the user is already looking at, so they run headless behind a progress notice
 * rather than opening a panel to be read first — the note is the panel.
 */
async function runNoteWrite(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    file: TFile,
    prepared: PreparedNoteRun
): Promise<void> {
    const controller = new AbortController();
    const notice = new Notice('', 0);
    notice.messageEl.createDiv({ text: t('ai.note.working', { name: prompt.name, note: file.basename }) });
    const progressEl = notice.messageEl.createDiv({ cls: 'sh-ai-run-progress' });

    const stop = notice.messageEl.createEl('button', { cls: 'sh-ai-batch-stop', text: t('ai.batch.stop') });
    stop.addEventListener('click', () => {
        controller.abort();
        stop.disabled = true;
    });

    // Once real text is arriving, it is what the notice should show; the
    // thinking only fills the silence before it.
    let answered = false;

    try {
        const { combined: answer, parts } = await runAiMessageBatches(
            plugin.aiService,
            prepared.messageBatches ?? [prepared.messages],
            {
                profile: prepared.profile,
                signal: controller.signal,
                // Running a write-back prompt a second time is a request for a
                // second answer, not for the first one again. There is no
                // regenerate button on this path, so the cache would otherwise
                // be inescapable.
                bypassCache: true,
                merge: prepared.mergeMessages,
                onText: text => {
                    if (text) answered = true;
                    progressEl.setText(tail(text, 140));
                },
                // Without this a reasoning model leaves the notice blank for
                // minutes and the run looks stuck rather than slow.
                onReasoning: text => { if (!answered) progressEl.setText(tail(text, 140)); }
            }
        );
        for (const part of parts) plugin.recordAiUsage(part);
        notice.hide();

        if (prompt.outputTarget === 'highlights') {
            await markAnswerPassages(plugin, file, answer.text);
        } else {
            await appendAnswerToNote(plugin, prompt, file, answer.text);
        }
    } catch (error) {
        notice.hide();
        new Notice(describeAiError(error), 8000);
    }
}

/** Which new-file format an output target asks for, if it asks for one at all. */
function formatForTarget(target: PromptOutputTarget): GeneratedDocumentFormat | null {
    if (target === 'new-html') return 'html';
    if (target === 'new-markdown') return 'md';
    return null;
}

export type GeneratedDocumentFormat = 'md' | 'html';

/**
 * Saves a finished answer as a document beside the source note.
 *
 * Nothing is created until the user asks for it from the result panel. The
 * answer has been on screen and possibly followed up on by then, so this is a
 * plain one-shot write rather than the streamed fill-in an unread file needed.
 *
 * Markdown opens in a tab; HTML does not. Obsidian has no view for `.html`, so
 * a tab on one shows the "open this file in the default app" placeholder rather
 * than the document — the notice names the path instead.
 */
export async function createGeneratedDocument(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    source: TFile,
    format: GeneratedDocumentFormat,
    answer: string
): Promise<TFile | null> {
    const text = stripSingleCodeFence(answer.trim());
    if (!text) {
        new Notice(t('ai.run.emptyAnswer'));
        return null;
    }

    try {
        const file = await plugin.app.vault.create(
            generatedDocumentPath(plugin, source, prompt.name, format),
            format === 'html' ? asHtmlDocument(text, prompt.name) : `${text}\n`
        );
        if (format === 'md') await plugin.app.workspace.getLeaf('tab').openFile(file);
        new Notice(t('ai.note.created', { path: file.path }));
        return file;
    } catch (error) {
        console.error('Sidebar Highlights: failed to create the generated document:', logSafe(error));
        new Notice(t('ai.run.writeFailed'));
        return null;
    }
}

/** The next free path for a generated document, beside the source note. */
function generatedDocumentPath(
    plugin: HighlightCommentsPlugin,
    source: TFile,
    promptName: string,
    format: GeneratedDocumentFormat
): string {
    const parent = source.parent?.path === '/' ? '' : (source.parent?.path ?? '');
    const base = sanitizeFileName(`${source.basename} - ${promptName}`);
    let suffix = 1;
    let path = normalizePath(`${parent ? `${parent}/` : ''}${base}.${format}`);
    while (plugin.app.vault.getAbstractFileByPath(path)) {
        suffix++;
        path = normalizePath(`${parent ? `${parent}/` : ''}${base} ${suffix}.${format}`);
    }
    return path;
}

/**
 * The requests' answers as one document, each stripped of its own code fence.
 *
 * A model told to emit Markdown wraps the reply in a fence anyway often enough
 * to be worth undoing, and a chunked note gets one fence per part. Stripping
 * only the joined answer would leave every fence but the outermost behind — and
 * for HTML those stray backticks end up inside `<main>`.
 */
function joinAnswerParts(parts: AiResult[]): string {
    return parts
        .map(part => stripSingleCodeFence(part.text.trim()))
        .filter(text => text !== '')
        .join('\n\n');
}

function stripSingleCodeFence(text: string): string {
    const match = /^```(?:html|markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(text);
    return (match?.[1] ?? text).trim();
}

function asHtmlDocument(fragment: string, title: string): string {
    if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(fragment)) return `${fragment}\n`;
    const safeTitle = title.replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char] ?? char);
    return `<!doctype html>\n<html lang="">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${safeTitle}</title>\n</head>\n<body>\n<main>\n${fragment}\n</main>\n</body>\n</html>\n`;
}

/**
 * Applies a whole-note rewrite, through the open editor when there is one.
 *
 * The editor path exists for the same two reasons as it does for comments: its
 * buffer is up to two seconds ahead of the file, so a vault write would discard
 * whatever was typed since the last flush; and going through the editor puts
 * the change in the undo stack, which for a rewrite that touches the document
 * wholesale is the difference between a reversible action and a scary one. The
 * rewrite is narrowed to the range that actually changed so the cursor and the
 * rest of the history survive — see utils/text-edit.ts.
 *
 * `transform` may be called more than once, so it must be pure.
 */
async function rewriteNote(
    plugin: HighlightCommentsPlugin,
    file: TFile,
    transform: (content: string) => string
): Promise<void> {
    for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView) || view.file?.path !== file.path || view.getMode() !== 'source' || !view.editor) continue;

        const editor = view.editor;
        const before = editor.getValue();
        const edit = minimalEdit(before, transform(before));
        if (edit) {
            editor.replaceRange(edit.text, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
        }
        return;
    }

    await plugin.app.vault.process(file, transform);
}

/**
 * Writes the answer into the note under a heading named after the prompt.
 *
 * Replacing that section rather than appending to it is what makes the action
 * repeatable: running "Outline" twice should leave one outline, not two.
 */
async function appendAnswerToNote(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    file: TFile,
    answer: string
): Promise<void> {
    const text = answer.trim();
    if (!text) {
        new Notice(t('ai.run.emptyAnswer'));
        return;
    }

    try {
        await rewriteNote(plugin, file, content => replaceSection(content, prompt.name, text));
        new Notice(t('ai.note.appended', { heading: prompt.name }));
    } catch (error) {
        console.error('Sidebar Highlights: failed to write an AI section:', logSafe(error));
        new Notice(t('ai.run.writeFailed'));
    }
}

/**
 * Marks the passages the model picked out.
 *
 * Reports the count rather than claiming success: a model that paraphrased what
 * it was told to quote produces passages that are not in the note, and silently
 * marking six of ten would look like the note only had six worth marking.
 */
async function markAnswerPassages(
    plugin: HighlightCommentsPlugin,
    file: TFile,
    answer: string
): Promise<void> {
    const passages = parsePassages(answer);
    if (passages.length === 0) {
        new Notice(t('ai.note.noPassages'));
        return;
    }

    let marked = 0;
    let missed = 0;
    try {
        await rewriteNote(plugin, file, content => {
            const result = markPassages(content, passages, {
                color: plugin.settings.ai.extractedHighlightColor,
                // The plugin's own rule for what is code, so a passage is never
                // marked inside a fence the highlight scanner would then ignore.
                excludedRanges: plugin.getCodeBlockRanges(content)
            });
            marked = result.marked.length;
            missed = result.unmatched.length;
            return result.content;
        });
    } catch (error) {
        console.error('Sidebar Highlights: failed to mark AI passages:', logSafe(error));
        new Notice(t('ai.run.writeFailed'));
        return;
    }

    if (marked === 0) {
        new Notice(t('ai.note.markedNone', { total: passages.length }), 8000);
        return;
    }

    new Notice(
        missed > 0
            ? t('ai.note.markedSome', { marked, missed })
            : t('ai.note.marked', { marked }),
        missed > 0 ? 8000 : 4000
    );

    // The write went through the vault, so the sidebar learns about it from the
    // modify event — but a rescan here means the new highlights are listed by
    // the time the notice is read, rather than a debounce later.
    await plugin.loadHighlightsFromFile(file);
}

/** The last `limit` characters, so a growing answer does not grow the notice. */
function tail(text: string, limit: number): string {
    const flat = text.replace(/\s+/g, ' ');
    return flat.length > limit ? `…${flat.slice(-limit)}` : flat;
}
