import { App, Modal, Setting } from 'obsidian';
import { t } from '../i18n';
import type { PreparedRun } from '../ai/prompt-runner';

/**
 * Shown once per vault before anything first leaves the machine.
 *
 * States the actual destination and the actual payload size rather than a
 * generic "this uses AI" warning, so the user is agreeing to something
 * concrete. Nothing has been sent when this opens.
 */
export class AiConfirmSendModal extends Modal {
    private dontAskAgain = false;

    constructor(
        app: App,
        private readonly run: PreparedRun,
        private readonly onConfirm: (dontAskAgain: boolean) => void
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('sh-ai-confirm-modal');

        this.titleEl.setText(t('modals.aiConfirm.title'));
        contentEl.createDiv({ cls: 'sh-ai-confirm-lead', text: t('modals.aiConfirm.lead') });

        const facts = contentEl.createDiv({ cls: 'sh-ai-confirm-facts' });
        this.addFact(facts, t('modals.aiConfirm.prompt'), this.run.prompt.name);
        this.addFact(facts, t('modals.aiConfirm.provider'), this.run.destination.provider);
        this.addFact(facts, t('modals.aiConfirm.endpoint'), this.run.destination.baseUrl);
        this.addFact(facts, t('modals.aiConfirm.model'), this.run.destination.model);
        this.addFact(
            facts,
            t('modals.aiConfirm.payload'),
            t('modals.aiConfirm.payloadValue', { chars: this.run.payloadChars })
        );

        new Setting(contentEl)
            .setName(t('modals.aiConfirm.dontAsk'))
            .addToggle(toggle => toggle
                .setValue(false)
                .onChange(value => { this.dontAskAgain = value; }));

        const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
        const cancel = buttons.createEl('button', { text: t('modals.aiConfirm.cancel') });
        cancel.addEventListener('click', () => this.close());

        const send = buttons.createEl('button', { text: t('modals.aiConfirm.send'), cls: 'mod-cta' });
        send.addEventListener('click', () => {
            this.close();
            this.onConfirm(this.dontAskAgain);
        });
        window.setTimeout(() => send.focus(), 0);
    }

    private addFact(container: HTMLElement, label: string, value: string): void {
        const row = container.createDiv({ cls: 'sh-ai-confirm-row' });
        row.createDiv({ cls: 'sh-ai-confirm-key', text: label });
        row.createDiv({ cls: 'sh-ai-confirm-value', text: value });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
