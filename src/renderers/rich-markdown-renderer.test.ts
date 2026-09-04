/**
 * @jest-environment jsdom
 */

import { extractMermaidSources, isSearchOpaque, needsRichRender } from './rich-markdown-renderer';

describe('needsRichRender', () => {
    it.each([
        ['fenced code', '```mermaid\ngraph TD; A-->B;\n```'],
        ['tilde fence', '~~~js\nconst a = 1;\n~~~'],
        ['heading', '# Title'],
        ['deep heading', '###### Title'],
        ['quote', '> quoted'],
        ['dash list', '- one\n- two'],
        ['star list', '* one'],
        ['plus list', '+ one'],
        ['ordered list', '1. first'],
        ['paren-ordered list', '1) first'],
        ['table', '| a | b |\n| --- | --- |'],
        ['math block', '$$\nx = 1\n$$'],
        ['block after a paragraph', 'Here is the structure:\n\n```mermaid\ngraph TD;\n```'],
        ['indented fence', '   ```\ncode\n```']
    ])('detects %s', (_label, text) => {
        expect(needsRichRender(text)).toBe(true);
    });

    it.each([
        ['plain prose', 'A perfectly ordinary comment.'],
        ['inline code', 'Use `npm run build` to compile.'],
        ['emphasis', '*emphasis* and **bold** and ~~struck~~'],
        ['a hyphen mid-sentence', 'well - actually, no'],
        ['a link', 'See [the docs](https://example.com) for more.'],
        ['a wikilink', 'Related: [[Another note]]'],
        ['a decimal number', 'It grew 1.5 times larger.'],
        ['a pipe mid-line', 'a | b in prose'],
        ['inline math', 'The value $x = 1$ holds.'],
        ['empty', '']
    ])('leaves %s on the fast path', (_label, text) => {
        expect(needsRichRender(text)).toBe(false);
    });

    it('does not treat over-indented text as a fence', () => {
        // Four spaces is an indented code block in markdown, but the flat
        // renderer has always shown it as text and this is not the milestone
        // that changes that.
        expect(needsRichRender('    ```')).toBe(false);
    });
});

describe('extractMermaidSources', () => {
    it('returns nothing when there is no mermaid', () => {
        expect(extractMermaidSources('```js\nconst a = 1;\n```')).toEqual([]);
    });

    it('reads one fence', () => {
        expect(extractMermaidSources('intro\n\n```mermaid\ngraph TD;\n  A-->B;\n```'))
            .toEqual(['graph TD;\n  A-->B;']);
    });

    it('reads several fences in document order', () => {
        const text = '```mermaid\nfirst\n```\ntext\n```mermaid\nsecond\n```';
        expect(extractMermaidSources(text)).toEqual(['first', 'second']);
    });

    it('ignores other languages between mermaid fences', () => {
        const text = '```js\nskipped\n```\n```mermaid\nkept\n```';
        expect(extractMermaidSources(text)).toEqual(['kept']);
    });

    it('handles tilde fences', () => {
        expect(extractMermaidSources('~~~mermaid\ngraph TD;\n~~~')).toEqual(['graph TD;']);
    });

    it('strips the fence indentation from the source', () => {
        // Footnote continuations arrive indented; the diagram source must not.
        const text = '  ```mermaid\n  graph TD;\n  ```';
        expect(extractMermaidSources(text)).toEqual(['graph TD;']);
    });

    it('reads a fence that is never closed', () => {
        expect(extractMermaidSources('```mermaid\ngraph TD;')).toEqual(['graph TD;']);
    });

    it('is not confused by an info string with attributes', () => {
        expect(extractMermaidSources('```mermaid\nA\n```')).toEqual(['A']);
        expect(extractMermaidSources('```mermaidjs\nA\n```')).toEqual([]);
    });

    it('normalizes CRLF sources', () => {
        expect(extractMermaidSources('```mermaid\r\ngraph TD;\r\n```')).toEqual(['graph TD;']);
    });
});

describe('isSearchOpaque', () => {
    function textIn(html: string): Node {
        const host = document.createElement('div');
        host.innerHTML = html;
        document.body.appendChild(host);
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
        return walker.nextNode()!;
    }

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('allows plain text', () => {
        expect(isSearchOpaque(textIn('<p>plain</p>'))).toBe(false);
    });

    it.each([
        ['code', '<code>code</code>'],
        ['pre', '<pre>preformatted</pre>'],
        ['a mermaid container', '<div class="mermaid">graph</div>'],
        ['a diagram wrapper', '<div class="sh-diagram"><span>label</span></div>']
    ])('shields %s', (_label, html) => {
        expect(isSearchOpaque(textIn(html))).toBe(true);
    });

    it('shields text nested deep inside an opaque subtree', () => {
        expect(isSearchOpaque(textIn('<pre><code><span>nested</span></code></pre>'))).toBe(true);
    });

    it('does not shield a sibling of an opaque element', () => {
        const host = document.createElement('div');
        host.innerHTML = '<pre>code</pre><p>prose</p>';
        document.body.appendChild(host);
        const prose = host.querySelector('p')!.firstChild!;
        expect(isSearchOpaque(prose)).toBe(false);
    });
});
