import { TFile } from 'obsidian';
import type HighlightCommentsPlugin from '../../main';
import type { Highlight } from '../../main';
import { i18n } from '../i18n';
import { cloneAiSettings, DEFAULT_AI_SETTINGS } from './types';
import type { AiProfile, PromptPreset } from './types';
import { collectContextSource, preparePromptRun, uiLanguageName } from './prompt-runner';

const NOTE_CONTENT = '# Heading\n\nThe full body of the note, read from disk.';

const PROFILE: AiProfile = {
    id: 'p1',
    name: 'Test profile',
    providerId: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini'
};

const PROMPT: PromptPreset = {
    id: 'test-prompt',
    name: 'Test prompt',
    template: 'Selection: {{selection}}\nNote: {{note}}',
    builtin: false,
    scope: 'highlight',
    enabled: true,
    outputTarget: 'both',
    sortOrder: 0
};

interface FakeVault {
    getAbstractFileByPath(path: string): unknown;
    cachedRead(file: unknown): Promise<string>;
}

function makeHighlight(over: Partial<Highlight> = {}): Highlight {
    return {
        id: 'h1',
        text: 'the highlighted text',
        tags: ['inbox'],
        line: 1,
        startOffset: 10,
        endOffset: 29,
        createdAt: 0,
        filePath: 'notes/a.md',
        ...over
    } as Highlight;
}

function makePlugin(
    ai: Partial<typeof DEFAULT_AI_SETTINGS> = {},
    highlight: Highlight = makeHighlight()
): { plugin: HighlightCommentsPlugin; cachedRead: jest.Mock } {
    const file = new TFile();
    file.path = highlight.filePath;
    file.basename = 'a';

    const cachedRead = jest.fn(async () => NOTE_CONTENT);

    const plugin = {
        settings: { ai: { ...cloneAiSettings(DEFAULT_AI_SETTINGS), ...ai } },
        aiService: { getActiveProfile: () => PROFILE },
        collections: new Map([['c1', { name: 'Reading list' }]]),
        app: {
            vault: {
                getAbstractFileByPath: (path: string) => (path === highlight.filePath ? file : null),
                cachedRead
            } as unknown as FakeVault
        }
    } as unknown as HighlightCommentsPlugin;

    return { plugin, cachedRead };
}

beforeAll(async () => {
    await i18n.init();
});

describe('uiLanguageName', () => {
    it('maps Chinese locales to the Chinese name', () => {
        expect(uiLanguageName('zh')).toBe('简体中文');
        expect(uiLanguageName('zh-cn')).toBe('简体中文');
    });

    it('defaults to English for everything else', () => {
        expect(uiLanguageName('en')).toBe('English');
        expect(uiLanguageName('de')).toBe('English');
    });
});

describe('collectContextSource', () => {
    it('does not read the note from disk when note context is off', async () => {
        // The gate is at the I/O boundary: a default install never even loads
        // the file, so there is nothing in memory to leak through a later bug.
        const { plugin, cachedRead } = makePlugin({ includeNoteContext: false });
        const source = await collectContextSource(plugin, makeHighlight());
        expect(cachedRead).not.toHaveBeenCalled();
        expect(source.noteContent).toBeUndefined();
    });

    it('reads the note when the setting allows it', async () => {
        const { plugin, cachedRead } = makePlugin({ includeNoteContext: true });
        const source = await collectContextSource(plugin, makeHighlight());
        expect(cachedRead).toHaveBeenCalledTimes(1);
        expect(source.noteContent).toBe(NOTE_CONTENT);
    });

    it('carries the title even without the body, and resolves collection names', async () => {
        const { plugin } = makePlugin({ includeNoteContext: false });
        const source = await collectContextSource(
            plugin,
            makeHighlight({ collectionIds: ['c1', 'missing'] })
        );
        expect(source.noteTitle).toBe('a');
        // A deleted collection resolves to nothing rather than to an id.
        expect(source.collections).toEqual(['Reading list']);
    });
});

describe('preparePromptRun', () => {
    it('rejects when no profile is configured', async () => {
        const { plugin } = makePlugin();
        (plugin.aiService as { getActiveProfile: () => AiProfile | null }).getActiveProfile = () => null;
        await expect(preparePromptRun(plugin, PROMPT, makeHighlight())).rejects.toThrow('No AI profile');
    });

    it('leaves the note out of the payload while the setting is off', async () => {
        const { plugin } = makePlugin({ includeNoteContext: false });
        const run = await preparePromptRun(plugin, PROMPT, makeHighlight());
        const sent = run.messages.map(message => message.content).join('\n');
        expect(sent).toContain('the highlighted text');
        expect(sent).not.toContain(NOTE_CONTENT);
    });

    it('includes the note body once the setting is on', async () => {
        const { plugin } = makePlugin({ includeNoteContext: true });
        const run = await preparePromptRun(plugin, PROMPT, makeHighlight());
        expect(run.messages.at(-1)?.content).toContain('The full body of the note');
    });

    it('describes the destination the payload will actually travel to', async () => {
        const { plugin } = makePlugin();
        const run = await preparePromptRun(plugin, PROMPT, makeHighlight());
        expect(run.destination).toEqual({
            provider: 'OpenAI',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini'
        });
        expect(run.payloadChars).toBe(run.messages.reduce((total, m) => total + m.content.length, 0));
    });

    it('uses the profile passed as an option over the active one', async () => {
        const other: AiProfile = { ...PROFILE, id: 'p2', name: 'Other', model: 'gpt-4o' };
        const { plugin } = makePlugin();
        const run = await preparePromptRun(plugin, PROMPT, makeHighlight(), { profile: other });
        expect(run.profile).toBe(other);
        expect(run.destination.model).toBe('gpt-4o');
    });

    it('carries ad-hoc input into the run', async () => {
        const prompt: PromptPreset = { ...PROMPT, template: '{{selection}} — {{input}}' };
        const { plugin } = makePlugin();
        const run = await preparePromptRun(plugin, prompt, makeHighlight(), { input: 'focus on tone' });
        expect(run.messages.at(-1)?.content).toContain('focus on tone');
    });
});
