jest.mock('obsidian', () => ({
    ...jest.requireActual('../__mocks__/obsidian'),
    MarkdownView: class { file: unknown; editor: unknown; getMode() { return 'source'; } }
}));
jest.mock('../modals/ai-confirm-send-modal', () => ({ AiConfirmSendModal: class {} }));
jest.mock('./ai-result-view', () => ({ openAiResultView: jest.fn(async () => undefined) }));

import { MarkdownView, TFile } from 'obsidian';
import type HighlightCommentsPlugin from '../../main';
import type { Highlight } from '../../main';
import { insertAiComment } from './ai-actions';
import { i18n } from '../i18n';
beforeAll(async () => { await i18n.init(); });

it.each(['closed', 'preview', 'background-editor'])('writes to the captured note with a %s target after focus changes', async mode => {
    const file = Object.assign(new TFile(), { path: 'original.md' });
    let content = '==original highlight==';
    const target = Object.create(MarkdownView.prototype) as MarkdownView;
    target.file = file;
    target.getMode = () => mode === 'preview' ? 'preview' : 'source';
    target.editor = {
        getValue: () => content,
        offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
        replaceRange: (text: string, from: { ch: number }, to: { ch: number }) => {
            content = content.slice(0, from.ch) + text + content.slice(to.ch);
        }
    } as unknown as MarkdownView['editor'];
    const process = jest.fn(async (_file: TFile, transform: (text: string) => string) => { content = transform(content); return content; });
    const detectAndStoreMarkdownHighlights = jest.fn();
    const plugin = {
        detectAndStoreMarkdownHighlights,
        settings: { useInlineFootnotes: true },
        app: {
            workspace: {
                getActiveFile: () => ({ path: 'different.md' }),
                getLeavesOfType: () => mode === 'closed' ? [] : [{ view: target }]
            },
            vault: { getAbstractFileByPath: () => file, process }
        }
    } as unknown as HighlightCommentsPlugin;
    const highlight = { filePath: file.path, text: 'original highlight', startOffset: 0 } as Highlight;
    expect(await insertAiComment(plugin, highlight, 'AI answer', { quiet: true })).toBe(true);
    expect(content).toBe('==original highlight==^[AI answer]');
    expect(process).toHaveBeenCalledTimes(mode === 'background-editor' ? 0 : 1);
    // The card picks the comment up at once, not on the next debounced rescan.
    expect(detectAndStoreMarkdownHighlights).toHaveBeenCalledWith('==original highlight==^[AI answer]', file);
});
