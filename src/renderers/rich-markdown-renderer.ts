/**
 * Two-level comment rendering.
 *
 * The sidebar's own `renderMarkdownToElement` is fast, produces flat text
 * nodes the search highlighter can walk, and covers what almost every comment
 * contains: bold, italic, code spans, links. It cannot do block constructs —
 * fenced code, tables, lists, quotes — and therefore cannot do mermaid.
 *
 * So this module does not replace it. `needsRichRender` picks which of the two
 * a comment gets, and only comments that actually contain a block construct
 * pay for Obsidian's full markdown pipeline.
 */

import { Component, MarkdownRenderChild, MarkdownRenderer, setIcon } from 'obsidian';
import type { App } from 'obsidian';

/**
 * Line-anchored probe for block-level markdown.
 *
 * Deliberately cheap and slightly eager: a false positive costs one comment a
 * heavier render, while a false negative renders a table as a row of pipes.
 */
const BLOCK_HINT = /^[ \t]{0,3}(```|~~~|#{1,6}\s|>\s|[-*+]\s|\d+[.)]\s|\||\$\$)/m;

export function needsRichRender(text: string): boolean {
    return BLOCK_HINT.test(text);
}

/** Opening line of a fenced block, capturing indent, fence and info string. */
const FENCE_OPEN = /^([ \t]*)(```+|~~~+)[ \t]*([^\s`]*)/;

/**
 * The source of every mermaid fence in the text, in document order.
 *
 * Kept so a diagram that fails to render can be put back as the code the user
 * wrote, rather than as an empty box or an error dump.
 */
export function extractMermaidSources(text: string): string[] {
    const lines = text.split('\n').map(line => line.replace(/\r$/, ''));
    const sources: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const open = FENCE_OPEN.exec(lines[i]);
        if (!open || open[3].toLowerCase() !== 'mermaid') continue;

        const [, indent, fence] = open;
        const body: string[] = [];
        let j = i + 1;
        while (j < lines.length && !isFenceClose(lines[j], fence)) {
            body.push(stripIndent(lines[j], indent));
            j++;
        }

        sources.push(body.join('\n'));
        i = j;
    }

    return sources;
}

function isFenceClose(line: string, fence: string): boolean {
    const marker = fence[0];
    const closer = new RegExp(`^[ \\t]*${marker === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
    return closer.test(line);
}

function stripIndent(line: string, indent: string): string {
    return line.startsWith(indent) ? line.slice(indent.length) : line;
}

/**
 * Subtrees the search highlighter must not descend into.
 *
 * Wrapping a `<span>` around matching text inside an SVG breaks the drawing,
 * and inside code it corrupts what is meant to be verbatim.
 */
const OPAQUE_TO_SEARCH = 'svg, pre, code, math, .mermaid, .math, .sh-diagram';

export function isSearchOpaque(node: Node): boolean {
    const element = node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    return element?.closest(OPAQUE_TO_SEARCH) != null;
}

export interface RichRenderOptions {
    sourcePath: string;
    renderMermaid: boolean;
    maxDiagramHeight: number;
    /** Opens the full-screen view for one diagram. */
    onZoom?: (svg: SVGElement, source: string) => void;
    /** Text for the badge shown when a diagram fails to render. */
    diagramErrorLabel: string;
    /** Tooltip on a diagram that can be opened larger. */
    zoomLabel: string;
    /**
     * Renders at once instead of waiting for the element to scroll into view.
     *
     * Lazy rendering pays for itself in the sidebar, where a vault can put
     * hundreds of cards on one list. In a modal showing a single answer it buys
     * nothing and only adds a way to end up blank, so that caller opts out.
     */
    immediate?: boolean;
}

/**
 * Renders comments that need the full markdown pipeline, and owns everything
 * that has to be torn down afterwards.
 *
 * One instance per sidebar view. Rendering is deferred until the card scrolls
 * into view: a vault with hundreds of highlights would otherwise run Obsidian's
 * renderer hundreds of times to fill one screen.
 */
export class RichCommentRenderer {
    private readonly children = new Set<MarkdownRenderChild>();
    private readonly pending = new Map<HTMLElement, () => void>();
    private observer: IntersectionObserver | null = null;

    constructor(
        private readonly app: App,
        private readonly owner: Component
    ) {}

    /**
     * Renders `text` into `el` once it is on screen.
     *
     * The element keeps an estimated height while it waits, so filling in the
     * real content does not shove the rest of the list around.
     */
    render(el: HTMLElement, text: string, options: RichRenderOptions): void {
        el.addClass('sh-rich-comment');
        el.addClass('is-pending');
        el.style.setProperty('--sh-rich-estimated-height', `${estimateHeight(text)}px`);

        const run = () => {
            this.pending.delete(el);
            el.removeClass('is-pending');
            el.style.removeProperty('--sh-rich-estimated-height');
            void this.renderNow(el, text, options);
        };

        this.pending.set(el, run);

        if (options.immediate) {
            run();
            return;
        }

        this.watch(el);
    }

    private watch(el: HTMLElement): void {
        // No IntersectionObserver means no lazy rendering — render immediately
        // rather than leaving the comment blank forever.
        if (typeof IntersectionObserver === 'undefined') {
            this.pending.get(el)?.();
            return;
        }

        this.observer ??= new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const target = entry.target as HTMLElement;
                this.observer?.unobserve(target);
                this.pending.get(target)?.();
            }
        }, { rootMargin: '200px' });

        this.observer.observe(el);
    }

    private async renderNow(el: HTMLElement, text: string, options: RichRenderOptions): Promise<void> {
        el.empty();

        const child = new MarkdownRenderChild(el);
        this.owner.addChild(child);
        this.children.add(child);

        try {
            await MarkdownRenderer.render(this.app, text, el, options.sourcePath, child);
        } catch {
            // A render failure must not leave the comment blank: fall back to
            // the source, which is at least readable and copyable.
            showSource(el, text);
            return;
        }

        // Rendering can also "succeed" and produce nothing — a post-processor
        // that silently bailed, or an element detached mid-render. Showing the
        // source beats showing an empty box the user cannot act on.
        if (el.childElementCount === 0 && !el.textContent?.trim()) {
            showSource(el, text);
            return;
        }

        this.blockInternalClicks(el);

        if (options.renderMermaid) {
            this.supervise(el, extractMermaidSources(text), options);
        }
    }

    /**
     * Keeps a click inside the rendered content from reaching the comment's own
     * click handler, which navigates to the note. Following a link or opening a
     * diagram should not also jump the editor somewhere else.
     */
    private blockInternalClicks(el: HTMLElement): void {
        el.addEventListener('click', event => {
            const target = event.target as Element | null;
            if (target?.closest('a, input, button, svg, .sh-diagram')) {
                event.stopPropagation();
            }
        });
    }

    /**
     * Watches the diagrams in one comment.
     *
     * Obsidian renders mermaid asynchronously and a syntax error surfaces as an
     * error node rather than a rejected promise, so the outcome has to be
     * observed rather than awaited. Checks run twice: once for the common fast
     * case, once as a backstop for a slow first render.
     */
    private supervise(el: HTMLElement, sources: string[], options: RichRenderOptions): void {
        // The source is pinned onto each node up front rather than looked up by
        // position on each pass: degrading a diagram takes it out of the
        // `.mermaid` set, which would shift every later index onto the wrong
        // source.
        el.querySelectorAll<HTMLElement>('.mermaid').forEach((node, index) => {
            node.dataset.shDiagramSource = sources[index] ?? '';
        });

        const check = () => {
            if (!el.isConnected) return;
            el.querySelectorAll<HTMLElement>('[data-sh-diagram-source]').forEach(node => {
                if (node.hasClass('sh-diagram-settled')) return;

                const source = node.dataset.shDiagramSource ?? '';
                const svg = node.querySelector('svg');

                if (svg && !isErrorDiagram(node, svg)) {
                    node.addClass('sh-diagram-settled');
                    this.decorateDiagram(node, svg, source, options);
                    return;
                }

                if (svg || node.textContent?.trim()) {
                    // Rendered into something, and that something is an error.
                    node.addClass('sh-diagram-settled');
                    degradeDiagram(node, source || (node.textContent ?? ''), options.diagramErrorLabel);
                }
            });
        };

        window.setTimeout(check, 300);
        window.setTimeout(check, 1500);
    }

    private decorateDiagram(
        node: HTMLElement,
        svg: SVGElement,
        source: string,
        options: RichRenderOptions
    ): void {
        node.addClass('sh-diagram');
        node.style.setProperty('--sh-diagram-max-height', `${options.maxDiagramHeight}px`);

        if (!options.onZoom) return;

        node.setAttribute('aria-label', options.zoomLabel);
        node.addEventListener('click', event => {
            event.stopPropagation();
            options.onZoom?.(svg, source);
        });
    }

    /** Unloads renders whose element is no longer in the document. */
    releaseDetached(): void {
        for (const child of this.children) {
            if (child.containerEl.isConnected) continue;
            this.owner.removeChild(child);
            this.children.delete(child);
        }
        for (const el of [...this.pending.keys()]) {
            if (el.isConnected) continue;
            this.observer?.unobserve(el);
            this.pending.delete(el);
        }
    }

    dispose(): void {
        for (const child of this.children) {
            this.owner.removeChild(child);
        }
        this.children.clear();
        this.pending.clear();
        this.observer?.disconnect();
        this.observer = null;
    }
}

/**
 * Whether what mermaid produced is its error graphic rather than a diagram.
 * Mermaid draws syntax errors as a real SVG, so the presence of one proves
 * nothing on its own.
 */
function isErrorDiagram(node: HTMLElement, svg: SVGElement): boolean {
    if (svg.querySelector('.error-icon, .error-text')) return true;
    return /^\s*(syntax error|parse error|error:)/i.test(node.textContent ?? '');
}

/**
 * Replaces a failed diagram with its source.
 *
 * One bad diagram must never take the rest of the comment with it, and showing
 * the source is what lets the user see the typo and fix it.
 */
/** Last resort for any path that would otherwise leave the reader a blank box. */
function showSource(el: HTMLElement, text: string): void {
    el.empty();
    el.createEl('pre').createEl('code', { text });
}

function degradeDiagram(node: HTMLElement, source: string, label: string): void {
    node.empty();
    node.removeClass('mermaid');
    node.addClass('sh-diagram-fallback');

    const badge = node.createDiv({ cls: 'sh-diagram-error' });
    setIcon(badge.createSpan({ cls: 'sh-diagram-error-icon' }), 'alert-triangle');
    badge.createSpan({ text: label });

    node.createEl('pre').createEl('code', { text: source.trim() });
}

/**
 * Rough height for the placeholder, so lazily rendered comments do not make
 * the list jump as the user scrolls past them.
 */
function estimateHeight(text: string): number {
    const lines = text.split('\n').length;
    return Math.min(320, Math.max(40, lines * 22));
}
