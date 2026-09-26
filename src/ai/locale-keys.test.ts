import en from '../../locale/en.json';
import zhCn from '../../locale/zh-cn.json';
import { i18n, t } from '../i18n';
import { extractionCompletionMessage } from './extraction-notice';
import { PROVIDERS, PROVIDER_ORDER } from './registry';
import type { AiErrorKind } from './types';

/**
 * The AI layer resolves user-facing text by key at runtime, so a typo in a key
 * or a translation missed in one locale only shows up as raw dotted text in a
 * Notice. These tests turn that into a build failure instead.
 */

type Tree = Record<string, unknown>;

function flatten(value: unknown, prefix = ''): string[] {
    if (typeof value !== 'object' || value === null) return [prefix];
    return Object.entries(value as Tree).flatMap(([key, child]) =>
        flatten(child, prefix ? `${prefix}.${key}` : key)
    );
}

const ERROR_KINDS: AiErrorKind[] = [
    'auth',
    'rate-limit',
    'quota',
    'network',
    'timeout',
    'bad-request',
    'server',
    'aborted',
    'unknown'
];

const READINESS_KEYS = [
    'ai.readiness.disabled',
    'ai.readiness.noProfile',
    'ai.readiness.noBaseUrl',
    'ai.readiness.noModel',
    'ai.readiness.noApiKey'
];

describe('AI locale keys', () => {
    beforeAll(async () => {
        await i18n.init();
    });

    it.each(READINESS_KEYS)('%s resolves to real text', key => {
        expect(t(key)).not.toBe(key);
    });

    it.each(ERROR_KINDS)('every error kind has a message: %s', kind => {
        const key = `ai.errors.${kind}`;
        expect(t(key)).not.toBe(key);
    });

    it('interpolates the provider name into the default profile name', () => {
        expect(t('ai.profile.defaultName', { provider: 'OpenAI' })).toContain('OpenAI');
    });

    it('interpolates the reason into a failed connection notice', () => {
        expect(t('settings.ai.actions.testFailed', { reason: 'boom' })).toContain('boom');
    });

    it('gives every builtin provider a label for the settings dropdown', () => {
        // Provider labels are product names, so they live in the registry
        // rather than the locale files. A gap would render as a blank option.
        for (const id of PROVIDER_ORDER) {
            expect(PROVIDERS[id].label.trim()).not.toBe('');
        }
    });
});

describe('locale parity', () => {
    // Scoped to the subtrees this feature owns. A whole-file check also
    // reports nine pre-existing gaps under settings.typography that predate
    // this feature, which would make this test fail for reasons it is not
    // guarding. Every namespace the AI work adds keys to belongs here — a
    // prefix left out is a gap this test would never see.
    const OWNED_PREFIXES = [
        'ai.',
        'settings.ai.',
        'render.',
        'modals.aiPrompt.',
        'modals.aiConfirm.',
        'modals.aiResult.',
        'modals.diagramZoom.',
        'actions.aiMenu',
        'commands.runAiPrompt'
    ];
    const isAiKey = (key: string) => OWNED_PREFIXES.some(prefix => key.startsWith(prefix));
    const enKeys = flatten(en).filter(isAiKey).sort();
    const zhKeys = flatten(zhCn).filter(isAiKey).sort();

    it('has AI keys in both locales', () => {
        expect(enKeys.length).toBeGreaterThan(40);
    });

    it('translates every English AI key in zh-cn', () => {
        expect(zhKeys.filter(key => !enKeys.includes(key))).toEqual([]);
        expect(enKeys.filter(key => !zhKeys.includes(key))).toEqual([]);
    });

    it('leaves no empty AI strings behind in either locale', () => {
        const empties = (tree: unknown, locale: string) =>
            flatten(tree)
                .filter(isAiKey)
                .filter(key => {
                    const parts = key.split('.');
                    let current: unknown = tree;
                    for (const part of parts) current = (current as Tree)[part];
                    return typeof current === 'string' && current.trim() === '';
                })
                .map(key => `${locale}:${key}`);

        expect([...empties(en, 'en'), ...empties(zhCn, 'zh-cn')]).toEqual([]);
    });
});

it.each(['en', 'zh-cn'])('interpolates extraction completion counts in %s', async locale => {
    const { moment } = await import('obsidian');
    const previous = moment.locale();
    jest.spyOn(moment, 'locale').mockReturnValue(locale);
    await i18n.init();
    const summary = t('ai.note.markedSummary', { marked: 2, already: 3, missed: 4 });
    expect(summary).toBe(locale === 'en'
        ? 'New highlights 2 / Already highlighted 3 / Not found 4'
        : '新标记 2 / 已被高亮 3 / 找不到 4');
    jest.spyOn(moment, 'locale').mockReturnValue(previous);
    await i18n.init();
});

it.each(['en', 'zh-cn'])('adds retry advice after zero-mark counts in %s', async locale => {
    const { moment } = await import('obsidian');
    const spy = jest.spyOn(moment, 'locale').mockReturnValue(locale);
    try {
        await i18n.init();
        const counts = { marked: 0, already: 1, missed: 2 };
        expect(extractionCompletionMessage(counts)).toBe(locale === 'en'
            ? 'New highlights 0 / Already highlighted 1 / Not found 2. The model may have paraphrased instead of quoting — try again, or ask it to quote exactly.'
            : '新标记 0 / 已被高亮 1 / 找不到 2。模型可能做了转述而非原文摘录——请重试，或要求它严格照抄原文。');
        expect(extractionCompletionMessage({ ...counts, marked: 1 }))
            .toBe(t('ai.note.markedSummary', { ...counts, marked: 1 }));
    } finally {
        spy.mockRestore();
        await i18n.init();
    }
});
