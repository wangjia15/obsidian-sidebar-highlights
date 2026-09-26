import { ItemView, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type HighlightCommentsPlugin from '../../main';
import { t } from '../i18n';
import { describeAiError } from '../ai/ai-service';
import { type PreparedRun } from '../ai/prompt-runner';
import type { AiMessage, AiProfile, AiResult, PromptPreset } from '../ai/types';
import { runAiMessageBatches } from '../ai/multi-part-runner';
import { needsRichRender, RichCommentRenderer } from '../renderers/rich-markdown-renderer';
import { DiagramZoomModal } from '../modals/diagram-zoom-modal';

export const VIEW_TYPE_AI_RESULT = 'sidebar-highlights-ai-result';

/**
 * What the answer is about, stated as a note path and a way to build the
 * request again. Keeping it this narrow is what lets one result panel serve
 * both a highlight prompt and a whole-note one.
 */
export interface AiResultSource {
    /** The note, so links and embeds in the answer resolve from the right place. */
    sourcePath: string;
    /** Rebuilds the request for a regenerate, against whichever profile is picked. */
    prepare(profile: AiProfile): Promise<PreparedRun>;
}

/** A document the finished answer can be saved as. */
export type AiResultDocumentFormat = 'md' | 'html';

export interface AiResultActions {
    /** Called when the user accepts the answer. Returns false to keep the panel open. */
    onInsert?: (text: string) => Promise<boolean>;
    /** Label for the accept button; defaults to "Insert as comment". */
    insertLabel?: string;
    /**
     * Offered as "create a document" buttons once the answer is complete. Both
     * formats are always offered — which one the prompt asked for only decides
     * which button is the primary one.
     */
    createDocument?: (text: string, format: AiResultDocumentFormat) => Promise<void>;
    /** The format `createDocument` should suggest first. */
    preferredFormat?: AiResultDocumentFormat;
}

/** Everything one run of one prompt needs to render itself. */
export interface AiResultRun {
    prompt: PromptPreset;
    source: AiResultSource;
    prepared: PreparedRun;
    actions?: AiResultActions;
    /**
     * Combines a chunked run's answers into the text shown and saved. Defaults
     * to the runner's own join; a caller supplies one when the parts need
     * treating individually — see joinAnswerParts in note-ai-actions.
     */
    joinParts?: (parts: AiResult[]) => string;
}

/** The part of a run that survives being written into the workspace layout. */
interface AiResultViewState {
    promptName?: string;
    icon?: string;
}

/**
 * Result panel for one prompt run, as a workspace tab rather than a modal.
 *
 * A tab is what makes generation non-blocking: a long whole-note run can be
 * left to fill in while its note, or anything else, stays workable — and the
 * panel can be split alongside the note it came from, which a modal cannot.
 * The answer is still shown before it can touch anything: a model's output is
 * worth a human glance, and this also supports the "copy it, do not save it"
 * use that a direct-to-note flow would not.
 *
 * The run itself is handed over by `start` rather than through view state,
 * because a prompt, a prepared request and a set of callbacks are not things
 * the layout can serialize. Only the name and icon go into state, so a panel
 * restored with the workspace can still say what it was before explaining that
 * the answer is gone.
 */
export class AiResultView extends ItemView {
    private run: AiResultRun | null = null;

    private headerEl!: HTMLElement;
    private bodyEl!: HTMLElement;
    private statusEl!: HTMLElement;
    private followUpEl!: HTMLElement;
    private footerEl!: HTMLElement;

    private controller: AbortController | null = null;
    private result = '';
    /** Grows with each follow-up so the model sees the exchange so far. */
    private conversation: AiMessage[] = [];
    private profile: AiProfile | null = null;
    private running = false;
    private bypassCache = false;
    private pendingBatches: AiMessage[][] | null = null;
    private pendingMerge: ((partTexts: string[]) => AiMessage[]) | null = null;
    /** The element streamed text is written into, reused across deltas. */
    private streamEl: HTMLElement | null = null;
    /** Where a reasoning model's thinking goes until the answer displaces it. */
    private thinkingEl: HTMLElement | null = null;
    private followOutput = true;
    private rich: RichCommentRenderer | null = null;

    private promptName = '';
    private iconName = 'sparkles';

    constructor(leaf: WorkspaceLeaf, private readonly plugin: HighlightCommentsPlugin) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_AI_RESULT;
    }

    getDisplayText(): string {
        return this.promptName || t('views.aiResult.title');
    }

    getIcon(): string {
        return this.iconName;
    }

    getState(): Record<string, unknown> {
        return { promptName: this.promptName, icon: this.iconName };
    }

    async setState(state: unknown, result: { history: boolean }): Promise<void> {
        const stored = (state ?? {}) as AiResultViewState;
        if (stored.promptName) this.promptName = stored.promptName;
        if (stored.icon) this.iconName = stored.icon;
        await super.setState(state, result);
    }

    protected async onOpen(): Promise<void> {
        this.renderChrome();
        // A panel Obsidian restored with the workspace has a name but no run —
        // the answer lived in memory. Saying so beats an empty panel that looks
        // like it is still thinking.
        if (!this.run) this.renderGone();
    }

    /** Begins a run in this panel. Called once, right after the tab is opened. */
    start(run: AiResultRun): void {
        this.run = run;
        this.promptName = run.prompt.name;
        this.iconName = run.prompt.icon ?? 'sparkles';
        this.profile = run.prepared.profile;
        this.conversation = [...run.prepared.messages];
        this.pendingBatches = run.prepared.messageBatches ?? null;
        this.pendingMerge = run.prepared.mergeMessages ?? null;

        this.renderChrome();
        this.renderHeader();
        this.renderWarnings();
        void this.send();
    }

    /** The panel's fixed furniture, rebuilt whenever a run takes it over. */
    private renderChrome(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('sh-ai-result-view');

        this.headerEl = contentEl.createDiv({ cls: 'sh-ai-result-header' });
        this.bodyEl = contentEl.createDiv({ cls: 'sh-ai-result-body' });
        this.bodyEl.addEventListener('scroll', () => {
            const distanceFromBottom =
                this.bodyEl.scrollHeight - this.bodyEl.scrollTop - this.bodyEl.clientHeight;
            this.followOutput = distanceFromBottom < 40;
        });
        this.statusEl = contentEl.createDiv({ cls: 'sh-ai-result-status' });
        this.followUpEl = contentEl.createDiv();
        this.footerEl = contentEl.createDiv({ cls: 'modal-button-container sh-ai-result-footer' });
    }

    private renderGone(): void {
        this.bodyEl.createDiv({ cls: 'sh-ai-result-error', text: t('views.aiResult.gone') });
        const close = this.footerEl.createEl('button', { text: t('modals.aiResult.close') });
        close.addEventListener('click', () => this.leaf.detach());
    }

    private renderHeader(): void {
        if (!this.run || !this.profile) return;
        this.headerEl.empty();

        const title = this.headerEl.createDiv({ cls: 'sh-ai-result-title' });
        if (this.run.prompt.icon) {
            const icon = title.createSpan({ cls: 'sh-ai-result-title-icon' });
            setIcon(icon, this.run.prompt.icon);
        }
        title.createSpan({ text: this.run.prompt.name });

        const meta = this.headerEl.createDiv({ cls: 'sh-ai-result-meta' });
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
            meta.createSpan({
                cls: 'sh-ai-result-model',
                text: `${this.run.prepared.destination.provider} · ${this.profile.model}`
            });
        }
    }

    /** Surfaces a template problem here too, not only in the prompt editor. */
    private renderWarnings(): void {
        const unknown = this.run?.prepared.interpolation.unknown ?? [];
        if (unknown.length === 0) return;

        this.headerEl.createDiv({
            cls: 'sh-ai-result-warning',
            text: t('modals.aiResult.unknownVariable', { names: unknown.map(name => `{{${name}}}`).join(', ') })
        });
    }

    private renderFollowUp(): void {
        this.followUpEl.empty();
        const row = this.followUpEl.createDiv({ cls: 'sh-ai-followup' });
        const input = row.createEl('input', {
            cls: 'sh-ai-followup-input',
            attr: { type: 'text', placeholder: t('modals.aiResult.followUpPlaceholder') }
        });

        const send = row.createEl('button', { text: t('modals.aiResult.followUpSend') });
        const submit = () => {
            const text = input.value.trim();
            if (!text || this.running) return;
            input.value = '';
            void this.askFollowUp(text);
        };

        send.addEventListener('click', submit);
        input.addEventListener('keydown', event => {
            // Enter also confirms a word in a Chinese or Japanese IME; that
            // keystroke belongs to the input method, not to the send button.
            if (event.key === 'Enter' && !event.isComposing) {
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
        this.streamEl = null;
        this.thinkingEl = null;

        const settings = this.plugin.settings.ai;
        if (settings.renderRichContent && needsRichRender(this.result)) {
            // The view is itself a Component, so a rich render's children are
            // loaded and unloaded with the panel and mermaid draws as it should.
            this.rich ??= new RichCommentRenderer(this.app, this);
            const target = this.bodyEl.createDiv();
            this.rich.render(target, this.result, {
                sourcePath: this.run?.source.sourcePath ?? '',
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
        // The first real word retires the thinking: it has served its purpose
        // and the answer should not have to be read around it.
        this.thinkingEl?.remove();
        this.thinkingEl = null;

        this.streamEl ??= this.bodyEl.createDiv({ cls: 'sh-ai-result-text' });
        this.streamEl.setText(this.result);
        // Only follow the output while the user is already at the bottom, so
        // scrolling back to re-read something is not undone by the next token.
        if (this.followOutput) {
            this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
        }
    }

    private async send(): Promise<void> {
        if (!this.run || !this.profile) return;

        this.running = true;
        this.controller = new AbortController();
        this.result = '';
        this.streamEl = null;
        this.thinkingEl = null;
        this.followOutput = true;
        this.bodyEl.empty();
        this.followUpEl.empty();
        this.renderRunningState();

        const chunks = this.pendingBatches?.length ?? 1;

        try {
            const { combined: answer, parts, answers } = await this.runRequest(this.controller.signal);

            this.result = this.run.joinParts?.(answers) ?? answer.text;
            this.continueFrom(this.result, chunks);
            this.pendingBatches = null;
            this.running = false;
            for (const part of parts) this.plugin.recordAiUsage(part);
            this.renderResult();
            this.renderIdleState(answer.model);
            this.renderFollowUp();
            this.renderFooter();
        } catch (error) {
            this.running = false;
            this.renderError(error);
        } finally {
            this.controller = null;
            // Set for one run by regenerate; a follow-up is a new question and
            // has no reason to refuse an answer it has already paid for.
            this.bypassCache = false;
        }
    }

    /**
     * Sets up the conversation a follow-up will continue from.
     *
     * A single request just gains its answer. A chunked one cannot: the request
     * that carried part one is the only one in `conversation`, so continuing
     * from it would answer questions about the opening slice of a document
     * while appearing to answer them about the whole thing. There is no
     * conversation that could hold the whole note either — not fitting is why
     * it was split — so the exchange restarts from the answer, and says as much
     * rather than letting the model assume it has the source.
     */
    private continueFrom(answer: string, chunks: number): void {
        if (chunks <= 1) {
            this.conversation.push({ role: 'assistant', content: answer });
            return;
        }

        this.conversation = [
            {
                role: 'user',
                content: `The prompt "${this.run?.prompt.name}" was run over ${this.run?.source.sourcePath} in ${chunks} parts, and the result follows. Answer follow-up questions from that result; the source document itself is not part of this conversation.`
            },
            { role: 'assistant', content: answer }
        ];
    }

    /** Streams when the setting and the platform allow it; otherwise waits. */
    private async runRequest(signal: AbortSignal): Promise<{ combined: AiResult; parts: AiResult[]; answers: AiResult[] }> {
        return runAiMessageBatches(
            this.plugin.aiService,
            this.pendingBatches ?? [this.conversation],
            {
                profile: this.profile as AiProfile,
                bypassCache: this.bypassCache,
                signal,
                // Only for the document's own run; a follow-up is one request.
                merge: this.pendingBatches ? this.pendingMerge ?? undefined : undefined,
                onText: text => {
                    this.result = text;
                    this.renderStreamingText();
                },
                onReasoning: text => this.renderThinking(text)
            }
        );
    }

    /**
     * Shows a reasoning model's thinking while it thinks.
     *
     * On a long document this runs for minutes before the first word of the
     * answer, and a panel that showed nothing for that long could not be told
     * apart from one that had hung. It is drawn dimmed and above the answer,
     * and removed the moment real text starts arriving — it is evidence of
     * progress, not part of what was asked for.
     */
    private renderThinking(text: string): void {
        if (!text) {
            this.thinkingEl?.remove();
            this.thinkingEl = null;
            return;
        }

        this.thinkingEl ??= this.bodyEl.createDiv({ cls: 'sh-ai-result-thinking' });
        this.thinkingEl.setText(text);
        if (this.followOutput) this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    }

    private renderRunningState(): void {
        this.statusEl.empty();
        this.footerEl.empty();

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
        this.followUpEl.empty();
        this.footerEl.empty();

        this.bodyEl.createDiv({ cls: 'sh-ai-result-error', text: describeAiError(error) });

        const retry = this.footerEl.createEl('button', { text: t('modals.aiResult.retry'), cls: 'mod-cta' });
        retry.addEventListener('click', () => { void this.regenerate(); });

        const close = this.footerEl.createEl('button', { text: t('modals.aiResult.close') });
        close.addEventListener('click', () => this.leaf.detach());
    }

    private renderFooter(): void {
        this.footerEl.empty();
        const actions = this.run?.actions ?? {};

        if (actions.onInsert) {
            const insert = this.footerEl.createEl('button', {
                text: actions.insertLabel ?? t('modals.aiResult.insert'),
                cls: 'mod-cta'
            });
            insert.addEventListener('click', () => { void this.insert(insert); });
        }

        if (actions.createDocument) {
            // Both, always. Which one the prompt asked for is a default, not a
            // restriction: the answer is written by now, and saving it as the
            // other format costs nothing but a click.
            for (const format of ['md', 'html'] as const) {
                const button = this.footerEl.createEl('button', {
                    text: format === 'md'
                        ? t('modals.aiResult.createMarkdown')
                        : t('modals.aiResult.createHtml'),
                    cls: !actions.onInsert && actions.preferredFormat === format ? 'mod-cta' : ''
                });
                button.addEventListener('click', () => { void this.createDocument(button, format); });
            }
        }

        const copy = this.footerEl.createEl('button', { text: t('modals.aiResult.copy') });
        copy.addEventListener('click', () => { void this.copy(); });

        const regenerate = this.footerEl.createEl('button', { text: t('modals.aiResult.regenerate') });
        regenerate.addEventListener('click', () => { void this.regenerate(); });
    }

    private async insert(button: HTMLButtonElement): Promise<void> {
        const onInsert = this.run?.actions?.onInsert;
        if (!onInsert) return;
        button.disabled = true;
        try {
            const done = await onInsert(this.result);
            if (done) this.leaf.detach();
        } finally {
            button.disabled = false;
        }
    }

    /**
     * Saves the answer as a document. The panel stays open: the answer is still
     * worth a follow-up or a second format, and the new file opens beside it.
     */
    private async createDocument(button: HTMLButtonElement, format: AiResultDocumentFormat): Promise<void> {
        const create = this.run?.actions?.createDocument;
        if (!create) return;
        button.disabled = true;
        try {
            await create(this.result, format);
        } catch (error) {
            new Notice(describeAiError(error), 8000);
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
        if (!this.run || !this.profile) return;
        this.bypassCache = true;
        this.controller?.abort();
        try {
            const prepared = await this.run.source.prepare(this.profile);
            this.conversation = [...prepared.messages];
            this.pendingBatches = prepared.messageBatches ?? null;
            this.pendingMerge = prepared.mergeMessages ?? null;
        } catch {
            // The highlight or its note may be gone; fall back to what we sent
            // the first time rather than failing the retry outright.
            this.conversation = [...this.run.prepared.messages];
            this.pendingBatches = this.run.prepared.messageBatches ?? null;
            this.pendingMerge = this.run.prepared.mergeMessages ?? null;
        }
        await this.send();
    }

    private async askFollowUp(text: string): Promise<void> {
        this.conversation.push({ role: 'user', content: text });
        await this.send();
    }

    protected async onClose(): Promise<void> {
        // A request still in flight has nowhere to render; stop waiting on it.
        this.controller?.abort();
        this.controller = null;
        this.streamEl = null;
        this.thinkingEl = null;
        this.rich?.dispose();
        this.rich = null;
        this.contentEl.empty();
    }
}

/**
 * Opens a result panel and starts the run in it.
 *
 * A new tab each time rather than one reused panel: comparing two prompts, or
 * two models on the same note, means having both answers on screen, and a
 * panel that replaced the last answer would make that impossible.
 */
export async function openAiResultView(
    plugin: HighlightCommentsPlugin,
    run: AiResultRun
): Promise<AiResultView> {
    const leaf = plugin.app.workspace.getLeaf('tab');
    await leaf.setViewState({
        type: VIEW_TYPE_AI_RESULT,
        active: true,
        state: { promptName: run.prompt.name, icon: run.prompt.icon ?? 'sparkles' }
    });

    const view = leaf.view as unknown as AiResultView;
    view.start(run);
    return view;
}
