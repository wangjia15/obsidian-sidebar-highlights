import { replaceSection } from './note-section';

describe('replaceSection', () => {
    it('appends a new section at the end of the note', () => {
        expect(replaceSection('Body text.', 'Summary', '- one\n- two'))
            .toBe('Body text.\n\n## Summary\n\n- one\n- two\n');
    });

    it('creates the section in an empty note', () => {
        expect(replaceSection('', 'Summary', 'text')).toBe('## Summary\n\ntext\n');
    });

    it('replaces the section it wrote before, rather than adding a second', () => {
        const first = replaceSection('Body.', 'Summary', 'old answer');
        const second = replaceSection(first, 'Summary', 'new answer');
        expect(second).toBe('Body.\n\n## Summary\n\nnew answer\n');
    });

    it('is stable: replacing produces exactly what creating did', () => {
        const created = replaceSection('Body.', 'Summary', 'answer');
        expect(replaceSection(created, 'Summary', 'answer')).toBe(created);
    });

    it('keeps the sections that follow the one it replaces', () => {
        const content = '## Summary\n\nold\n\n## Notes\n\nkeep me';
        expect(replaceSection(content, 'Summary', 'new'))
            .toBe('## Summary\n\nnew\n\n## Notes\n\nkeep me\n');
    });

    it('keeps subsections nested under the section it replaces out of the way', () => {
        // A deeper heading belongs to the section and is replaced with it.
        const content = '## Summary\n\nold\n\n### Detail\n\nalso old\n\n# Top\n\nkeep me';
        expect(replaceSection(content, 'Summary', 'new'))
            .toBe('## Summary\n\nnew\n\n# Top\n\nkeep me\n');
    });

    it('leaves frontmatter alone', () => {
        const content = '---\ntitle: Note\n---\n\nBody.';
        expect(replaceSection(content, 'Summary', 'text'))
            .toBe('---\ntitle: Note\n---\n\nBody.\n\n## Summary\n\ntext\n');
    });

    it('does not treat a frontmatter key as a heading', () => {
        const content = '---\nSummary: not a heading\n---\n\nBody.';
        expect(replaceSection(content, 'Summary', 'text')).toContain('## Summary');
        expect(replaceSection(content, 'Summary', 'text')).toContain('Summary: not a heading');
    });

    it('goes above the note\'s footnote definitions, not after them', () => {
        const content = 'Body ==quote==[^1].\n\n[^1]: a comment';
        expect(replaceSection(content, 'Summary', 'text'))
            .toBe('Body ==quote==[^1].\n\n## Summary\n\ntext\n\n[^1]: a comment\n');
    });

    it('never swallows a comment added after the section was written', () => {
        // The comment writer appends definitions at the very end, which would
        // land inside the section if the section owned everything below it.
        const withSection = replaceSection('Body ==quote==.', 'Summary', 'first');
        const withComment = `${withSection.replace(/\s+$/, '')}\n\n[^1]: a comment\n`;
        const rerun = replaceSection(withComment, 'Summary', 'second');
        expect(rerun).toContain('[^1]: a comment');
        expect(rerun).toContain('second');
        expect(rerun).not.toContain('first');
    });

    it('keeps a multi-line footnote definition intact', () => {
        const content = 'Body.\n\n[^1]: first line\n    second line';
        const result = replaceSection(content, 'Summary', 'text');
        expect(result).toContain('[^1]: first line\n    second line');
        expect(result.indexOf('## Summary')).toBeLessThan(result.indexOf('[^1]:'));
    });

    it('matches an existing heading whatever its level', () => {
        const content = '### Summary\n\nold';
        expect(replaceSection(content, 'Summary', 'new')).toBe('### Summary\n\nnew\n');
    });

    it('writes a multi-line body verbatim', () => {
        const body = '- one\n- two\n\nA closing line.';
        expect(replaceSection('Body.', 'Notes', body))
            .toBe(`Body.\n\n## Notes\n\n${body}\n`);
    });

    it('leaves the note untouched for an empty body', () => {
        expect(replaceSection('Body.', 'Summary', '   \n  ')).toBe('Body.');
    });

    it('normalizes the gap rather than accumulating blank lines', () => {
        const content = 'Body.\n\n\n\n';
        expect(replaceSection(content, 'Summary', 'text')).toBe('Body.\n\n## Summary\n\ntext\n');
    });
});
