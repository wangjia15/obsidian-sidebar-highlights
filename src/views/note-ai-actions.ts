import { MarkdownView, Menu, Notice, TFile } from 'obsidian';
import type HighlightCommentsPlugin from '../../main';
import { t } from '../i18n';
import { describeAiError, logSafe } from '../ai/ai-service';
import { enabledPromptsForScope } from '../ai/prompt-library';
import { prepareNotePromptRun, type PreparedNoteRun } from '../ai/prompt-runner';
import { AiConfirmSendModal } from '../modals/ai-confirm-send-modal';
import { AiResultModal } from '../modals/ai-result-modal';
import type { PromptPreset } from '../ai/types';
import { markPassages, parsePassages } from '../utils/passage-marker';
import { replaceSection } from '../utils/note-section';
import { minimalEdit } from '../utils/text-edit';

/**
 * Whole-note AI: prompts that read the document rather than one highlight.
 *
 * The three things a note prompt can do are deliberately different in kind, and
 * the difference is what the output target names:
 *
 * - `preview` answers a question about the note and touches nothing.
 * - `append` writes the answer into the note under its own heading, replacing
 *   what a previous run of the same prompt left there.
 * - `highlights` finds the passages the model picked out and marks them where
 *   they already are, so they appear in the sidebar like any other highlight.
 *
 * Only the last needs explaining: it never writes the model's text into the
 * note. See utils/passage-marker.ts.
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

    // Worth saying before the request rather than after: an answer about the
    // first half of a note looks exactly like an answer about all of it.
    if (prepared.truncated) {
        new Notice(t('ai.note.truncated', { limit: plugin.settings.ai.noteCharLimit }), 8000);
    }

    const proceed = () => {
        if (prompt.outputTarget === 'preview') {
            openNotePreview(plugin, prompt, file, prepared);
            return;
        }
        void runNoteWrite(plugin, prompt, file, prepared);
    };

    if (!plugin.settings.ai.confirmBeforeSend) {
        proceed();
        return;
    }

    new AiConfirmSendModal(plugin.app, prepared, dontAskAgain => {
        if (dontAskAgain) {
            plugin.settings.ai.confirmBeforeSend = false;
            void plugin.saveSettings();
        }
        proceed();
    }).open();
}

function openNotePreview(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    file: TFile,
    prepared: PreparedNoteRun
): void {
    new AiResultModal(
        plugin.app,
        plugin,
        prompt,
        {
            sourcePath: file.path,
            prepare: profile => prepareNotePromptRun(plugin, prompt, file, { profile })
        },
        prepared,
        {
            // Even a read-only prompt is worth being able to keep, and the
            // section write is the same one `append` performs.
            insertLabel: t('modals.aiResult.insertSection'),
            onInsert: async text => {
                await appendAnswerToNote(plugin, prompt, file, text);
                return true;
            }
        }
    ).open();
}

/**
 * The two writing targets. Shares one progress notice with a stop button,
 * because both are a single request whose only surface is that notice.
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

    let streamed = '';
    try {
        const answer = await plugin.aiService.stream(prepared.messages, {
            profile: prepared.profile,
            signal: controller.signal,
            onDelta: chunk => {
                streamed += chunk;
                progressEl.setText(tail(streamed, 140));
            },
            onFallback: () => {
                streamed = '';
                progressEl.setText('');
            }
        });
        plugin.recordAiUsage(answer);
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
        if (!(view instanceof MarkdownView) || view.file?.path !== file.path || !view.editor) continue;

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
