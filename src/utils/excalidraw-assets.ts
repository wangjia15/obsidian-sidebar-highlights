/**
 * The app-side half of drawing images and LaTeX in a mind map: finding the
 * image a note refers to, learning how big it is, and asking the Excalidraw
 * plugin how big a formula renders.
 *
 * Those sizes are only available asynchronously, but the scene builder is
 * synchronous. So the builder runs once against what is known, this object
 * records what it asked for and could not get, `measure()` fetches exactly
 * that, and the builder runs again. Two passes at most.
 */

import { App, TFile } from 'obsidian';
import { FormulaSize, IMAGE_FALLBACK_SIZE, ImageAsset, RichAssets } from './excalidraw-rich';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const LOAD_TIMEOUT_MS = 4000;

interface ExcalidrawAutomateLike {
    tex2dataURL?: (tex: string) => Promise<{ size?: { width: number; height: number } } | null>;
}

export class RichAssetResolver implements RichAssets {
    private readonly formulaSizes = new Map<string, FormulaSize | null>();
    private readonly imageSizes = new Map<string, FormulaSize>();
    private readonly missingFormulas = new Set<string>();
    private readonly missingImages = new Map<string, string>();

    constructor(private readonly app: App) {}

    image(target: string, notePath: string | undefined): ImageAsset | null {
        const external = /^(?:https?|file):\/\//i.test(target);
        let link: string;
        let source: string;

        if (external) {
            link = source = target;
        } else {
            const file = this.resolveFile(target, notePath);
            if (!file) return null;
            link = file.path;
            source = this.app.vault.getResourcePath(file);
        }

        const size = this.imageSizes.get(link);
        if (!size && !this.missingImages.has(link)) this.missingImages.set(link, source);
        const { width, height } = size ?? IMAGE_FALLBACK_SIZE;
        return { link, external, width, height };
    }

    formula(formula: string): FormulaSize | null {
        if (this.formulaSizes.has(formula)) return this.formulaSizes.get(formula) ?? null;
        this.missingFormulas.add(formula);
        return null;
    }

    /** Fetch whatever the last pass could not know. True when a rebuild would come out different. */
    async measure(): Promise<boolean> {
        const formulas = [...this.missingFormulas];
        const images = [...this.missingImages];
        this.missingFormulas.clear();
        this.missingImages.clear();

        await Promise.all([
            ...formulas.map(async formula => {
                this.formulaSizes.set(formula, await this.measureFormula(formula));
            }),
            ...images.map(async ([link, source]) => {
                this.imageSizes.set(link, await measureImage(source));
            })
        ]);

        return formulas.some(formula => this.formulaSizes.get(formula) !== null)
            || images.some(([link]) => this.imageSizes.get(link) !== IMAGE_FALLBACK_SIZE);
    }

    private resolveFile(target: string, notePath: string | undefined): TFile | null {
        let linkpath = target.split('#')[0].trim();
        try {
            linkpath = decodeURIComponent(linkpath);
        } catch {
            // A stray `%` is a literal one.
        }
        if (!linkpath) return null;

        const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, notePath ?? '');
        return file && IMAGE_EXTENSIONS.has(file.extension.toLowerCase()) ? file : null;
    }

    private async measureFormula(formula: string): Promise<FormulaSize | null> {
        // MathJax lives in the Excalidraw plugin; without it formulas are sized by estimate.
        const automate = (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomateLike }).ExcalidrawAutomate;
        if (typeof automate?.tex2dataURL !== 'function') return null;

        try {
            const rendered = await withTimeout(automate.tex2dataURL(formula), LOAD_TIMEOUT_MS);
            const size = rendered?.size;
            return size && size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : null;
        } catch {
            return null;
        }
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise(resolve => {
        const timer = window.setTimeout(() => resolve(null), ms);
        promise.then(
            value => { window.clearTimeout(timer); resolve(value); },
            () => { window.clearTimeout(timer); resolve(null); }
        );
    });
}

function measureImage(source: string): Promise<FormulaSize> {
    return new Promise(resolve => {
        const image = new Image();
        const timer = window.setTimeout(() => resolve(IMAGE_FALLBACK_SIZE), LOAD_TIMEOUT_MS);
        image.onload = () => {
            window.clearTimeout(timer);
            resolve(image.naturalWidth > 0 && image.naturalHeight > 0
                ? { width: image.naturalWidth, height: image.naturalHeight }
                : IMAGE_FALLBACK_SIZE);
        };
        image.onerror = () => {
            window.clearTimeout(timer);
            resolve(IMAGE_FALLBACK_SIZE);
        };
        image.src = source;
    });
}
