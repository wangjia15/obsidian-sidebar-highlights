import { Editor, MarkdownView, Menu, Notice, TFile } from 'obsidian';
import type HighlightCommentsPlugin from '../../main';
import type { Highlight } from '../../main';
import { t } from '../i18n';
import { describeAiError, logSafe } from '../ai/ai-service';
import { enabledPrompts } from '../ai/prompt-library';
import { preparePromptRun, type PreparedRun } from '../ai/prompt-runner';
import {
    canUseInlineFootnote,
    commentEditsForHighlight,
    formatForFootnote,
    writeCommentForHighlight
} from '../ai/comment-writer';
import { AiConfirmSendModal } from '../modals/ai-confirm-send-modal';
import { openAiResultView } from './ai-result-view';
import type { PromptPreset } from '../ai/types';
import { runBatch, summarize, type BatchItem } from '../ai/batch-runner';

/**
 * Whether the AI entry points should appear at all. Kept in one place so the
 * menu, the card button and the commands cannot disagree about it.
 */
export function aiAvailable(plugin: HighlightCommentsPlugin): boolean {
    return plugin.settings.ai.enabled && enabledPrompts(plugin.settings.ai.prompts).length > 0;
}

/** Adds one item per enabled prompt to an existing menu. */
export function addAiMenuItems(
    menu: Menu,
    plugin: HighlightCommentsPlugin,
    highlight: Highlight,
    options: RunOptions = {}
): void {
    const prompts = enabledPrompts(plugin.settings.ai.prompts);
    if (prompts.length === 0) return;

    for (const prompt of prompts) {
        menu.addItem(item => {
            item.setTitle(prompt.name)
                .setIcon(prompt.icon ?? 'sparkles')
                .onClick(() => { void runPromptOnHighlight(plugin, prompt, highlight, options); });
        });
    }
}

export interface RunOptions {
    /**
     * Write the answer straight into a comment, whatever the prompt's own output
     * target says. The right-click menu in the editor uses this: the user asked
     * for a comment by picking the prompt there, and a preview modal over the
     * text they are reading is in the way rather than in the flow.
     */
    forceComment?: boolean;
}

/** The standalone menu behind the card's AI button. */
export function showAiMenu(plugin: HighlightCommentsPlugin, highlight: Highlight, event: MouseEvent): void {
    const menu = new Menu();
    addAiMenuItems(menu, plugin, highlight);
    menu.showAtMouseEvent(event);
}

/**
 * Runs a prompt end to end: readiness, confirmation, then either a preview or
 * a direct insert depending on the prompt's output target.
 */
export async function runPromptOnHighlight(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    highlight: Highlight,
    options: RunOptions = {}
): Promise<void> {
    // Capture the target before asynchronous work or sidebar selection changes.
    highlight = { ...highlight };
    const problem = plugin.aiService.checkReadiness();
    if (problem) {
        new Notice(t(problem.reasonKey));
        return;
    }

    let prepared: PreparedRun;
    try {
        prepared = await preparePromptRun(plugin, prompt, highlight);
    } catch (error) {
        new Notice(describeAiError(error));
        return;
    }

    const proceed = () => {
        if (options.forceComment || prompt.outputTarget === 'comment') {
            void runDirectToComment(plugin, prompt, highlight, prepared);
            return;
        }
        void openAiResultView(plugin, {
            prompt,
            source: {
                sourcePath: highlight.filePath,
                prepare: profile => preparePromptRun(plugin, prompt, highlight, { profile })
            },
            prepared,
            actions: {
                // A preview prompt is one the user said should not write
                // anything, so it gets no button that would.
                onInsert: prompt.outputTarget === 'preview'
                    ? undefined
                    : text => insertAiComment(plugin, highlight, text)
            }
        });
    };

    if (!plugin.settings.ai.confirmBeforeSend) {
        proceed();
        return;
    }

    new AiConfirmSendModal(plugin.app, prepared, dontAskAgain => {
        if (dontAskAgain) {
            plugin.settings.ai.confirmBeforeSend = false;
            // Saving the preference does not gate what happens next, so the
            // run does not wait on the disk write.
            void plugin.saveSettings();
        }
        proceed();
    }).open();
}

/** How much of a streaming answer the progress notice shows at once. */
const PROGRESS_TAIL = 140;

/**
 * The no-preview path, for prompts the user has set to go straight to a
 * comment. Still reports what happened rather than writing silently.
 *
 * Streams rather than waiting for the whole answer. Nothing arrives in the note
 * any sooner, but the wait stops being a blank one: the notice shows the text as
 * it is written, which is the difference between "slow" and "working". Streaming
 * that cannot be established — mobile, or the setting turned off — falls back to
 * a single request inside `stream`, so this path needs no branch of its own.
 */
async function runDirectToComment(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    highlight: Highlight,
    prepared: PreparedRun
): Promise<void> {
    const controller = new AbortController();
    const notice = new Notice('', 0);
    notice.messageEl.createDiv({ text: t('ai.run.working', { name: prompt.name }) });
    const progressEl = notice.messageEl.createDiv({ cls: 'sh-ai-run-progress' });

    // A run with no UI of its own has nowhere else to put a stop control, and a
    // long answer the user no longer wants should not have to be waited out.
    const stop = notice.messageEl.createEl('button', { cls: 'sh-ai-batch-stop', text: t('ai.batch.stop') });
    stop.addEventListener('click', () => {
        controller.abort();
        stop.disabled = true;
    });

    let streamed = '';
    let thinking = '';
    try {
        const answer = await plugin.aiService.stream(prepared.messages, {
            profile: prepared.profile,
            signal: controller.signal,
            // Running this again is a request for another answer, not for the
            // last one back: this path writes straight into the note, so a
            // cached reply would arrive as a duplicate of the comment already
            // there. The preview modal keeps the cache — reopening a panel is
            // the case it exists for.
            bypassCache: true,
            onDelta: chunk => {
                streamed += chunk;
                progressEl.setText(tail(streamed, PROGRESS_TAIL));
            },
            // A reasoning model says nothing for a while first; showing the
            // thinking is what keeps the notice from looking stuck.
            onReasoning: chunk => {
                if (streamed) return;
                thinking += chunk;
                progressEl.setText(tail(thinking, PROGRESS_TAIL));
            },
            onFallback: () => {
                // The partial text belongs to an attempt being redone.
                streamed = '';
                thinking = '';
                progressEl.setText('');
            }
        });
        plugin.recordAiUsage(answer);
        notice.hide();
        await insertAiComment(plugin, highlight, answer.text);
    } catch (error) {
        notice.hide();
        new Notice(describeAiError(error), 8000);
    }
}

/** The last `limit` characters, so a growing answer does not grow the notice. */
function tail(text: string, limit: number): string {
    const flat = text.replace(/\s+/g, ' ');
    return flat.length > limit ? `…${flat.slice(-limit)}` : flat;
}

/**
 * The editor showing a note, if one is open anywhere in the workspace —
 * including a popout window or a side panel.
 *
 * Resolved by path rather than from the active leaf: the AI menus are reached
 * from the sidebar and from a context menu, so by the time the answer arrives
 * the active leaf is rarely the note being written to.
 */
function openEditorFor(plugin: HighlightCommentsPlugin, filePath: string): Editor | null {
    for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === filePath && view.getMode() === 'source' && view.editor) {
            return view.editor;
        }
    }
    return null;
}

/**
 * Adds the comment through an open editor. Returns false when the highlight
 * cannot be found in the buffer.
 */
function writeCommentThroughEditor(
    editor: Editor,
    highlight: Highlight,
    commentText: string,
    preferInline: boolean
): boolean {
    const edits = commentEditsForHighlight(editor.getValue(), highlight, commentText, preferInline);
    if (!edits) return false;

    // In order and in pre-edit offsets, which commentEditsForHighlight
    // guarantees is safe; see its comment.
    for (const edit of edits) {
        editor.replaceRange(edit.text, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
    }
    return true;
}

/**
 * Writes the answer into the note as a footnote.
 *
 * Through the open editor when there is one, and through the vault otherwise so
 * that a highlight in a note that is not open can still be commented on — the
 * All notes and Collections tabs both list those.
 *
 * The editor comes first because its buffer is up to two seconds ahead of the
 * file: a highlight created from the editor's own context menu exists only in
 * the buffer at the moment the AI menu above it is used, so a vault write would
 * fail to find it and would discard whatever else had been typed since the last
 * flush. Where no editor is open, `process` is the atomic read-modify-write, so
 * a concurrent change cannot be clobbered by a stale copy either.
 */
export async function insertAiComment(
    plugin: HighlightCommentsPlugin,
    highlight: Highlight,
    text: string,
    options: { quiet?: boolean } = {}
): Promise<boolean> {
    // A batch run reports once at the end; one Notice per highlight would bury
    // the screen and the summary alike.
    const report = (message: string, timeout?: number) => {
        if (!options.quiet) new Notice(message, timeout);
    };

    const file = plugin.app.vault.getAbstractFileByPath(highlight.filePath);
    if (!(file instanceof TFile)) {
        report(t('ai.run.fileMissing'));
        return false;
    }

    const preferInline = plugin.settings.useInlineFootnotes;
    const commentText = formatForFootnote(text, {
        // Line breaks survive exactly when the comment will not take the
        // inline form: multi-line answers become standard footnotes, whose
        // continuation lines the parser reads back.
        allowMultiline: !(preferInline && canUseInlineFootnote(text.trim()))
    });
    if (!commentText) {
        report(t('ai.run.emptyAnswer'));
        return false;
    }

    let located = true;
    try {
        const editor = openEditorFor(plugin, highlight.filePath);
        if (editor) {
            located = writeCommentThroughEditor(editor, highlight, commentText, preferInline);
        } else {
            await plugin.app.vault.process(file, content => {
                const written = writeCommentForHighlight(
                    content,
                    highlight,
                    commentText,
                    preferInline
                );
                if (!written) {
                    located = false;
                    return content;
                }
                return written.content;
            });
        }
    } catch (error) {
        console.error('Sidebar Highlights: failed to write an AI comment:', logSafe(error));
        report(t('ai.run.writeFailed'));
        return false;
    }

    if (!located) {
        // The highlight text changed since the sidebar last parsed it, so
        // there is no safe place to attach the comment.
        report(t('ai.run.highlightMoved'), 8000);
        return false;
    }

    report(t('ai.run.inserted'));
    return true;
}

/**
 * Runs one prompt over a set of highlights, writing each answer straight into
 * the note.
 *
 * Deliberately has no preview step: reviewing fifty answers one modal at a time
 * is not a workflow anybody wants. The confirmation up front says how many
 * calls this will make, and the run can be stopped at any point.
 */
export async function runPromptOnHighlights(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    highlights: Highlight[]
): Promise<void> {
    const problem = plugin.aiService.checkReadiness();
    if (problem) {
        new Notice(t(problem.reasonKey));
        return;
    }
    if (highlights.length === 0) {
        new Notice(t('ai.batch.empty'));
        return;
    }

    const controller = new AbortController();
    const notice = new Notice(t('ai.batch.starting', { count: highlights.length }), 0);
    // The notice is the only surface a long run has, so it doubles as the stop
    // control rather than adding a modal the user has to keep on screen.
    const stop = notice.messageEl.createEl('button', { cls: 'sh-ai-batch-stop', text: t('ai.batch.stop') });
    stop.addEventListener('click', () => {
        controller.abort();
        stop.disabled = true;
    });
    const progressEl = notice.messageEl.createDiv({ cls: 'sh-ai-batch-progress' });

    const items: BatchItem<Highlight>[] = highlights.map(highlight => ({
        label: shorten(highlight.text),
        value: highlight
    }));

    const outcome = await runBatch({
        items,
        signal: controller.signal,
        // A short pause between calls: enough to stay clear of per-second rate
        // limits without making a long run feel stalled.
        delayMs: 350,
        describeError: describeAiError,
        onProgress: progress => {
            progressEl.setText(t('ai.batch.progress', {
                done: progress.done,
                total: progress.total,
                current: progress.current
            }));
        },
        run: async (highlight, signal) => {
            const prepared = await preparePromptRun(plugin, prompt, highlight);
            const answer = await plugin.aiService.complete(prepared.messages, {
                profile: prepared.profile,
                signal,
                // Writes into the note, so the same reasoning as the single
                // direct-to-comment run: re-running a batch must produce new
                // answers, not a second copy of the last ones. Two highlights
                // with identical text still each get their own request, which
                // is the price of never writing a stale answer.
                bypassCache: true
            });
            plugin.recordAiUsage(answer);

            const written = await insertAiComment(plugin, highlight, answer.text, { quiet: true });
            if (!written) {
                throw new Error(t('ai.batch.writeFailed'));
            }
        }
    });

    notice.hide();
    new Notice(
        summarize(outcome, (key, values) => t(`ai.batch.${key}`, values)),
        outcome.failed.length > 0 ? 12000 : 6000
    );
}

/** Keeps a failure list readable when highlights are long. */
function shorten(text: string, limit = 40): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
