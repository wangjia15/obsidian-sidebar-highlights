import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import { t } from '../i18n';
import { PROMPT_VARIABLES, isBuiltinPromptId, parseStoredPrompts, unknownVariables, variablesUsed, type PromptVariableName } from '../ai/prompt-library';
import type { AiSettings, PromptOutputTarget, PromptPreset, StoredPrompt } from '../ai/types';

/** Variables that resolve to nothing unless the matching setting is on. */
const GATED_VARIABLES: Partial<Record<PromptVariableName, keyof AiSettings>> = {
    note: 'includeNoteContext',
    context: 'includeNoteContext',
    comments: 'includeExistingComments'
};

/**
 * Editor for one prompt.
 *
 * Saves a patch rather than a whole prompt: for a builtin, only the fields the
 * user actually changed are written, so the rest keeps tracking the shipped
 * version. For a user-authored prompt every field is written, since there is
 * nothing underneath to fall back to.
 */
export class AiPromptEditorModal extends Modal {
    private draft: {
        name: string;
        icon: string;
        system: string;
        template: string;
        outputTarget: PromptOutputTarget;
        enabled: boolean;
    };

    private templateInput: HTMLTextAreaElement | null = null;
    private warningsEl: HTMLElement | null = null;

    constructor(
        app: App,
        private readonly prompt: PromptPreset,
        private readonly settings: AiSettings,
        private readonly onSubmit: (patch: StoredPrompt) => void | Promise<void>
    ) {
        super(app);
        this.draft = {
            name: prompt.name,
            icon: prompt.icon ?? '',
            system: prompt.system ?? '',
            template: prompt.template,
            outputTarget: prompt.outputTarget,
            enabled: prompt.enabled
        };
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('sh-ai-prompt-modal');

        this.titleEl.setText(
            this.prompt.builtin || this.prompt.template
                ? t('modals.aiPrompt.editTitle')
                : t('modals.aiPrompt.createTitle')
        );

        if (this.prompt.builtin) {
            contentEl.createDiv({ cls: 'sh-ai-prompt-notice', text: t('modals.aiPrompt.builtinNotice') });
        }

        new Setting(contentEl)
            .setName(t('modals.aiPrompt.nameLabel'))
            .addText(text => text
                .setPlaceholder(t('modals.aiPrompt.namePlaceholder'))
                .setValue(this.draft.name)
                .onChange(value => { this.draft.name = value; }));

        new Setting(contentEl)
            .setName(t('modals.aiPrompt.iconLabel'))
            .setDesc(t('modals.aiPrompt.iconDesc'))
            .addText(text => text
                .setPlaceholder('sparkles')
                .setValue(this.draft.icon)
                .onChange(value => { this.draft.icon = value.trim(); }));

        new Setting(contentEl)
            .setName(t('modals.aiPrompt.systemLabel'))
            .setDesc(t('modals.aiPrompt.systemDesc'))
            .addTextArea(area => {
                area.inputEl.addClass('sh-ai-prompt-textarea');
                area.inputEl.rows = 3;
                area.setValue(this.draft.system)
                    .onChange(value => { this.draft.system = value; });
            });

        new Setting(contentEl)
            .setName(t('modals.aiPrompt.templateLabel'))
            .setDesc(t('modals.aiPrompt.templateDesc'))
            .addTextArea(area => {
                this.templateInput = area.inputEl;
                area.inputEl.addClass('sh-ai-prompt-textarea');
                area.inputEl.rows = 8;
                area.setValue(this.draft.template)
                    .onChange(value => {
                        this.draft.template = value;
                        this.renderWarnings();
                    });
            });

        this.renderVariablePalette(contentEl);
        this.warningsEl = contentEl.createDiv({ cls: 'sh-ai-prompt-warnings' });
        this.renderWarnings();

        new Setting(contentEl)
            .setName(t('modals.aiPrompt.outputLabel'))
            .addDropdown(dropdown => {
                dropdown.addOption('both', t('modals.aiPrompt.outputBoth'));
                dropdown.addOption('preview', t('modals.aiPrompt.outputPreview'));
                dropdown.addOption('comment', t('modals.aiPrompt.outputComment'));
                dropdown.setValue(this.draft.outputTarget);
                dropdown.onChange(value => { this.draft.outputTarget = value as PromptOutputTarget; });
            });

        new Setting(contentEl)
            .setName(t('modals.aiPrompt.enabledLabel'))
            .addToggle(toggle => toggle
                .setValue(this.draft.enabled)
                .onChange(value => { this.draft.enabled = value; }));

        const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
        const cancel = buttons.createEl('button', { text: t('modals.aiPrompt.cancel') });
        cancel.addEventListener('click', () => this.close());

        const save = buttons.createEl('button', { text: t('modals.aiPrompt.save'), cls: 'mod-cta' });
        save.addEventListener('click', () => { void this.submit(); });
    }

    /**
     * Clickable chips rather than a static list: the whole point is to get the
     * exact spelling into the template without the user retyping it.
     */
    private renderVariablePalette(containerEl: HTMLElement): void {
        const palette = containerEl.createDiv({ cls: 'sh-ai-variable-palette' });
        palette.createDiv({ cls: 'sh-ai-variable-label', text: t('modals.aiPrompt.variables') });
        const chips = palette.createDiv({ cls: 'sh-ai-variable-chips' });

        for (const name of PROMPT_VARIABLES) {
            const gate = GATED_VARIABLES[name];
            const gated = gate !== undefined && this.settings[gate] === false;

            const chip = chips.createEl('button', {
                cls: `sh-ai-variable-chip${gated ? ' is-gated' : ''}`,
                text: `{{${name}}}`
            });
            chip.type = 'button';
            if (gated) chip.title = t('modals.aiPrompt.variableGated');
            chip.addEventListener('click', () => this.insertVariable(name));
        }
    }

    /** Inserts at the caret, replacing any selection, and keeps focus in the field. */
    private insertVariable(name: string): void {
        const input = this.templateInput;
        if (!input) return;

        const token = `{{${name}}}`;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;

        input.value = `${input.value.slice(0, start)}${token}${input.value.slice(end)}`;
        this.draft.template = input.value;

        const caret = start + token.length;
        input.focus();
        input.setSelectionRange(caret, caret);
        this.renderWarnings();
    }

    private renderWarnings(): void {
        const target = this.warningsEl;
        if (!target) return;
        target.empty();

        const unknown = unknownVariables(this.draft.template);
        if (unknown.length > 0) {
            target.createDiv({
                cls: 'sh-ai-prompt-warning',
                text: t('modals.aiPrompt.unknownVariable', { names: unknown.map(name => `{{${name}}}`).join(', ') })
            });
        }

        if (this.draft.template.trim() && !variablesUsed(this.draft.template).includes('selection')) {
            const row = target.createDiv({ cls: 'sh-ai-prompt-warning is-hint' });
            const icon = row.createSpan({ cls: 'sh-ai-prompt-warning-icon' });
            setIcon(icon, 'info');
            row.createSpan({ text: t('modals.aiPrompt.noSelection') });
        }
    }

    private async submit(): Promise<void> {
        if (!this.draft.template.trim()) {
            new Notice(t('modals.aiPrompt.emptyTemplate'));
            return;
        }

        await this.onSubmit(this.buildPatch());
        this.close();
    }

    /**
     * For a builtin, only the changed fields — that is what keeps an untouched
     * field tracking the shipped prompt. For a user prompt, everything.
     */
    private buildPatch(): StoredPrompt {
        const patch: StoredPrompt = { id: this.prompt.id };
        const changed = <K extends keyof typeof this.draft>(key: K, current: unknown) =>
            this.draft[key] !== current;

        if (!isBuiltinPromptId(this.prompt.id)) {
            return {
                id: this.prompt.id,
                name: this.draft.name.trim() || t('ai.prompts.untitled'),
                icon: this.draft.icon || undefined,
                system: this.draft.system.trim() || undefined,
                template: this.draft.template,
                outputTarget: this.draft.outputTarget,
                enabled: this.draft.enabled,
                sortOrder: this.prompt.sortOrder
            };
        }

        if (changed('name', this.prompt.name)) patch.name = this.draft.name.trim();
        if (changed('icon', this.prompt.icon ?? '')) patch.icon = this.draft.icon || undefined;
        if (changed('system', this.prompt.system ?? '')) patch.system = this.draft.system;
        if (changed('template', this.prompt.template)) patch.template = this.draft.template;
        if (changed('outputTarget', this.prompt.outputTarget)) patch.outputTarget = this.draft.outputTarget;
        if (changed('enabled', this.prompt.enabled)) patch.enabled = this.draft.enabled;

        return patch;
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

/** Paste-a-blob importer, the counterpart to the "copy as JSON" button. */
export class AiPromptImportModal extends Modal {
    private text = '';

    constructor(app: App, private readonly onSubmit: (prompts: StoredPrompt[]) => void | Promise<void>) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('sh-ai-prompt-modal');

        this.titleEl.setText(t('settings.ai.prompts.importTitle'));
        contentEl.createDiv({ cls: 'sh-ai-prompt-notice', text: t('settings.ai.prompts.importDesc') });

        new Setting(contentEl)
            .addTextArea(area => {
                area.inputEl.addClass('sh-ai-prompt-textarea');
                area.inputEl.rows = 10;
                area.setPlaceholder(t('settings.ai.prompts.importPlaceholder'))
                    .onChange(value => { this.text = value; });
            });

        const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
        const cancel = buttons.createEl('button', { text: t('settings.ai.prompts.cancel') });
        cancel.addEventListener('click', () => this.close());

        const submit = buttons.createEl('button', { text: t('settings.ai.prompts.importButton'), cls: 'mod-cta' });
        submit.addEventListener('click', () => { void this.submit(); });
    }

    private async submit(): Promise<void> {
        const parsed = parseStoredPrompts(this.text);
        if (!parsed) {
            new Notice(t('settings.ai.prompts.importInvalid'), 8000);
            return;
        }
        await this.onSubmit(parsed);
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
