import { applyOutputLanguage, promptFixesItsOwnLanguage, resolveOutputLanguage } from './output-language';
import type { AiMessage } from './types';

describe('resolveOutputLanguage', () => {
    const settings = (outputLanguageMode: 'ui' | 'source' | 'custom', customOutputLanguage = '') =>
        ({ outputLanguageMode, customOutputLanguage });

    it('follows the interface language by default', () => {
        expect(resolveOutputLanguage(settings('ui'), '简体中文')).toBe('简体中文');
    });

    it('leaves the prompt alone in source mode', () => {
        expect(resolveOutputLanguage(settings('source'), '简体中文')).toBeUndefined();
    });

    it('uses a custom language, falling back to the interface one when blank', () => {
        expect(resolveOutputLanguage(settings('custom', '日本語'), 'English')).toBe('日本語');
        expect(resolveOutputLanguage(settings('custom', ' '), 'English')).toBe('English');
    });

    it('lets a per-run override win', () => {
        expect(resolveOutputLanguage(settings('source'), 'English', 'German')).toBe('German');
    });
});

describe('applyOutputLanguage', () => {
    it('replaces the mirror-the-source rule and reminds in the last user turn', () => {
        const messages: AiMessage[] = [
            { role: 'system', content: 'You explain. Answer in the same language as the text you are given.' },
            { role: 'user', content: 'Explain: hello world' }
        ];
        applyOutputLanguage(messages, '简体中文');

        expect(messages[0].content).not.toContain('same language');
        expect(messages[0].content).toContain('Always write your answer in 简体中文');
        expect(messages[1].content.endsWith('请使用简体中文回答。')).toBe(true);
    });

    it('adds a system message when the prompt has none', () => {
        const messages: AiMessage[] = [{ role: 'user', content: 'Summarize' }];
        applyOutputLanguage(messages, 'English');

        expect(messages[0].role).toBe('system');
        expect(messages[1].content.endsWith('Answer in English.')).toBe(true);
    });
});

describe('promptFixesItsOwnLanguage', () => {
    it('is true for translation and extraction prompts only', () => {
        expect(promptFixesItsOwnLanguage({ template: 'Translate into {{targetLang}}', outputTarget: 'both' })).toBe(true);
        expect(promptFixesItsOwnLanguage({ template: 'x', outputTarget: 'highlights' })).toBe(true);
        expect(promptFixesItsOwnLanguage({ template: 'Summarize {{selection}}', outputTarget: 'both' })).toBe(false);
    });
});
