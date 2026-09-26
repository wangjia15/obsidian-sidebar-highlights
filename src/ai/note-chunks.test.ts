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

describe('chapter boundaries', () => {
    it('keeps a complete chapter even when a later subheading fits the window', () => {
        const one = '# One\n' + 'a'.repeat(25) + '\n\n';
        const two = '# Two\nintro\n\n## Detail\n' + 'b'.repeat(35);
        expect(splitNoteIntoChunks(one + two, 65)).toEqual([one, two]);
    });

    it('packs several complete chapters when they fit', () => {
        const chapters = ['# A\naaaaa\n\n', '# B\nbbbbb\n\n', '# C\nccccc'];
        expect(splitNoteIntoChunks(chapters.join(''), 24)).toEqual([chapters[0] + chapters[1], chapters[2]]);
    });

    it('descends through heading levels only inside an oversized chapter', () => {
        const intro = '# One\nintro\n\n';
        const a = '## A\n' + 'a'.repeat(25) + '\n\n';
        const b = '## B\n' + 'b'.repeat(20) + '\n\n';
        const c = '### C\n' + 'c'.repeat(25) + '\n\n';
        const next = '# Two\nend';
        expect(splitNoteIntoChunks(intro + a + b + c + next, 50)).toEqual([intro + a, b, c, next]);
    });

    it('uses paragraphs before hard cuts in an oversized section', () => {
        const first = '# A\nshort\n\n';
        const second = 'b'.repeat(25) + '\n\n';
        const third = 'c'.repeat(25);
        expect(splitNoteIntoChunks(first + second + third, 30)).toEqual([first, second, third]);
    });

    it('retains legacy boundaries for a plain note without headings', () => {
        expect(splitNoteIntoChunks('aaaa\n\nbbbb\n\ncccc\n\ndddd', 12)).toEqual(['aaaa\n\nbbbb\n', '\ncccc\n\ndddd']);
        expect(splitNoteIntoChunks('abcd\nefgh\nijkl\nmnop', 10)).toEqual(['abcd\nefgh\n', 'ijkl\nmnop']);
    });

    it('never splits frontmatter, even when it exceeds the limit', () => {
        const frontmatter = '---\n# not a heading\nvalue: ' + 'x'.repeat(40) + '\n---\n';
        const body = '# Body\n' + 'b'.repeat(30);
        expect(splitNoteIntoChunks(frontmatter + body, 35)).toEqual([frontmatter, body.slice(0, 35), body.slice(35)]);
    });

    it.each(['```', '~~~~'])('keeps %s fences atomic and ignores headings and blank lines inside', fence => {
        const before = '# A\ntext\n\n';
        const code = fence + 'ts\n# fake\n\n' + 'x'.repeat(40) + '\n' + fence + '\n';
        const after = '# B\nend';
        expect(splitNoteIntoChunks(before + code + after, 30)).toEqual([before, code, after]);
    });

    it('protects an unclosed fence through the end of the note', () => {
        const before = '# A\ntext\n\n';
        const code = '```\n# fake\n' + 'x'.repeat(50);
        expect(splitNoteIntoChunks(before + code, 30)).toEqual([before, code]);
    });

    it('preserves CRLF and ignores shorter or mismatched closing fences', () => {
        const before = '# A\r\ntext\r\n\r\n';
        const code = '````js\r\n```\r\n~~~\r\n# fake\r\n' + 'x'.repeat(40) + '\r\n````\r\n';
        const after = '# B\r\nend';
        expect(splitNoteIntoChunks(before + code + after, 30)).toEqual([before, code, after]);
    });
});

it('keeps atomic regions intact even without real headings', () => {
    const frontmatter = '---\n# fake\n' + 'x'.repeat(20) + '\n---\n';
    const code = '```\n## fake\n\n' + 'y'.repeat(20) + '\n```\n';
    const note = frontmatter + code + 'tail';
    const chunks = splitNoteIntoChunks(note, 15);
    expect(chunks).toEqual([frontmatter, code, 'tail']);
    expect(chunks.join('')).toBe(note);
});

it('uses the highest level actually present and recognizes indented ATX headings', () => {
    const one = '  ### One\n' + 'a'.repeat(15) + '\n\n';
    const two = '### Two\nintro\n\n#### Detail\n' + 'b'.repeat(15);
    expect(splitNoteIntoChunks(one + two, 50)).toEqual([one, two]);
});

it('preserves a surrogate pair even when the requested limit is one', () => {
    expect(splitNoteIntoChunks('a😀b', 1)).toEqual(['a', '😀', 'b']);
});
