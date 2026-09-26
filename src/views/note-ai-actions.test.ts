jest.mock('obsidian', () => ({
    ...jest.requireActual('../__mocks__/obsidian'),
    MarkdownView: class {},
    Menu: class {},
    normalizePath: (path: string) => path.replace(/\\/g, '/'),
    Notice: class {
        messageEl = mockMakeEl();
        hide = jest.fn();
        constructor(public message: string | DocumentFragment, public timeout?: number) {
            mockNotices.push(this);
        }
    }
}));
jest.mock('../modals/ai-confirm-send-modal', () => ({
    AiConfirmSendModal: class {
        open = jest.fn();
        constructor(
            _app: unknown,
            public run: unknown,
            public onConfirm: (dontAskAgain: boolean) => void,
            public options: { forced?: boolean } = {}
        ) {
            mockConfirms.push(this);
        }
    }
}));
jest.mock('./ai-result-view', () => ({ openAiResultView: jest.fn(async () => undefined) }));
jest.mock('../ai/prompt-runner', () => ({ prepareNotePromptRun: jest.fn() }));

import { TFile } from 'obsidian';
import type HighlightCommentsPlugin from '../../main';
import type { PromptPreset } from '../ai/types';
import { i18n } from '../i18n';
import { prepareNotePromptRun } from '../ai/prompt-runner';
import { openAiResultView } from './ai-result-view';
import { createGeneratedDocument, runNotePrompt } from './note-ai-actions';

interface MockEl {
    setText: jest.Mock<any, any>;
    addEventListener: jest.Mock<any, any>;
    disabled: boolean;
    createDiv: jest.Mock<any, any>;
    createEl: jest.Mock<any, any>;
}

/** The working notice writes into `messageEl`, which the shared mock lacks. */
function mockMakeEl(): MockEl {
    return {
        setText: jest.fn(),
        addEventListener: jest.fn(),
        disabled: false,
        createDiv: jest.fn(() => mockMakeEl()),
        createEl: jest.fn(() => mockMakeEl())
    };
}

const mockNotices: Array<{ message: string | DocumentFragment }> = [];
const mockConfirms: Array<{ options: { forced?: boolean }; onConfirm: (dontAskAgain: boolean) => void }> = [];

beforeAll(async () => { await i18n.init(); });
// Module-level, so one test's notices would otherwise be another's evidence.
beforeEach(() => {
    mockNotices.length = 0;
    mockConfirms.length = 0;
    (openAiResultView as jest.Mock).mockClear();
});

const prompt = { name: 'Long summary', outputTarget: 'new-markdown' } as PromptPreset;
const source = Object.assign(new TFile(), {
    path: 'notes/source.md', basename: 'source', parent: { path: 'notes' }
});

interface PluginContext {
    plugin: HighlightCommentsPlugin;
    create: jest.Mock;
    openFile: jest.Mock;
    created: TFile;
}

function makePlugin(options: { existing?: string[]; createdPath?: string } = {}): PluginContext {
    const existing = new Set(options.existing ?? []);
    const created = Object.assign(new TFile(), {
        path: options.createdPath ?? 'notes/source - Long summary.md'
    });
    const create = jest.fn(async () => created);
    const openFile = jest.fn(async () => undefined);
    const plugin = {
        settings: { ai: { confirmBeforeSend: false } },
        aiService: { checkReadiness: () => null, canStream: () => true, stream: jest.fn() },
        recordAiUsage: jest.fn(),
        app: {
            vault: {
                getAbstractFileByPath: (path: string) => existing.has(path) ? {} : null,
                create
            },
            workspace: { getLeaf: () => ({ openFile }) }
        }
    } as unknown as HighlightCommentsPlugin;
    return { plugin, create, openFile, created };
}

describe('runNotePrompt', () => {
    async function run(chunkCount: number): Promise<PluginContext> {
        const ctx = makePlugin();
        (prepareNotePromptRun as jest.Mock).mockResolvedValue({
            prompt,
            file: source,
            profile: {},
            chunkCount,
            messages: [{ role: 'user', content: 'part 1' }],
            messageBatches: Array.from({ length: chunkCount }, () => [{ role: 'user', content: 'part' }])
        });
        await runNotePrompt(ctx.plugin, prompt, source);
        return ctx;
    }

    it('confirms a run of many requests even though "don\'t ask again" was set', async () => {
        // makePlugin's settings already have confirmBeforeSend off.
        await run(10);
        expect(mockConfirms).toHaveLength(1);
        expect(mockConfirms[0].options).toEqual({ forced: true });
        // Nothing runs until it is confirmed.
        expect(openAiResultView).not.toHaveBeenCalled();
    });

    it('leaves a run below the threshold alone', async () => {
        await run(9);
        expect(mockConfirms).toHaveLength(0);
        expect(openAiResultView).toHaveBeenCalledTimes(1);
    });

    it('sends a document prompt to the panel with both save actions and no note write', async () => {
        await run(1);
        const run1 = (openAiResultView as jest.Mock).mock.calls[0][1];
        expect(typeof run1.actions.createDocument).toBe('function');
        expect(run1.actions.preferredFormat).toBe('md');
        // The answer belongs in its own document, not in the note it came from.
        expect(run1.actions.onInsert).toBeUndefined();
        // A chunked answer's per-part fences matter once it becomes a file.
        expect(typeof run1.joinParts).toBe('function');
    });

    it('gives a preview prompt the note-write action instead', async () => {
        const preview = { name: 'Ask', outputTarget: 'preview' } as PromptPreset;
        const ctx = makePlugin();
        (prepareNotePromptRun as jest.Mock).mockResolvedValue({
            prompt: preview, file: source, profile: {}, chunkCount: 1, messages: []
        });
        await runNotePrompt(ctx.plugin, preview, source);

        const started = (openAiResultView as jest.Mock).mock.calls[0][1];
        expect(typeof started.actions.onInsert).toBe('function');
        expect(started.actions.createDocument).toBeUndefined();
        expect(started.joinParts).toBeUndefined();
    });
});

describe('createGeneratedDocument', () => {
    it('writes Markdown beside the note and opens it', async () => {
        const ctx = makePlugin();
        const file = await createGeneratedDocument(ctx.plugin, prompt, source, 'md', '# Result');

        expect(ctx.create).toHaveBeenCalledWith('notes/source - Long summary.md', '# Result\n');
        expect(ctx.openFile).toHaveBeenCalledWith(ctx.created);
        expect(file).toBe(ctx.created);
    });

    it('numbers the file past an existing result', async () => {
        const ctx = makePlugin({
            existing: ['notes/source - Long summary.md'],
            createdPath: 'notes/source - Long summary 2.md'
        });
        await createGeneratedDocument(ctx.plugin, prompt, source, 'md', '# Result');

        expect(ctx.create).toHaveBeenCalledWith('notes/source - Long summary 2.md', '# Result\n');
    });

    it('strips a code fence the model wrapped the whole answer in', async () => {
        const ctx = makePlugin();
        await createGeneratedDocument(ctx.plugin, prompt, source, 'md', '```md\n# Result\n```');

        expect(ctx.create.mock.calls[0][1]).toBe('# Result\n');
    });

    it('wraps an HTML fragment in a complete UTF-8 document, and does not open it', async () => {
        const ctx = makePlugin({ createdPath: 'notes/source - Long summary.html' });
        await createGeneratedDocument(ctx.plugin, prompt, source, 'html', '<h1>Result</h1>');

        const content = ctx.create.mock.calls[0][1] as string;
        expect(content).toContain('<!doctype html>');
        expect(content).toContain('<meta charset="utf-8">');
        expect(content).toContain('<main>\n<h1>Result</h1>\n</main>');
        // Obsidian has no view for .html, so a tab on one would watch nothing.
        expect(ctx.openFile).not.toHaveBeenCalled();
    });

    it('writes nothing when there is no answer to keep', async () => {
        const ctx = makePlugin();
        const file = await createGeneratedDocument(ctx.plugin, prompt, source, 'md', '   ');

        expect(ctx.create).not.toHaveBeenCalled();
        expect(file).toBeNull();
        expect(mockNotices.map(notice => notice.message)).toContain(i18n.t('ai.run.emptyAnswer'));
    });
});
