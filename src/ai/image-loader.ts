import { App, TFile, arrayBufferToBase64, requestUrl } from 'obsidian';
import { t } from '../i18n';
import { imageDisplayName, imageMimeType, isRemoteUrl, isVisionMimeType, type ImageEmbed } from '../utils/image-embed';
import type { AiImage } from './types';

/**
 * Longest edge sent to a model. Vision APIs downscale anything larger on their
 * side anyway (Anthropic to ~1568px), so sending more only costs upload time
 * and request size — and very large photos exceed per-image byte limits.
 */
const MAX_EDGE = 1568;
/** Images under this size and edge are sent untouched. */
const MAX_UNTOUCHED_BYTES = 1.5 * 1024 * 1024;

/** Resolves an embed to the vault file it points at, if it is a local one. */
export function resolveImageFile(app: App, embed: ImageEmbed, sourcePath: string): TFile | null {
    if (isRemoteUrl(embed.target)) return null;
    const file = app.metadataCache.getFirstLinkpathDest(embed.target, sourcePath)
        ?? app.vault.getAbstractFileByPath(embed.target);
    return file instanceof TFile ? file : null;
}

/** A URL an `<img>` in the sidebar can display. */
export function imageDisplayUrl(app: App, embed: ImageEmbed, sourcePath: string): string | null {
    if (isRemoteUrl(embed.target)) return embed.target;
    const file = resolveImageFile(app, embed, sourcePath);
    return file ? app.vault.getResourcePath(file) : null;
}

/**
 * Loads the image an image highlight points at, ready to attach to a request.
 * Throws a user-readable Error when it cannot be sent.
 */
export async function loadImageForAi(app: App, embed: ImageEmbed, sourcePath: string): Promise<AiImage> {
    const name = imageDisplayName(embed);
    let bytes: ArrayBuffer;
    let mimeType: string | undefined;

    if (isRemoteUrl(embed.target)) {
        const response = await requestUrl({ url: embed.target, throw: false });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(t('ai.image.loadFailed', { name }));
        }
        bytes = response.arrayBuffer;
        const header = Object.entries(response.headers ?? {})
            .find(([key]) => key.toLowerCase() === 'content-type')?.[1];
        mimeType = header?.split(';')[0].trim().toLowerCase() || imageMimeType(embed.target);
    } else {
        const file = resolveImageFile(app, embed, sourcePath);
        if (!file) throw new Error(t('ai.image.notFound', { name }));
        bytes = await app.vault.readBinary(file);
        mimeType = imageMimeType(file.path);
    }

    if (!mimeType || !mimeType.startsWith('image/')) {
        throw new Error(t('ai.image.unsupported', { name }));
    }

    // Re-encoding also converts formats vision APIs refuse (SVG, BMP, AVIF).
    const needsReencode = !isVisionMimeType(mimeType) || bytes.byteLength > MAX_UNTOUCHED_BYTES;
    if (needsReencode || await longestEdge(bytes, mimeType) > MAX_EDGE) {
        const reencoded = await reencode(bytes, mimeType);
        if (reencoded) return { mimeType: 'image/jpeg', data: arrayBufferToBase64(reencoded), name };
        if (!isVisionMimeType(mimeType)) throw new Error(t('ai.image.unsupported', { name }));
    }

    return { mimeType, data: arrayBufferToBase64(bytes), name };
}

function loadElement(bytes: ArrayBuffer, mimeType: string): Promise<HTMLImageElement> {
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode failed'));
        img.src = url;
    }).finally(() => URL.revokeObjectURL(url));
}

async function longestEdge(bytes: ArrayBuffer, mimeType: string): Promise<number> {
    try {
        const img = await loadElement(bytes, mimeType);
        return Math.max(img.naturalWidth, img.naturalHeight);
    } catch {
        return 0;
    }
}

/** Downscales to MAX_EDGE and encodes as JPEG, or returns null if the platform cannot. */
async function reencode(bytes: ArrayBuffer, mimeType: string): Promise<ArrayBuffer | null> {
    try {
        const img = await loadElement(bytes, mimeType);
        const width = img.naturalWidth || 1024;
        const height = img.naturalHeight || 1024;
        const scale = Math.min(1, MAX_EDGE / Math.max(width, height));

        const canvas = createEl('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d');
        if (!context) return null;
        // JPEG has no alpha; a transparent diagram would otherwise turn black.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);

        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        return blob ? await blob.arrayBuffer() : null;
    } catch {
        return null;
    }
}
