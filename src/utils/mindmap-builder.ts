import { App, TFile, WorkspaceLeaf } from 'obsidian';

type Result<T = unknown> = { ok: true; data: T } | { ok: false; error: { message: string } };
interface BuilderAPI {
    ready(): boolean;
    setView(view: unknown): Result;
    getMindMapRoots(): Result<{ rootIds: string[] }>;
    refreshMapLayout(nodeId: string): Promise<Result>;
}
interface DrawingView {
    file?: TFile;
    containerEl: HTMLElement;
    reload(full: boolean, file: TFile): Promise<boolean>;
    save(): Promise<void>;
}
interface ExcalidrawPlugin {
    scriptEngine?: {
        executeScript(view: unknown, source: string, name: string, file: TFile): Promise<void>;
    };
}

// The script exposes one mutable view context, so layouts must run serially.
let pending: Promise<void> = Promise.resolve();

/**
 * Re-runs the Excalidraw Mindmap Builder layout over a drawing we just wrote.
 *
 * Cosmetic by design, so it never rejects. The drawing on disk is already
 * correct by the time this runs; a missing script, a builder API that did not
 * come up, or a reload that failed must not turn a finished export into a
 * reported failure — its callers report the write, not the layout.
 */
export function rearrangeMindmap(app: App, file: TFile): Promise<void> {
    const next = pending.catch(() => undefined).then(async () => {
        try {
            await rearrange(app, file);
        } catch (error) {
            console.warn('Sidebar Highlights: could not re-lay out the mindmap:', error);
        }
    });
    pending = next;
    return next;
}

async function rearrange(app: App, file: TFile): Promise<void> {
    const plugin = (app as App & {
        plugins?: { getPlugin(id: string): ExcalidrawPlugin | undefined };
    }).plugins?.getPlugin('obsidian-excalidraw-plugin');
    if (!plugin?.scriptEngine) return;
    const script = app.vault.getAbstractFileByPath('Excalidraw/Scripts/Downloaded/Mindmap Builder.md')
        ?? app.vault.getMarkdownFiles().find(candidate => candidate.basename === 'Mindmap Builder');
    if (!(script instanceof TFile)) return;

    // The layout needs a live Excalidraw view, so one is opened when the drawing
    // is not already on screen. A pane we opened is ours to close again: this
    // also runs on auto-sync, while the user is typing in some other note, and
    // splitting their workspace to do bookkeeping is not what they asked for.
    const open: WorkspaceLeaf | undefined = app.workspace.getLeavesOfType('excalidraw')
        .find(candidate => (candidate.view as unknown as DrawingView).file?.path === file.path);
    const leaf = open ?? app.workspace.getLeaf('split', 'vertical');
    if (!open) {
        await leaf.setViewState({ type: 'excalidraw', state: { file: file.path }, active: false });
    }

    try {
        const view = leaf.view as unknown as DrawingView;
        if (typeof view.reload !== 'function' || !await view.reload(true, file)) {
            throw new Error('Mindmap Builder: failed to reload drawing');
        }
        const host = view.containerEl.ownerDocument.defaultView as (Window & { MindMapBuilderAPI?: BuilderAPI }) | null;
        let api = host?.MindMapBuilderAPI;
        if (!api?.ready()) {
            await plugin.scriptEngine.executeScript(view, await app.vault.read(script), 'Mindmap Builder', script);
            api = host?.MindMapBuilderAPI;
        }
        if (!api?.ready()) throw new Error('Mindmap Builder API is not ready');
        const check = <T>(result: Result<T>): T => {
            if (!result.ok) throw new Error(`Mindmap Builder: ${result.error.message}`);
            return result.data;
        };
        check(api.setView(view));
        for (const root of check(api.getMindMapRoots()).rootIds) {
            check(await api.refreshMapLayout(root));
        }
        await view.save();
    } finally {
        if (!open) leaf.detach();
    }
}
