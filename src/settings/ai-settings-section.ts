import { Notice, Platform, Setting, setIcon } from 'obsidian';
import type HighlightCommentsPlugin from '../../main';
import { t } from '../i18n';
import { createProfileForProvider, describeAiError } from '../ai/ai-service';
import { PROVIDERS, PROVIDER_ORDER, isBuiltinProvider, isMissingRequiredKey } from '../ai/registry';
import { hasUserChanges, removeStoredPrompt, resolvePrompts, upsertStoredPrompt } from '../ai/prompt-library';
import { AiPromptEditorModal, AiPromptImportModal } from '../modals/ai-prompt-editor-modal';
import { EMPTY_AI_USAGE, usageMonth } from '../ai/types';
import type { AiProfile, PromptPreset, ProviderId, ProviderKind } from '../ai/types';

function newId(): string {
    return `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Obsidian's dropdown onChange wants a synchronous callback, but saving is
 * async. This runs the save without handing a floating promise back to the
 * component.
 */
function runAsync(task: () => Promise<void>): void {
    void task();
}

/**
 * Renders the AI block of the settings tab into its own container, which it
 * owns and re-renders on its own. Re-rendering just this element instead of
 * calling display() again keeps the rest of a very long settings tab from
 * jumping back to the top whenever a profile is added or its provider changes.
 */
export function renderAiSettings(sectionEl: HTMLElement, plugin: HighlightCommentsPlugin): void {
    const render = () => {
        sectionEl.empty();
        renderInto(sectionEl, plugin, render);
        // Prompts drive command-palette entries, and this section is the only
        // place they change. Re-registering here keeps a renamed or deleted
        // prompt from lingering in the palette under its old name.
        plugin.registerAiPromptCommands();
    };
    render();
}

function renderInto(containerEl: HTMLElement, plugin: HighlightCommentsPlugin, refresh: () => void): void {
    const ai = plugin.settings.ai;

    new Setting(containerEl).setHeading().setName(t('settings.ai.heading'));

    new Setting(containerEl)
        .setName(t('settings.ai.enable.name'))
        .setDesc(t('settings.ai.enable.desc'))
        .addToggle(toggle => toggle
            .setValue(ai.enabled)
            .onChange(async value => {
                ai.enabled = value;
                await plugin.saveSettings();
                refresh();
            }));

    // Rich rendering is about comments the user already has, not about the
    // model, so it stays available with AI switched off.
    renderRenderingSettings(containerEl, plugin, refresh);

    if (!ai.enabled) {
        return;
    }

    renderPrivacyNotice(containerEl);
    renderProfilePicker(containerEl, plugin, refresh);

    const profile = plugin.aiService.getActiveProfile();
    if (profile) {
        renderProfileEditor(containerEl, plugin, profile, refresh);
    }

    new Setting(containerEl)
        .setName(t('settings.ai.timeout.name'))
        .setDesc(t('settings.ai.timeout.desc'))
        .addText(text => {
            text.inputEl.type = 'number';
            text.inputEl.min = '5';
            text.setValue(String(Math.round(ai.requestTimeoutMs / 1000)))
                .onChange(async value => {
                    const seconds = Number(value);
                    if (!Number.isFinite(seconds) || seconds < 5) return;
                    ai.requestTimeoutMs = Math.round(seconds) * 1000;
                    await plugin.saveSettings();
                });
        });

    renderStreamingSetting(containerEl, plugin);
    renderContextSettings(containerEl, plugin, refresh);
    renderPromptSettings(containerEl, plugin, refresh);
    renderUsageSettings(containerEl, plugin, refresh);
}

function renderStreamingSetting(containerEl: HTMLElement, plugin: HighlightCommentsPlugin): void {
    const ai = plugin.settings.ai;

    const setting = new Setting(containerEl)
        .setName(t('settings.ai.streaming.name'))
        .setDesc(t('settings.ai.streaming.desc'))
        .addToggle(toggle => toggle
            .setValue(ai.streaming)
            .onChange(async value => {
                ai.streaming = value;
                await plugin.saveSettings();
            }));

    // Left switchable rather than disabled: settings sync between devices, and
    // a toggle the user turns on here should still apply on their desktop.
    if (Platform.isMobile) {
        setting.descEl.createDiv({ cls: 'sh-ai-field-warning', text: t('settings.ai.streaming.mobile') });
    }
}

function renderUsageSettings(containerEl: HTMLElement, plugin: HighlightCommentsPlugin, refresh: () => void): void {
    const usage = plugin.settings.ai.usage;

    new Setting(containerEl).setHeading().setName(t('settings.ai.usage.heading'));
    containerEl.createDiv({ cls: 'setting-item-description sh-ai-prompts-desc', text: t('settings.ai.usage.desc') });

    // Totals from a previous month are shown as nothing rather than as this
    // month's, so the number on screen always means what its heading says.
    const current = usage.month === usageMonth() ? usage : EMPTY_AI_USAGE;

    const setting = new Setting(containerEl)
        .setName(current.calls === 0
            ? t('settings.ai.usage.none')
            : t('settings.ai.usage.summary', {
                calls: current.calls,
                promptTokens: current.promptTokens,
                completionTokens: current.completionTokens
            }));

    if (current.calls > 0) {
        setting.addButton(button => button
            .setButtonText(t('settings.ai.usage.reset'))
            .onClick(async () => {
                plugin.settings.ai.usage = { ...EMPTY_AI_USAGE, month: usageMonth() };
                await plugin.saveSettings();
                new Notice(t('settings.ai.usage.resetDone'));
                refresh();
            }));
    }
}

function renderRenderingSettings(containerEl: HTMLElement, plugin: HighlightCommentsPlugin, refresh: () => void): void {
    const ai = plugin.settings.ai;

    new Setting(containerEl).setHeading().setName(t('settings.ai.rendering.heading'));
    containerEl.createDiv({ cls: 'setting-item-description sh-ai-prompts-desc', text: t('settings.ai.rendering.desc') });

    new Setting(containerEl)
        .setName(t('settings.ai.rendering.enable.name'))
        .setDesc(t('settings.ai.rendering.enable.desc'))
        .addToggle(toggle => toggle
            .setValue(ai.renderRichContent)
            .onChange(async value => {
                ai.renderRichContent = value;
                await plugin.saveSettings();
                // The sub-options only apply while rich rendering is on.
                refresh();
                plugin.refreshSidebar();
            }));

    if (!ai.renderRichContent) return;

    new Setting(containerEl)
        .setName(t('settings.ai.rendering.mermaid.name'))
        .setDesc(t('settings.ai.rendering.mermaid.desc'))
        .addToggle(toggle => toggle
            .setValue(ai.renderMermaid)
            .onChange(async value => {
                ai.renderMermaid = value;
                await plugin.saveSettings();
                plugin.refreshSidebar();
            }));

    new Setting(containerEl)
        .setName(t('settings.ai.rendering.maxHeight.name'))
        .setDesc(t('settings.ai.rendering.maxHeight.desc'))
        .addText(text => {
            text.inputEl.type = 'number';
            text.inputEl.min = '80';
            text.setValue(String(ai.maxDiagramHeight))
                .onChange(async value => {
                    const parsed = Number(value);
                    if (!Number.isFinite(parsed) || parsed < 80) return;
                    ai.maxDiagramHeight = Math.round(parsed);
                    await plugin.saveSettings();
                    plugin.refreshSidebar();
                });
        });
}

function renderContextSettings(containerEl: HTMLElement, plugin: HighlightCommentsPlugin, refresh: () => void): void {
    const ai = plugin.settings.ai;

    new Setting(containerEl).setHeading().setName(t('settings.ai.context.heading'));

    new Setting(containerEl)
        .setName(t('settings.ai.context.includeNote.name'))
        .setDesc(t('settings.ai.context.includeNote.desc'))
        .addToggle(toggle => toggle
            .setValue(ai.includeNoteContext)
            .onChange(async value => {
                ai.includeNoteContext = value;
                await plugin.saveSettings();
                // The variable palette greys out gated variables, so it has to
                // be rebuilt when the gate moves.
                refresh();
            }));

    new Setting(containerEl)
        .setName(t('settings.ai.context.includeComments.name'))
        .setDesc(t('settings.ai.context.includeComments.desc'))
        .addToggle(toggle => toggle
            .setValue(ai.includeExistingComments)
            .onChange(async value => {
                ai.includeExistingComments = value;
                await plugin.saveSettings();
                refresh();
            }));

    new Setting(containerEl)
        .setName(t('settings.ai.context.charLimit.name'))
        .setDesc(t('settings.ai.context.charLimit.desc'))
        .addText(text => {
            text.inputEl.type = 'number';
            text.inputEl.min = '0';
            text.setValue(String(ai.contextCharLimit))
                .onChange(async value => {
                    const parsed = Number(value);
                    if (!Number.isFinite(parsed) || parsed < 0) return;
                    ai.contextCharLimit = Math.round(parsed);
                    await plugin.saveSettings();
                });
        });

    new Setting(containerEl)
        .setName(t('settings.ai.context.targetLanguage.name'))
        .setDesc(t('settings.ai.context.targetLanguage.desc'))
        .addText(text => text
            .setPlaceholder('简体中文')
            .setValue(ai.defaultTargetLanguage)
            .onChange(async value => {
                ai.defaultTargetLanguage = value.trim();
                await plugin.saveSettings();
            }));

    new Setting(containerEl)
        .setName(t('settings.ai.context.confirm.name'))
        .setDesc(t('settings.ai.context.confirm.desc'))
        .addToggle(toggle => toggle
            .setValue(ai.confirmBeforeSend)
            .onChange(async value => {
                ai.confirmBeforeSend = value;
                await plugin.saveSettings();
            }));
}

function renderPromptSettings(containerEl: HTMLElement, plugin: HighlightCommentsPlugin, refresh: () => void): void {
    const ai = plugin.settings.ai;

    new Setting(containerEl).setHeading().setName(t('settings.ai.prompts.heading'));
    containerEl.createDiv({ cls: 'setting-item-description sh-ai-prompts-desc', text: t('settings.ai.prompts.desc') });

    for (const prompt of resolvePrompts(ai.prompts)) {
        const setting = new Setting(containerEl).setName(prompt.name);

        if (prompt.icon) {
            const icon = setting.nameEl.createSpan({ cls: 'sh-ai-prompt-icon' });
            setIcon(icon, prompt.icon);
            setting.nameEl.prepend(icon);
        }

        const badges: string[] = [];
        if (prompt.builtin && hasUserChanges(ai.prompts, prompt.id)) badges.push(t('settings.ai.prompts.edited'));
        if (!prompt.enabled) badges.push(t('settings.ai.prompts.disabled'));
        if (badges.length > 0) setting.setDesc(badges.join(' · '));

        setting.addToggle(toggle => toggle
            .setValue(prompt.enabled)
            .onChange(async value => {
                // A patch of exactly one field: the template keeps tracking the
                // shipped version even after the user disables a builtin.
                ai.prompts = upsertStoredPrompt(ai.prompts, { id: prompt.id, enabled: value });
                await plugin.saveSettings();
                refresh();
            }));

        setting.addButton(button => button
            .setButtonText(t('settings.ai.prompts.edit'))
            .onClick(() => {
                new AiPromptEditorModal(plugin.app, prompt, ai, async patch => {
                    ai.prompts = upsertStoredPrompt(ai.prompts, patch);
                    await plugin.saveSettings();
                    refresh();
                }).open();
            }));

        if (prompt.builtin) {
            if (hasUserChanges(ai.prompts, prompt.id)) {
                setting.addButton(button => button
                    .setButtonText(t('settings.ai.prompts.reset'))
                    .onClick(async () => {
                        ai.prompts = removeStoredPrompt(ai.prompts, prompt.id);
                        await plugin.saveSettings();
                        refresh();
                    }));
            }
        } else {
            setting.addButton(button => button
                .setButtonText(t('settings.ai.prompts.delete'))
                .setWarning()
                .onClick(async () => {
                    ai.prompts = removeStoredPrompt(ai.prompts, prompt.id);
                    await plugin.saveSettings();
                    refresh();
                }));
        }
    }

    const actions = new Setting(containerEl);

    actions.addButton(button => button
        .setButtonText(t('settings.ai.prompts.add'))
        .setCta()
        .onClick(() => {
            const draft: PromptPreset = {
                id: newId(),
                name: '',
                template: '{{selection}}',
                builtin: false,
                outputTarget: 'both',
                enabled: true,
                sortOrder: resolvePrompts(ai.prompts).length
            };
            new AiPromptEditorModal(plugin.app, draft, ai, async patch => {
                ai.prompts = upsertStoredPrompt(ai.prompts, patch);
                await plugin.saveSettings();
                refresh();
            }).open();
        }));

    actions.addButton(button => button
        .setButtonText(t('settings.ai.prompts.export'))
        .onClick(async () => {
            if (ai.prompts.length === 0) {
                new Notice(t('settings.ai.prompts.exportEmpty'));
                return;
            }
            try {
                await navigator.clipboard.writeText(JSON.stringify(ai.prompts, null, 2));
                new Notice(t('settings.ai.prompts.exported', { count: ai.prompts.length }));
            } catch {
                // Clipboard access is not guaranteed — notably on mobile, and
                // the plugin is not desktop-only. Say so rather than appearing
                // to have worked.
                new Notice(t('settings.ai.prompts.exportFailed'));
            }
        }));

    actions.addButton(button => button
        .setButtonText(t('settings.ai.prompts.import'))
        .onClick(() => {
            new AiPromptImportModal(plugin.app, async prompts => {
                ai.prompts = prompts;
                await plugin.saveSettings();
                new Notice(t('settings.ai.prompts.imported', { count: prompts.length }));
                refresh();
            }).open();
        }));
}

/**
 * Stated up front rather than buried in a tooltip: the key really is stored in
 * plain text and really does travel with the vault, and the user deserves to
 * know that before they paste one in.
 */
function renderPrivacyNotice(containerEl: HTMLElement): void {
    const notice = containerEl.createDiv({ cls: 'sh-ai-privacy-notice' });
    notice.createDiv({ cls: 'sh-ai-privacy-title', text: t('settings.ai.privacy.title') });
    const list = notice.createEl('ul', { cls: 'sh-ai-privacy-list' });
    list.createEl('li', { text: t('settings.ai.privacy.storage') });
    list.createEl('li', { text: t('settings.ai.privacy.backups') });
    list.createEl('li', { text: t('settings.ai.privacy.scope') });
}

function renderProfilePicker(containerEl: HTMLElement, plugin: HighlightCommentsPlugin, refresh: () => void): void {
    const ai = plugin.settings.ai;

    const setting = new Setting(containerEl)
        .setName(t('settings.ai.profile.name'))
        .setDesc(ai.profiles.length === 0
            ? t('settings.ai.profile.empty')
            : t('settings.ai.profile.desc'));

    if (ai.profiles.length > 0) {
        setting.addDropdown(dropdown => {
            ai.profiles.forEach(profile => {
                dropdown.addOption(profile.id, profile.name || t('settings.ai.profile.untitled'));
            });
            dropdown.setValue(plugin.aiService.getActiveProfile()?.id ?? ai.profiles[0].id);
            dropdown.onChange(value => runAsync(async () => {
                ai.activeProfileId = value;
                await plugin.saveSettings();
                refresh();
            }));
        });
    }

    setting.addButton(button => button
        .setButtonText(t('settings.ai.profile.add'))
        .setCta()
        .onClick(async () => {
            const profile = createProfileForProvider('openai', newId());
            ai.profiles.push(profile);
            ai.activeProfileId = profile.id;
            await plugin.saveSettings();
            refresh();
        }));
}

function renderProfileEditor(
    containerEl: HTMLElement,
    plugin: HighlightCommentsPlugin,
    profile: AiProfile,
    refresh: () => void
): void {
    const ai = plugin.settings.ai;

    new Setting(containerEl)
        .setName(t('settings.ai.field.name.name'))
        .addText(text => text
            .setPlaceholder(t('settings.ai.field.name.placeholder'))
            .setValue(profile.name)
            .onChange(async value => {
                profile.name = value;
                await plugin.saveSettings();
            }));

    new Setting(containerEl)
        .setName(t('settings.ai.field.provider.name'))
        .setDesc(t('settings.ai.field.provider.desc'))
        .addDropdown(dropdown => {
            PROVIDER_ORDER.forEach(id => {
                dropdown.addOption(id, PROVIDERS[id].label);
            });
            dropdown.addOption('custom', t('settings.ai.field.provider.custom'));
            dropdown.setValue(profile.providerId);
            dropdown.onChange(value => runAsync(async () => {
                const nextId = value as ProviderId;
                const untouched = isProfileUntouched(profile);
                profile.providerId = nextId;
                // Only overwrite URL and model when the user has not already
                // typed their own; switching providers to compare two endpoints
                // should not silently discard a hand-entered model name.
                if (isBuiltinProvider(nextId)) {
                    delete profile.customKind;
                    if (untouched) {
                        profile.baseUrl = PROVIDERS[nextId].defaultBaseUrl;
                        profile.model = PROVIDERS[nextId].defaultModel;
                    }
                } else {
                    profile.customKind = profile.customKind ?? 'openai-compatible';
                }
                await plugin.saveSettings();
                refresh();
            }));
        });

    if (profile.providerId === 'custom') {
        new Setting(containerEl)
            .setName(t('settings.ai.field.wireFormat.name'))
            .setDesc(t('settings.ai.field.wireFormat.desc'))
            .addDropdown(dropdown => {
                dropdown.addOption('openai-compatible', 'OpenAI compatible');
                dropdown.addOption('anthropic', 'Anthropic messages');
                dropdown.addOption('gemini', 'Google Gemini');
                dropdown.setValue(profile.customKind ?? 'openai-compatible');
                dropdown.onChange(value => runAsync(async () => {
                    profile.customKind = value as ProviderKind;
                    await plugin.saveSettings();
                }));
            });
    }

    new Setting(containerEl)
        .setName(t('settings.ai.field.baseUrl.name'))
        .setDesc(t('settings.ai.field.baseUrl.desc'))
        .addText(text => {
            text.inputEl.addClass('sh-ai-wide-input');
            text.setPlaceholder('https://api.example.com/v1')
                .setValue(profile.baseUrl)
                .onChange(async value => {
                    profile.baseUrl = value.trim();
                    await plugin.saveSettings();
                });
        });

    renderApiKeyField(containerEl, plugin, profile);
    renderModelField(containerEl, plugin, profile, refresh);

    new Setting(containerEl)
        .setName(t('settings.ai.field.temperature.name'))
        .setDesc(t('settings.ai.field.temperature.desc'))
        .addText(text => {
            text.inputEl.type = 'number';
            text.inputEl.step = '0.1';
            text.setPlaceholder(t('settings.ai.field.temperature.placeholder'))
                .setValue(profile.temperature === undefined ? '' : String(profile.temperature))
                .onChange(async value => {
                    // Empty means "let the provider decide", which is not the
                    // same as 0 and is the right default for reasoning models
                    // that reject the parameter outright.
                    const parsed = Number(value);
                    profile.temperature = value.trim() === '' || !Number.isFinite(parsed) ? undefined : parsed;
                    await plugin.saveSettings();
                });
        });

    new Setting(containerEl)
        .setName(t('settings.ai.field.maxTokens.name'))
        .setDesc(t('settings.ai.field.maxTokens.desc'))
        .addText(text => {
            text.inputEl.type = 'number';
            text.setPlaceholder(t('settings.ai.field.maxTokens.placeholder'))
                .setValue(profile.maxTokens === undefined ? '' : String(profile.maxTokens))
                .onChange(async value => {
                    const parsed = Number(value);
                    profile.maxTokens = value.trim() === '' || !Number.isFinite(parsed) ? undefined : Math.round(parsed);
                    await plugin.saveSettings();
                });
        });

    const actions = new Setting(containerEl)
        .setName(t('settings.ai.actions.name'))
        .setDesc(t('settings.ai.actions.desc'));

    actions.addButton(button => button
        .setButtonText(t('settings.ai.actions.test'))
        .setCta()
        .onClick(async () => {
            const problem = plugin.aiService.checkReadiness(profile);
            if (problem) {
                new Notice(t(problem.reasonKey));
                return;
            }

            button.setDisabled(true);
            button.setButtonText(t('settings.ai.actions.testing'));
            try {
                const model = await plugin.aiService.testConnection(profile);
                new Notice(t('settings.ai.actions.testSuccess', { model }));
            } catch (error) {
                new Notice(t('settings.ai.actions.testFailed', { reason: describeAiError(error) }), 8000);
            } finally {
                button.setDisabled(false);
                button.setButtonText(t('settings.ai.actions.test'));
            }
        }));

    actions.addButton(button => button
        .setButtonText(t('settings.ai.actions.duplicate'))
        .onClick(async () => {
            const copy: AiProfile = {
                ...profile,
                id: newId(),
                name: t('settings.ai.actions.copyName', { name: profile.name })
            };
            ai.profiles.push(copy);
            ai.activeProfileId = copy.id;
            await plugin.saveSettings();
            refresh();
        }));

    actions.addButton(button => button
        .setButtonText(t('settings.ai.actions.delete'))
        .setWarning()
        .onClick(async () => {
            ai.profiles = ai.profiles.filter(entry => entry.id !== profile.id);
            if (ai.activeProfileId === profile.id) {
                ai.activeProfileId = ai.profiles[0]?.id ?? null;
            }
            await plugin.saveSettings();
            refresh();
        }));
}

function renderApiKeyField(containerEl: HTMLElement, plugin: HighlightCommentsPlugin, profile: AiProfile): void {
    const descriptor = isBuiltinProvider(profile.providerId) ? PROVIDERS[profile.providerId] : null;

    const desc = createFragment();
    desc.append(t('settings.ai.field.apiKey.desc'));
    if (descriptor?.apiKeyUrl) {
        desc.append(' ');
        const link = desc.createEl('a', { text: t('settings.ai.field.apiKey.getKey'), href: descriptor.apiKeyUrl });
        link.setAttr('target', '_blank');
        link.setAttr('rel', 'noopener');
    }

    const setting = new Setting(containerEl)
        .setName(t('settings.ai.field.apiKey.name'))
        .setDesc(desc);

    let input: HTMLInputElement | null = null;

    setting.addText(text => {
        input = text.inputEl;
        input.type = 'password';
        input.autocomplete = 'off';
        input.addClass('sh-ai-wide-input');
        text.setPlaceholder(descriptor && !descriptor.requiresKey
            ? t('settings.ai.field.apiKey.optional')
            : t('settings.ai.field.apiKey.placeholder'))
            .setValue(profile.apiKey)
            .onChange(async value => {
                profile.apiKey = value.trim();
                await plugin.saveSettings();
            });
    });

    setting.addExtraButton(button => {
        button.setIcon('eye')
            .setTooltip(t('settings.ai.field.apiKey.reveal'))
            .onClick(() => {
                if (!input) return;
                const hidden = input.type === 'password';
                input.type = hidden ? 'text' : 'password';
                button.setIcon(hidden ? 'eye-off' : 'eye');
                button.setTooltip(hidden ? t('settings.ai.field.apiKey.hide') : t('settings.ai.field.apiKey.reveal'));
            });
    });

    if (isMissingRequiredKey(profile)) {
        setting.descEl.createDiv({ cls: 'sh-ai-field-warning', text: t('settings.ai.field.apiKey.missing') });
    }
}

function renderModelField(
    containerEl: HTMLElement,
    plugin: HighlightCommentsPlugin,
    profile: AiProfile,
    refresh: () => void
): void {
    const setting = new Setting(containerEl)
        .setName(t('settings.ai.field.model.name'))
        .setDesc(t('settings.ai.field.model.desc'));

    setting.addText(text => {
        text.inputEl.addClass('sh-ai-wide-input');

        // A free-text field with suggestions rather than a dropdown: providers
        // add models faster than the registry can track, and a fixed list would
        // block a model the user can already use.
        const suggestions = isBuiltinProvider(profile.providerId)
            ? PROVIDERS[profile.providerId].suggestedModels
            : [];
        if (suggestions.length > 0) {
            const listId = `sh-ai-models-${profile.id}`;
            const datalist = setting.controlEl.createEl('datalist');
            datalist.id = listId;
            suggestions.forEach(model => datalist.createEl('option', { value: model }));
            text.inputEl.setAttribute('list', listId);
        }

        text.setPlaceholder(t('settings.ai.field.model.placeholder'))
            .setValue(profile.model)
            .onChange(async value => {
                profile.model = value.trim();
                await plugin.saveSettings();
            });
    });

    setting.addButton(button => button
        .setButtonText(t('settings.ai.field.model.fetch'))
        .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText(t('settings.ai.field.model.fetching'));
            try {
                const models = await plugin.aiService.listModels(profile);
                if (models.length === 0) {
                    new Notice(t('settings.ai.field.model.fetchEmpty'));
                    return;
                }
                fetchedModels.set(profile.id, models);
                new Notice(t('settings.ai.field.model.fetchSuccess', { count: models.length }));
                refresh();
            } catch (error) {
                new Notice(t('settings.ai.field.model.fetchFailed', { reason: describeAiError(error) }), 8000);
            } finally {
                button.setDisabled(false);
                button.setButtonText(t('settings.ai.field.model.fetch'));
            }
        }));

    // Models fetched this session widen the suggestion list without being
    // written to disk — they are a convenience, not configuration.
    const fetched = fetchedModels.get(profile.id);
    if (fetched && fetched.length > 0) {
        const listId = `sh-ai-fetched-${profile.id}`;
        const datalist = setting.controlEl.createEl('datalist');
        datalist.id = listId;
        fetched.forEach(model => datalist.createEl('option', { value: model }));
        const input = setting.controlEl.querySelector('input');
        if (input) input.setAttribute('list', listId);
    }
}

/** Session-only cache of fetched model ids, keyed by profile. */
const fetchedModels = new Map<string, string[]>();

/**
 * True when base URL and model still match the provider's defaults, meaning
 * nothing the user typed is at risk of being overwritten.
 */
function isProfileUntouched(profile: AiProfile): boolean {
    if (!profile.baseUrl.trim() && !profile.model.trim()) return true;
    if (!isBuiltinProvider(profile.providerId)) return false;
    const descriptor = PROVIDERS[profile.providerId];
    return profile.baseUrl === descriptor.defaultBaseUrl && profile.model === descriptor.defaultModel;
}
