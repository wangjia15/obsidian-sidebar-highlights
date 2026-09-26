import { MarkdownView, Menu, Notice, TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type HighlightCommentsPlugin from '../../main';
import type { Highlight } from '../../main';
import { t } from '../i18n';
import { findImageEmbeds, imageMimeType, isImageHighlightText, isRemoteUrl, type ImageEmbedMatch } from '../utils/image-embed';
import { addAiMenuItems, aiAvailable } from './ai-actions';

/** How long after a right-click its target is still taken to be what the menu is for. */
const TARGET_TTL_MS = 1500;

/**
 * Right-click menu entries for images rendered in a note.
 *
 * Obsidian opens its own menu for an embedded image and announces it through
 * `file-menu` (source `link-context-menu`) for a vault image, or `url-menu`
 * for a remote one. Neither says *which* embed was clicked, so the element
 * under the last right-click is remembered and mapped back to its offset in
 * the note; with no position to go on, the first embed of that image is used.
 */
export function registerImageContextMenu(plugin: HighlightCommentsPlugin): void {
    let lastTarget: { el: HTMLElement; at: number } | null = null;

    plugin.registerDomEvent(document, 'contextmenu', event => {
        const el = event.target instanceof HTMLElement ? event.target : null;
        lastTarget = el ? { el, at: Date.now() } : null;
    }, { capture: true });

    const clickedImage = (): HTMLElement | null => {
        if (!lastTarget || Date.now() - lastTarget.at > TARGET_TTL_MS) return null;
        const { el } = lastTarget;
        if (el.tagName === 'IMG') return el;
        return el.closest<HTMLElement>('.internal-embed, .image-embed');
    };

    plugin.registerEvent(plugin.app.workspace.on('file-menu', (menu, file, source) => {
        if (source !== 'link-context-menu' || !(file instanceof TFile) || !imageMimeType(file.path)) return;
        const imageEl = clickedImage();
        if (!imageEl) return;
        addImageItems(plugin, menu, imageEl, (match, notePath) =>
            !isRemoteUrl(match.embed.target)
            && plugin.app.metadataCache.getFirstLinkpathDest(match.embed.target, notePath)?.path === file.path);
    }));

    plugin.registerEvent(plugin.app.workspace.on('url-menu', (menu, url) => {
        const imageEl = clickedImage();
        if (!imageEl || imageEl.tagName !== 'IMG') return;
        addImageItems(plugin, menu, imageEl, match => match.embed.target === url);
    }));
}

function addImageItems(
    plugin: HighlightCommentsPlugin,
    menu: Menu,
    imageEl: HTMLElement,
    isTarget: (match: ImageEmbedMatch, notePath: string) => boolean
): void {
    const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const note = view?.file;
    if (!view || !note || !view.containerEl.contains(imageEl)) return;

    const content = view.getViewData();
    const candidates = findImageEmbeds(content).filter(match => isTarget(match, note.path));
    if (candidates.length === 0) return;

    const match = nearest(candidates, offsetOf(view, imageEl));
    const highlight = match.highlighted ? findHighlightFor(plugin, note.path, match) : null;

    menu.addSeparator();
    if (!match.highlighted) {
        menu.addItem(item => item
            .setTitle(t('contextMenu.highlightImage'))
            .setIcon('highlighter')
            .onClick(() => { void wrapImage(plugin, view, note, content, match); }));
        return;
    }

    if (highlight && aiAvailable(plugin)) {
        addAiMenuItems(menu, plugin, highlight);
    }
}

/** The document offset of a rendered element, when the editor can tell. */
function offsetOf(view: MarkdownView, el: HTMLElement): number | null {
    if (view.getMode() !== 'source') return null;
    const cm = (view.editor as unknown as { cm?: EditorView }).cm;
    if (!cm) return null;
    try {
        return cm.posAtDOM(el);
    } catch {
        return null;
    }
}

function nearest(candidates: ImageEmbedMatch[], offset: number | null): ImageEmbedMatch {
    if (offset === null) return candidates[0];
    return candidates.reduce((best, match) =>
        distance(match, offset) < distance(best, offset) ? match : best);
}

function distance(match: ImageEmbedMatch, offset: number): number {
    if (offset >= match.from && offset <= match.to) return 0;
    return Math.min(Math.abs(offset - match.from), Math.abs(offset - match.to));
}

function findHighlightFor(plugin: HighlightCommentsPlugin, notePath: string, match: ImageEmbedMatch): Highlight | null {
    const highlights = plugin.highlights.get(notePath) ?? [];
    return highlights.find(highlight =>
        isImageHighlightText(highlight.text)
        && highlight.startOffset <= match.from
        && highlight.endOffset >= match.to) ?? null;
}

/** Wraps the embed in `==…==`, through the editor when the note is being edited. */
async function wrapImage(
    plugin: HighlightCommentsPlugin,
    view: MarkdownView,
    note: TFile,
    snapshot: string,
    match: ImageEmbedMatch
): Promise<void> {
    const embedText = snapshot.slice(match.from, match.to);

    if (view.getMode() === 'source') {
        const editor = view.editor;
        if (editor.getValue().slice(match.from, match.to) !== embedText) {
            new Notice(t('notices.noImageAtCursor'));
            return;
        }
        editor.replaceRange(`==${embedText}==`, editor.offsetToPos(match.from), editor.offsetToPos(match.to));
        plugin.detectAndStoreMarkdownHighlights(editor.getValue(), note);
    } else {
        let changed = false;
        const updated = await plugin.app.vault.process(note, content => {
            if (content.slice(match.from, match.to) !== embedText) return content;
            changed = true;
            return `${content.slice(0, match.from)}==${embedText}==${content.slice(match.to)}`;
        });
        if (!changed) {
            new Notice(t('notices.noImageAtCursor'));
            return;
        }
        plugin.detectAndStoreMarkdownHighlights(updated, note);
    }
    new Notice(t('notices.highlightCreated'));
}
