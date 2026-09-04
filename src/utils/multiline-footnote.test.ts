import { extractFootnoteDefinitions, locateFootnoteDefinition, removeFootnoteDefinition } from './footnote-parser';

/**
 * Compatibility suite for the single-line footnote behavior the old
 * `/^\[\^(\w+)\]:\s*(.+)$/gm` parser had, locked in before the multi-line
 * rewrite. These must not change: existing vaults depend on them.
 */
describe('single-line definitions (legacy behavior)', () => {
    it('locks the old parser output for a representative note', () => {
        const note = [
            '[^1]: hello world',
            '[^two_2]:x no space',
            '[^3]:    padded',
            '[^1]: last duplicate wins',
            '  [^4]: indented definition is ignored',
            '[^empty]:   '
        ].join('\n');

        expect([...extractFootnoteDefinitions(note)]).toMatchInlineSnapshot(`
[
  [
    "1",
    "last duplicate wins",
  ],
  [
    "two_2",
    "x no space",
  ],
  [
    "3",
    "padded",
  ],
]
`);
    });

    it('reads a plain definition', () => {
        expect(extractFootnoteDefinitions('[^1]: hello world').get('1')).toBe('hello world');
    });

    it('works without a space after the colon', () => {
        expect(extractFootnoteDefinitions('[^1]:x no space').get('1')).toBe('x no space');
    });

    it('strips padding after the colon', () => {
        expect(extractFootnoteDefinitions('[^1]:    lots of padding').get('1')).toBe('lots of padding');
    });

    it('reads word-character keys', () => {
        expect(extractFootnoteDefinitions('[^note_2]: with underscore').get('note_2')).toBe('with underscore');
    });

    it('keeps the last definition for duplicate keys', () => {
        expect(extractFootnoteDefinitions('[^1]: first\n[^1]: second').get('1')).toBe('second');
    });

    it('does not treat an indented line as a definition start', () => {
        expect(extractFootnoteDefinitions('  [^1]: indented start').has('1')).toBe(false);
    });

    it('does not absorb a following body paragraph', () => {
        const content = '[^1]: the note\nA body paragraph.';
        expect(extractFootnoteDefinitions(content).get('1')).toBe('the note');
    });

    it('reads CRLF notes without leaking carriage returns', () => {
        const map = extractFootnoteDefinitions('[^1]: a\r\n[^2]: b\r\n');
        expect(map.get('1')).toBe('a');
        expect(map.get('2')).toBe('b');
    });
});

describe('multi-line definitions', () => {
    it('joins 4-space continuation lines with newlines', () => {
        const content = '[^1]: first\n    second';
        expect(extractFootnoteDefinitions(content).get('1')).toBe('first\nsecond');
    });

    it('accepts tab-indented continuation lines', () => {
        const content = '[^1]: first\n\tsecond';
        expect(extractFootnoteDefinitions(content).get('1')).toBe('first\nsecond');
    });

    it('strips only the shared four-space indent', () => {
        // 8 spaces is a code block inside the footnote; the wrapper indent
        // goes, the code indent stays.
        const content = '[^1]: intro\n        code line';
        expect(extractFootnoteDefinitions(content).get('1')).toBe('intro\n    code line');
    });

    it('absorbs a blank line between indented paragraphs', () => {
        const content = '[^1]: para one\n\n    para two';
        expect(extractFootnoteDefinitions(content).get('1')).toBe('para one\n\npara two');
    });

    it('does not absorb trailing blank lines', () => {
        const content = '[^1]: first\n    second\n\nBody text.';
        expect(extractFootnoteDefinitions(content).get('1')).toBe('first\nsecond');
    });

    it('ends the definition at a blank line followed by body text', () => {
        const content = '[^1]: para one\n\nBody text.';
        expect(extractFootnoteDefinitions(content).get('1')).toBe('para one');
    });

    it('does not treat a lazily unindented second line as a continuation', () => {
        const content = '[^1]: first\nsecond';
        expect(extractFootnoteDefinitions(content).get('1')).toBe('first');
    });

    it('captures a fenced code block in the continuation', () => {
        const content = '[^1]: diagram\n    ```mermaid\n    graph TD; A-->B;\n    ```';
        expect(extractFootnoteDefinitions(content).get('1'))
            .toBe('diagram\n```mermaid\ngraph TD; A-->B;\n```');
    });

    it('reads two adjacent multi-line definitions separately', () => {
        const content = '[^1]: one\n    more one\n[^2]: two\n    more two';
        const map = extractFootnoteDefinitions(content);
        expect(map.get('1')).toBe('one\nmore one');
        expect(map.get('2')).toBe('two\nmore two');
    });

    it('reads keys containing dashes', () => {
        expect(extractFootnoteDefinitions('[^a-b]: dashed').get('a-b')).toBe('dashed');
    });

    it('normalizes CRLF continuations to LF in the stored content', () => {
        const content = '[^1]: first\r\n    second\r\n';
        expect(extractFootnoteDefinitions(content).get('1')).toBe('first\nsecond');
    });

    it('treats an empty first line as no definition at all', () => {
        // The old parser absorbed the next line as content here, attributing a
        // random paragraph to the footnote. Not carrying that over.
        expect(extractFootnoteDefinitions('[^1]:\nBody paragraph.').has('1')).toBe(false);
    });
});

describe('removeFootnoteDefinition', () => {
    it('removes a definition with its continuation lines', () => {
        const content = 'para\n\n[^1]: first\n    second\n\nanother para';
        expect(removeFootnoteDefinition(content, '1')).toBe('para\n\nanother para');
    });

    it('removes continuation paragraphs around blank lines', () => {
        const content = '[^1]: para one\n\n    para two\n\nbody';
        expect(removeFootnoteDefinition(content, '1')).toBe('body');
    });

    it('leaves other definitions and body text alone', () => {
        const content = '[^1]: keep me\n[^2]: gone\n    gone too';
        expect(removeFootnoteDefinition(content, '2')).toBe('[^1]: keep me');
    });

    it('leaves the content unchanged for an unknown key', () => {
        const content = '[^1]: stay';
        expect(removeFootnoteDefinition(content, '2')).toBe(content);
    });

    it('removes a definition that ends the file', () => {
        expect(removeFootnoteDefinition('para\n\n[^1]: gone', '1')).toBe('para\n');
    });

    it('handles CRLF notes', () => {
        expect(removeFootnoteDefinition('para\r\n\r\n[^1]: gone\r\n    also\r\n', '1'))
            .toBe('para\r\n\r\n');
    });
});

describe('locateFootnoteDefinition', () => {
    it('spans the whole definition, continuation lines included', () => {
        const content = 'body\n\n[^1]: first\n    second\n';
        const found = locateFootnoteDefinition(content, '1');
        expect(found).not.toBeNull();
        expect(content.slice(found!.start, found!.end)).toBe('[^1]: first\n    second');
        expect(content.slice(found!.contentStart, found!.contentEnd)).toBe('first\n    second');
    });

    it('starts the content after the colon padding', () => {
        const content = '[^1]:    padded';
        const found = locateFootnoteDefinition(content, '1');
        expect(content.slice(found!.contentStart, found!.contentEnd)).toBe('padded');
    });

    it('stops before the next definition', () => {
        const content = '[^1]: one\n[^2]: two';
        const found = locateFootnoteDefinition(content, '1');
        expect(content.slice(found!.start, found!.end)).toBe('[^1]: one');
    });

    it('keeps offsets right in a CRLF note', () => {
        const content = 'body\r\n\r\n[^1]: first\r\n    second\r\n';
        const found = locateFootnoteDefinition(content, '1');
        expect(content.slice(found!.start, found!.end)).toBe('[^1]: first\r\n    second');
    });

    it('returns null for an unknown key', () => {
        expect(locateFootnoteDefinition('[^1]: only', '2')).toBeNull();
    });
});
