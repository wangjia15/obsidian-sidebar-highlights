import { App, TFile } from 'obsidian';
import { rearrangeMindmap } from './mindmap-builder';

it('reloads the target drawing, loads the installed script, then rearranges and saves its roots', async () => {
    const file = Object.assign(new TFile(), { path: 'map.excalidraw.md' });
    const script = Object.assign(new TFile(), { path: 'Excalidraw/Scripts/Downloaded/Mindmap Builder.md' });
    const calls: string[] = [];
    const host: { MindMapBuilderAPI?: unknown } = {};
    const view = {
        file, containerEl: { ownerDocument: { defaultView: host } },
        reload: jest.fn(async () => { calls.push('reload'); return true; }),
        save: jest.fn(async () => { calls.push('save'); })
    };
    const setView = jest.fn(() => ({ ok: true }));
    const api = {
        ready: () => true, setView,
        getMindMapRoots: () => ({ ok: true, data: { rootIds: ['root'] } }),
        refreshMapLayout: jest.fn(async () => { calls.push('layout'); return { ok: true }; })
    };
    const executeScript = jest.fn(async () => { calls.push('script'); host.MindMapBuilderAPI = api; });
    const detach = jest.fn();
    const app = {
        plugins: { getPlugin: () => ({ scriptEngine: { executeScript } }) },
        workspace: { getLeavesOfType: () => [{ view, detach }] },
        vault: { getAbstractFileByPath: () => script, read: async () => 'script source' }
    } as unknown as App;
    await rearrangeMindmap(app, file);
    expect(calls).toEqual(['reload', 'script', 'layout', 'save']);
    expect(view.reload).toHaveBeenCalledWith(true, file);
    expect(executeScript).toHaveBeenCalledWith(view, 'script source', 'Mindmap Builder', script);
    expect(setView).toHaveBeenCalledWith(view);
    expect(api.refreshMapLayout).toHaveBeenCalledWith('root');
    // The drawing was already on screen, so the pane is the user's, not ours.
    expect(detach).not.toHaveBeenCalled();
});

it('closes the pane it had to open, so an auto-sync leaves no split behind', async () => {
    const file = Object.assign(new TFile(), { path: 'map.excalidraw.md' });
    const script = Object.assign(new TFile(), { path: 'Mindmap Builder.md' });
    const host = {
        MindMapBuilderAPI: {
            ready: () => true,
            setView: () => ({ ok: true }),
            getMindMapRoots: () => ({ ok: true, data: { rootIds: ['root'] } }),
            refreshMapLayout: async () => ({ ok: true })
        }
    };
    const view = {
        file,
        containerEl: { ownerDocument: { defaultView: host } },
        reload: jest.fn(async () => true),
        save: jest.fn(async () => undefined)
    };
    const opened = { view, setViewState: jest.fn(async () => undefined), detach: jest.fn() };
    const app = {
        plugins: { getPlugin: () => ({ scriptEngine: { executeScript: jest.fn() } }) },
        workspace: { getLeavesOfType: () => [], getLeaf: () => opened },
        vault: { getAbstractFileByPath: () => script, read: async () => 'script source' }
    } as unknown as App;

    await rearrangeMindmap(app, file);
    expect(opened.setViewState).toHaveBeenCalled();
    expect(view.save).toHaveBeenCalled();
    expect(opened.detach).toHaveBeenCalledTimes(1);
});

it('keeps a layout failure to itself: the drawing on disk is already correct', async () => {
    const file = Object.assign(new TFile(), { path: 'map.excalidraw.md' });
    const script = Object.assign(new TFile(), { path: 'Mindmap Builder.md' });
    const view = {
        file,
        // The script never defines its API here, so the layout cannot run.
        containerEl: { ownerDocument: { defaultView: {} } },
        reload: jest.fn(async () => true),
        save: jest.fn(async () => undefined)
    };
    const detach = jest.fn();
    const app = {
        plugins: { getPlugin: () => ({ scriptEngine: { executeScript: jest.fn(async () => undefined) } }) },
        workspace: { getLeavesOfType: () => [], getLeaf: () => ({ view, setViewState: jest.fn(async () => undefined), detach }) },
        vault: { getAbstractFileByPath: () => script, read: async () => 'script source' }
    } as unknown as App;

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
        // Resolves rather than rejecting: the caller reports the write it made,
        // and a failed re-layout must not turn that into a reported failure.
        await expect(rearrangeMindmap(app, file)).resolves.toBeUndefined();
        expect(view.save).not.toHaveBeenCalled();
        expect(detach).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalled();
    } finally {
        warn.mockRestore();
    }
});
