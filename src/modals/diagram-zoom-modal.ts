import { App, Modal, Notice, setIcon } from 'obsidian';
import { t } from '../i18n';

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;

/**
 * Full-screen view of one diagram.
 *
 * The sidebar is narrow by nature, so anything with more than a few nodes is
 * unreadable inline. This is the escape hatch: the same SVG, as large as the
 * window allows, with zoom and pan.
 */
export class DiagramZoomModal extends Modal {
    private scale = 1;
    private offsetX = 0;
    private offsetY = 0;
    private dragging = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private stageEl!: HTMLElement;
    private canvasEl!: HTMLElement;
    private onMouseMove: ((event: MouseEvent) => void) | null = null;
    private onMouseUp: (() => void) | null = null;

    constructor(
        app: App,
        private readonly svg: SVGElement,
        private readonly source: string
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass('sh-diagram-modal');
        contentEl.empty();

        this.renderToolbar(contentEl);

        this.stageEl = contentEl.createDiv({ cls: 'sh-diagram-stage' });
        this.canvasEl = this.stageEl.createDiv({ cls: 'sh-diagram-canvas' });

        // A clone: the original is still on screen in the sidebar behind this
        // modal, and moving it would empty that card.
        const copy = this.svg.cloneNode(true) as SVGElement;
        this.sizeToIntrinsic(copy);
        this.canvasEl.appendChild(copy);

        this.applyTransform();
        this.registerInteractions();
    }

    /**
     * Pins the clone to an explicit pixel size.
     *
     * Mermaid emits `width="100%"` with a `max-width` style, so the SVG sizes
     * itself against its parent. Dropped into a bare div that has no width of
     * its own, 100% resolves to zero and the diagram collapses to nothing —
     * which is exactly what a blank zoom modal is. The viewBox carries the
     * drawing's real dimensions, so that is what we size against; the rendered
     * rect is the fallback, and it is only a fallback because the diagram in
     * the sidebar is clipped by `max-height`.
     */
    private sizeToIntrinsic(copy: SVGElement): void {
        const viewBox = (this.svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).filter(Boolean);
        const rect = this.svg.getBoundingClientRect();

        let width = Number(viewBox[2]);
        let height = Number(viewBox[3]);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            width = rect.width;
            height = rect.height;
        }
        if (!(width > 0) || !(height > 0)) return; // Nothing reliable to go on.

        copy.setAttribute('width', String(width));
        copy.setAttribute('height', String(height));
        // The source SVG carries its own inline max-width from mermaid, which
        // would re-clamp the clone inside the stage; the stylesheet cannot
        // outrank an inline style, so it is cleared here.
        copy.setCssStyles({
            width: `${width}px`,
            height: `${height}px`,
            maxWidth: 'none',
            maxHeight: 'none'
        });
    }

    private renderToolbar(containerEl: HTMLElement): void {
        const bar = containerEl.createDiv({ cls: 'sh-diagram-toolbar' });

        this.addButton(bar, 'zoom-in', t('modals.diagramZoom.zoomIn'), () => this.zoomBy(1.25));
        this.addButton(bar, 'zoom-out', t('modals.diagramZoom.zoomOut'), () => this.zoomBy(0.8));
        this.addButton(bar, 'maximize', t('modals.diagramZoom.reset'), () => this.reset());

        bar.createDiv({ cls: 'sh-diagram-toolbar-spacer' });

        this.addButton(bar, 'code', t('modals.diagramZoom.copySource'), () => {
            void this.copy(this.source, t('modals.diagramZoom.copiedSource'));
        });
        this.addButton(bar, 'image', t('modals.diagramZoom.copySvg'), () => {
            void this.copy(new XMLSerializer().serializeToString(this.svg), t('modals.diagramZoom.copiedSvg'));
        });
    }

    private addButton(bar: HTMLElement, icon: string, label: string, onClick: () => void): void {
        const button = bar.createEl('button', { cls: 'sh-diagram-tool', attr: { 'aria-label': label } });
        setIcon(button, icon);
        button.addEventListener('click', onClick);
    }

    private registerInteractions(): void {
        this.stageEl.addEventListener('wheel', event => {
            event.preventDefault();
            // Anchor the zoom on the pointer so the diagram grows around what
            // the user is looking at rather than around its own centre.
            const rect = this.stageEl.getBoundingClientRect();
            const pointerX = event.clientX - rect.left - rect.width / 2;
            const pointerY = event.clientY - rect.top - rect.height / 2;
            this.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, pointerX, pointerY);
        }, { passive: false });

        this.stageEl.addEventListener('mousedown', event => {
            this.dragging = true;
            this.dragStartX = event.clientX - this.offsetX;
            this.dragStartY = event.clientY - this.offsetY;
            this.stageEl.addClass('is-dragging');
        });

        // On the window, not the stage: a drag that leaves the diagram should
        // keep panning, and releasing outside must still end it. Modal is not
        // a Component, so these come off by hand in onClose.
        this.onMouseMove = (event: MouseEvent) => {
            if (!this.dragging) return;
            this.offsetX = event.clientX - this.dragStartX;
            this.offsetY = event.clientY - this.dragStartY;
            this.applyTransform();
        };
        this.onMouseUp = () => {
            this.dragging = false;
            this.stageEl.removeClass('is-dragging');
        };
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);

        this.scope.register([], '0', () => { this.reset(); return false; });
    }

    private zoomBy(factor: number, pointerX = 0, pointerY = 0): void {
        const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
        const applied = next / this.scale;
        this.scale = next;
        this.offsetX = pointerX + (this.offsetX - pointerX) * applied;
        this.offsetY = pointerY + (this.offsetY - pointerY) * applied;
        this.applyTransform();
    }

    private reset(): void {
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this.applyTransform();
    }

    private applyTransform(): void {
        this.canvasEl.style.transform =
            `translate(${this.offsetX}px, ${this.offsetY}px) scale(${this.scale})`;
    }

    private async copy(text: string, success: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            new Notice(success);
        } catch {
            new Notice(t('modals.diagramZoom.copyFailed'));
        }
    }

    onClose(): void {
        if (this.onMouseMove) window.removeEventListener('mousemove', this.onMouseMove);
        if (this.onMouseUp) window.removeEventListener('mouseup', this.onMouseUp);
        this.onMouseMove = null;
        this.onMouseUp = null;
        this.contentEl.empty();
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
