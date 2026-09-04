import { Menu, Notice, TFile } from 'obsidian';
import type HighlightCommentsPlugin from '../../main';
import type { Highlight } from '../../main';
import { t } from '../i18n';
import { describeAiError, logSafe } from '../ai/ai-service';
import { enabledPrompts } from '../ai/prompt-library';
import { preparePromptRun, type PreparedRun } from '../ai/prompt-runner';
import { canUseInlineFootnote, formatForFootnote, writeCommentForHighlight } from '../ai/comment-writer';
import { AiConfirmSendModal } from '../modals/ai-confirm-send-modal';
import { AiResultModal } from '../modals/ai-result-modal';
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
export function addAiMenuItems(menu: Menu, plugin: HighlightCommentsPlugin, highlight: Highlight): void {
    const prompts = enabledPrompts(plugin.settings.ai.prompts);
    if (prompts.length === 0) return;

    for (const prompt of prompts) {
        menu.addItem(item => {
            item.setTitle(prompt.name)
                .setIcon(prompt.icon ?? 'sparkles')
                .onClick(() => { void runPromptOnHighlight(plugin, prompt, highlight); });
        });
    }
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
    highlight: Highlight
): Promise<void> {
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
        if (prompt.outputTarget === 'comment') {
            void runDirectToComment(plugin, prompt, highlight, prepared);
            return;
        }
        new AiResultModal(plugin.app, plugin, prompt, highlight, prepared, {
            onInsert: text => insertAiComment(plugin, highlight, text)
        }).open();
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

/**
 * The no-preview path, for prompts the user has set to go straight to a
 * comment. Still reports what happened rather than writing silently.
 */
async function runDirectToComment(
    plugin: HighlightCommentsPlugin,
    prompt: PromptPreset,
    highlight: Highlight,
    prepared: PreparedRun
): Promise<void> {
    const notice = new Notice(t('ai.run.working', { name: prompt.name }), 0);
    try {
        const answer = await plugin.aiService.complete(prepared.messages, { profile: prepared.profile });
        plugin.recordAiUsage(answer);
        notice.hide();
        await insertAiComment(plugin, highlight, answer.text);
    } catch (error) {
        notice.hide();
        new Notice(describeAiError(error), 8000);
    }
}

/**
 * Writes the answer into the note as a footnote.
 *
 * Goes through the vault rather than the editor so a highlight in a note that
 * is not currently open can still be commented on — the All notes and
 * Collections tabs both list those. `process` is the atomic read-modify-write,
 * so a concurrent edit cannot be clobbered by a stale copy.
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
                signal
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
