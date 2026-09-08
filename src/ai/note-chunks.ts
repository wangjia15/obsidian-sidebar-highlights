/**
 * Splits a note into provider-sized requests without dropping any source text.
 * Headings and paragraph boundaries are preferred so a chunk starts at a useful
 * semantic boundary; hard cuts are only used for an unusually long paragraph.
 */
export function splitNoteIntoChunks(text: string, requestedLimit: number): string[] {
    if (text === '') return [''];
    const limit = Math.max(1, Math.floor(requestedLimit));
    if (text.length <= limit) return [text];

    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(text.length, start + limit);
        if (end === text.length) {
            chunks.push(text.slice(start));
            break;
        }

        const minimum = start + Math.floor(limit * 0.45);
        const window = text.slice(start, end);
        const candidates = [
            lastBoundary(window, /\n(?=#{1,6}\s)/g),
            lastBoundary(window, /\n\s*\n/g),
            window.lastIndexOf('\n') + 1
        ].filter(cut => cut > 0 && start + cut >= minimum);
        let cut = candidates[0] ?? limit;

        // Never leave a lone UTF-16 high surrogate at the end of a chunk.
        const lastCode = text.charCodeAt(start + cut - 1);
        if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut--;
        if (cut <= 0) cut = limit;

        chunks.push(text.slice(start, start + cut));
        start += cut;
    }
    return chunks;
}

function lastBoundary(text: string, pattern: RegExp): number {
    let result = 0;
    for (const match of text.matchAll(pattern)) result = (match.index ?? 0) + 1;
    return result;
}
