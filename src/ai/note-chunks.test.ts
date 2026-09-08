import { splitNoteIntoChunks } from './note-chunks';

describe('splitNoteIntoChunks', () => {
    it('leaves a short note in one request', () => {
        expect(splitNoteIntoChunks('short', 20)).toEqual(['short']);
    });

    it('preserves every character while preferring headings and paragraphs', () => {
        const note = '# One\n\n' + 'a'.repeat(30) + '\n\n## Two\n\n' + 'b'.repeat(30);
        const chunks = splitNoteIntoChunks(note, 45);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.join('')).toBe(note);
        expect(chunks[1]).toMatch(/^## Two|^\n## Two/);
        expect(chunks.every(chunk => chunk.length <= 45)).toBe(true);
    });

    it('hard-splits a long paragraph without breaking a surrogate pair', () => {
        const note = `${'x'.repeat(9)}😀${'y'.repeat(20)}`;
        const chunks = splitNoteIntoChunks(note, 10);
        expect(chunks.join('')).toBe(note);
        expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
        expect(chunks.every(chunk => chunk.length <= 10)).toBe(true);
    });
});
