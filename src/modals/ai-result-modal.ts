import { App, Component, Modal, Notice, setIcon } from 'obsidian';
import type HighlightCommentsPlugin from '../../main';
import type { Highlight } from '../../main';
import { t } from '../i18n';
import { describeAiError } from '../ai/ai-service';
import { preparePromptRun, type PreparedRun } from '../ai/prompt-runner';
import type { AiMessage, AiProfile, AiResult, PromptPreset } from '../ai/types';
import { needsRichRender, RichCommentRenderer } from '../renderers/rich-markdown-renderer';
import { DiagramZoomModal } from './diagram-zoom-modal';

export interface AiResultModalOptions {
    /** Called when the user accepts the answer. Returns false to keep the modal open. */
    onInsert?: (text: string) => Promise<boolean>;
    /** Extra instruction typed when launching, carried into regenerate. */
    input?: string;
}

/**
 * Preview panel for one prompt run.
 *
 * The answer is shown before it can touch the note: a model's output is worth
 * a human glance, and previewing also supports the "copy it, do not save it"
 * use that a direct-to-note flow would not.
 */
export class AiResultModal extends Modal {
    private controller: AbortController | null = null;
    private bodyEl!: HTMLElement;
    private statusEl!: HTMLElement;
    private footerEl!: HTMLElement;
    private followUpInput: HTMLInputElement | null = null;

    private result = '';
    /** Grows with each follow-up so the model sees the exchange so far. */
    private conversation: AiMessage[] = [];
    private profile: AiProfile;
    private running = false;
    /** The element streamed text is written into, reused across deltas. */
    private streamEl: HTMLElement | null = null;
    private followOutput = true;
    private rich: RichCommentRenderer | null = null;
    /**
     * Modal is not a Component, so rich renders need one of their own to hang
     * off; it is unloaded in onClose.
     */
    private readonly component = new Component();

    constructor(
        app: App,
        private readonly plugin: HighlightCommentsPlugin,
        private readonly prompt: PromptPreset,
        private readonly highlight: Highlight,
        private readonly prepared: PreparedRun,
        private readonly options: AiResultModalOptions = {}
    ) {
        super(app);
        this.profile = prepared.profile;
        this.conversation = [...prepared.messages];
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('sh-ai-result-modal');

        // Obsidian only loads a child when its parent component is already
        // loaded, and Modal is not a Component, so nothing else will do this.
        // Without it the MarkdownRenderChild behind a rich render is registered
        // but never loaded, and mermaid never draws — the sidebar gets away
        // with it only because its owner is the view, which Obsidian loads.
        this.component.load();

        this.renderHeader();

        this.bodyEl = contentEl.createDiv({ cls: 'sh-ai-result-body' });
        this.bodyEl.addEventListener('scroll', () => {
            const distanceFromBottom =
                this.bodyEl.scrollHeight - this.bodyEl.scrollTop - this.bodyEl.clientHeight;
            this.followOutput = distanceFromBottom < 40;
        });
        this.statusEl = contentEl.createDiv({ cls: 'sh-ai-result-status' });
        this.renderFollowUp(contentEl);
        this.footerEl = contentEl.createDiv({ cls: 'modal-button-container sh-ai-result-footer' });

        this.renderWarnings();
        void this.send();
    }

    private renderHeader(): void {
        this.titleEl.empty();
        if (this.prompt.icon) {
            const icon = this.titleEl.createSpan({ cls: 'sh-ai-result-title-icon' });
            setIcon(icon, this.prompt.icon);
        }
        this.titleEl.createSpan({ text: this.prompt.name });

        const meta = this.contentEl.createDiv({ cls: 'sh-ai-result-meta' });

        const profiles = this.plugin.settings.ai.profiles;
        if (profiles.length > 1) {
            // Switching here re-runs against the other service, which is the
            // fastest way to compare two models on the same highlight.
            const select = meta.createEl('select', { cls: 'dropdown sh-ai-result-profile' });
            for (const profile of profiles) {
                const option = select.createEl('option', { value: profile.id, text: profile.name });
                if (profile.id === this.profile.id) option.selected = true;
            }
            select.addEventListener('change', () => {
                const next = profiles.find(profile => profile.id === select.value);
                if (!next) return;
                this.profile = next;
                void this.regenerate();
            });
        } else {
            meta.createSpan({ cls: 'sh-ai-result-model', text: `${this.prepared.destination.provider} · ${this.profile.model}` });
        }
    }

    /** Surfaces a template problem here too, not only in the prompt editor. */
    private renderWarnings(): void {
        const unknown = this.prepared.interpolation.unknown;
        if (unknown.length === 0) return;

        this.contentEl.createDiv({
            cls: 'sh-ai-result-warning',
            text: t('modals.aiResult.unknownVariable', { names: unknown.map(name => `{{${name}}}`).join(', ') })
        });
    }

    private renderFollowUp(containerEl: HTMLElement): void {
        const row = containerEl.createDiv({ cls: 'sh-ai-followup' });
        const input = row.createEl('input', {
            cls: 'sh-ai-followup-input',
            attr: { type: 'text', placeholder: t('modals.aiResult.followUpPlaceholder') }
        });
        this.followUpInput = input;

        const send = row.createEl('button', { text: t('modals.aiResult.followUpSend') });
        const submit = () => {
            const text = input.value.trim();
            if (!text || this.running) return;
            input.value = '';
            void this.askFollowUp(text);
        };

        send.addEventListener('click', submit);
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                submit();
            }
        });
    }

    /**
     * Renders the finished answer.
     *
     * Rich rendering happens here and only here — never mid-stream. A half
     * arrived mermaid fence is a syntax error, so re-rendering on every delta
     * would flash errors on the way to a valid diagram.
     */
    private renderResult(): void {
        this.bodyEl.empty();

        const settings = this.plugin.settings.ai;
        if (settings.renderRichContent && needsRichRender(this.result)) {
            this.rich ??= new RichCommentRenderer(this.app, this.component);
            const target = this.bodyEl.createDiv();
            this.rich.render(target, this.result, {
                sourcePath: this.highlight.filePath,
                renderMermaid: settings.renderMermaid,
                maxDiagramHeight: settings.maxDiagramHeight,
                diagramErrorLabel: t('render.diagramError'),
                zoomLabel: t('render.diagramZoom'),
                // One block, and it is what the user is waiting for.
                immediate: true,
                onZoom: (svg, source) => { new DiagramZoomModal(this.app, svg, source).open(); }
            });
            return;
        }

        this.bodyEl.createDiv({ cls: 'sh-ai-result-text', text: this.result });
        this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    }

    /**
     * Draws the answer as it streams in: plain text, no markdown, growing in
     * place. Kept separate from `renderResult` so the cheap per-delta path
     * cannot accidentally acquire the expensive one's work.
     */
    private renderStreamingText(): void {
        this.streamEl ??= this.bodyEl.createDiv({ cls: 'sh-ai-result-text' });
        this.streamEl.setText(this.result);
        // Only follow the output while the user is already at the bottom, so
        // scrolling back to re-read something is not undone by the next token.
        if (this.followOutput) {
            this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
        }
    }

    private async send(): Promise<void> {
        this.running = true;
        this.controller = new AbortController();
        this.result = '';
        this.streamEl = null;
        this.followOutput = true;
        this.bodyEl.empty();
        this.renderRunningState();

        try {
            const answer = await this.runRequest(this.controller.signal);

            this.result = answer.text;
            this.conversation.push({ role: 'assistant', content: answer.text });
            this.running = false;
            this.plugin.recordAiUsage(answer);
            this.renderResult();
            this.renderIdleState(answer.model);
            this.renderFooter();
        } catch (error) {
            this.running = false;
            this.renderError(error);
        } finally {
            this.controller = null;
        }
    }

    /** Streams when the setting and the platform allow it; otherwise waits. */
    private async runRequest(signal: AbortSignal): Promise<AiResult> {
        if (!this.plugin.aiService.canStream(this.profile)) {
            return this.plugin.aiService.complete(this.conversation, {
                profile: this.profile,
                signal
            });
        }

        return this.plugin.aiService.stream(this.conversation, {
            profile: this.profile,
            signal,
            onDelta: chunk => {
                this.result += chunk;
                this.renderStreamingText();
            },
            onFallback: () => {
                // The partial text belongs to an attempt that is being redone;
                // leaving it on screen would double the answer.
                this.result = '';
                this.streamEl = null;
                this.bodyEl.empty();
            }
        });
    }

    private renderRunningState(): void {
        this.statusEl.empty();
        this.footerEl?.empty();

        const spinner = this.statusEl.createDiv({ cls: 'sh-ai-result-spinner' });
        setIcon(spinner, 'loader');
        this.statusEl.createSpan({ text: t('modals.aiResult.generating') });

        const stop = this.statusEl.createEl('button', { cls: 'sh-ai-result-stop', text: t('modals.aiResult.stop') });
        stop.addEventListener('click', () => this.controller?.abort());
    }

    private renderIdleState(model?: string): void {
        this.statusEl.empty();
        if (model) {
            this.statusEl.createSpan({ cls: 'sh-ai-result-model', text: t('modals.aiResult.answeredBy', { model }) });
        }
    }

    private renderError(error: unknown): void {
        this.statusEl.empty();
        this.bodyEl.empty();
        this.footerEl.empty();

        this.bodyEl.createDiv({ cls: 'sh-ai-result-error', text: describeAiError(error) });

        const retry = this.footerEl.createEl('button', { text: t('modals.aiResult.retry'), cls: 'mod-cta' });
        retry.addEventListener('click', () => { void this.regenerate(); });

        const close = this.footerEl.createEl('button', { text: t('modals.aiResult.close') });
        close.addEventListener('click', () => this.close());
    }

    private renderFooter(): void {
        this.footerEl.empty();

        if (this.prompt.outputTarget !== 'preview' && this.options.onInsert) {
            const insert = this.footerEl.createEl('button', { text: t('modals.aiResult.insert'), cls: 'mod-cta' });
            insert.addEventListener('click', () => { void this.insert(insert); });
        }

        const copy = this.footerEl.createEl('button', { text: t('modals.aiResult.copy') });
        copy.addEventListener('click', () => { void this.copy(); });

        const regenerate = this.footerEl.createEl('button', { text: t('modals.aiResult.regenerate') });
        regenerate.addEventListener('click', () => { void this.regenerate(); });
    }

    private async insert(button: HTMLButtonElement): Promise<void> {
        if (!this.options.onInsert) return;
        button.disabled = true;
        try {
            const done = await this.options.onInsert(this.result);
            if (done) this.close();
        } finally {
            button.disabled = false;
        }
    }

    private async copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(this.result);
            new Notice(t('modals.aiResult.copied'));
        } catch {
            new Notice(t('modals.aiResult.copyFailed'));
        }
    }

    /** Re-runs the original request, discarding any follow-up turns. */
    private async regenerate(): Promise<void> {
        this.controller?.abort();
        try {
            const prepared = await preparePromptRun(this.plugin, this.prompt, this.highlight, {
                input: this.options.input,
                profile: this.profile
            });
            this.conversation = [...prepared.messages];
        } catch {
            // The highlight or its note may be gone; fall back to what we sent
            // the first time rather than failing the retry outright.
            this.conversation = [...this.prepared.messages];
        }
        await this.send();
    }

    private async askFollowUp(text: string): Promise<void> {
        this.conversation.push({ role: 'user', content: text });
        await this.send();
    }

    onClose(): void {
        // A request still in flight has nowhere to render; stop waiting on it.
        this.controller?.abort();
        this.controller = null;
        this.followUpInput = null;
        this.streamEl = null;
        this.rich?.dispose();
        this.rich = null;
        this.component.unload();
        this.contentEl.empty();
    }
}
