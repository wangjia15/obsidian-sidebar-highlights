interface Range { start: number; end: number }
interface Heading { offset: number; level: number }

/**
 * Preserve complete chapters, descending into subheadings only for oversized
 * chapters. Frontmatter and fenced code are atomic and may exceed the limit.
 * Plain notes retain the original paragraph/line splitting behavior.
 */
export function splitNoteIntoChunks(text: string, requestedLimit: number): string[] {
    if (text === '') return [''];
    const limit = Math.max(1, Math.floor(requestedLimit));
    if (text.length <= limit) return [text];
    const { headings, protectedRanges } = scanNote(text);
    const safe = (offset: number) => !protectedRanges.some(range => range.start < offset && offset < range.end);

    function splitParagraphs(start: number, end: number): string[] {
        const chunks: string[] = [];
        while (start < end) {
            let cut = Math.min(end, start + limit);
            if (cut === end) {
                chunks.push(text.slice(start, end));
                break;
            }
            const window = text.slice(start, cut);
            const minimum = headings.length ? start : start + Math.floor(limit * 0.45);
            const paragraphs = Array.from(window.matchAll(/\n\s*\n/g), match => start + (match.index ?? 0) + (headings.length ? match[0].length : 1))
                .filter(offset => offset > start && offset >= minimum && safe(offset));
            const lines = headings.length ? [] : Array.from(window.matchAll(/\n/g), match => start + (match.index ?? 0) + 1)
                .filter(offset => offset >= minimum && safe(offset));
            const atomic = protectedRanges.find(range => range.start < cut && cut < range.end);
            cut = atomic ? (atomic.start > start ? atomic.start : atomic.end)
                : paragraphs.pop() ?? lines.pop() ?? cut;
            const region = protectedRanges.find(range => range.start < cut && cut < range.end);
            if (region) cut = region.start > start ? region.start : region.end;
            // Move a hard cut away from a surrogate pair. At limit 1 the pair
            // must exceed the limit rather than being corrupted.
            const last = text.charCodeAt(cut - 1);
            const next = text.charCodeAt(cut);
            if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
                cut = cut - 1 > start ? cut - 1 : cut + 1;
            }
            chunks.push(text.slice(start, cut));
            start = cut;
        }
        return chunks;
    }

    function splitSection(start: number, end: number): string[] {
        if (end - start <= limit) return [text.slice(start, end)];
        const inside = headings.filter(heading => heading.offset > start && heading.offset < end);
        if (!inside.length) return splitParagraphs(start, end);
        const level = inside.reduce((minimum, heading) => Math.min(minimum, heading.level), 6);
        const boundaries = [start, ...inside.filter(heading => heading.level === level).map(heading => heading.offset), end];
        const chunks: string[] = [];
        let pending = '';
        for (let i = 0; i < boundaries.length - 1; i++) {
            const from = boundaries[i];
            const to = boundaries[i + 1];
            if (to - from > limit) {
                if (pending) chunks.push(pending);
                pending = '';
                chunks.push(...splitSection(from, to));
            } else {
                const section = text.slice(from, to);
                if (pending.length + section.length > limit) {
                    chunks.push(pending);
                    pending = '';
                }
                pending += section;
            }
        }
        if (pending) chunks.push(pending);
        return chunks;
    }

    return splitSection(0, text.length);
}

/** Scan once, retaining original offsets (including CRLF) for lossless slices. */
function scanNote(text: string): { headings: Heading[]; protectedRanges: Range[] } {
    const headings: Heading[] = [];
    const protectedRanges: Range[] = [];
    let frontmatter = false;
    let fence: { marker: string; length: number; start: number } | undefined;
    for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
        if (!match[0]) continue;
        const offset = match.index ?? 0;
        const end = offset + match[0].length;
        const line = match[0].replace(/\r?\n$/, '');
        if (offset === 0 && line.trim() === '---') {
            frontmatter = true;
            continue;
        }
        if (frontmatter) {
            if (/^(---|\.\.\.)\s*$/.test(line.trim())) {
                protectedRanges.push({ start: 0, end });
                frontmatter = false;
            }
            continue;
        }
        if (fence) {
            const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
            if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
                protectedRanges.push({ start: fence.start, end });
                fence = undefined;
            }
            continue;
        }
        const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
            fence = { marker: opening[1][0], length: opening[1].length, start: offset };
            continue;
        }
        const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line);
        if (heading) headings.push({ offset, level: heading[1].length });
    }
    if (frontmatter) protectedRanges.push({ start: 0, end: text.length });
    if (fence) protectedRanges.push({ start: fence.start, end: text.length });
    return { headings, protectedRanges };
}
