import { buildExcalidrawMindmapFile, buildMindmapScene, buildMindmapTree, type ExcalidrawElement, type RichAssets } from './excalidraw-mindmap';
import { buildInlineFormula, fitImage, parseRichBlocks } from './excalidraw-rich';

const assets: RichAssets = {
    image: (target, notePath) => target === 'missing.png'
        ? null
        : { link: `${notePath?.replace(/[^/]*$/, '') ?? ''}images/${target}`, width: 800, height: 400 },
    formula: () => ({ width: 100, height: 30 })
};

const sceneFor = (text: string, comments: string[] = []) => {
    const tree = buildMindmapTree([{
        title: 'Note', path: 'a/Note.md', headings: [],
        highlights: [{ text, comments, line: 1, color: '#ffec99' }]
    }])!;
    return buildMindmapScene(tree, { assets, updated: 1 });
};

describe('parseRichBlocks', () => {
    it('leaves plain prose as one text block', () => {
        expect(parseRichBlocks('just   some\nwords')).toEqual([{ type: 'text', text: 'just some words' }]);
    });

    it('reads display math, single- and multi-line', () => {
        expect(parseRichBlocks('$$E=mc^2$$')).toEqual([{ type: 'latex', formula: 'E=mc^2' }]);
        expect(parseRichBlocks('before\n$$\na+b\n$$\nafter')).toEqual([
            { type: 'text', text: 'before' },
            { type: 'latex', formula: 'a+b' },
            { type: 'text', text: 'after' }
        ]);
    });

    it('treats a paragraph that is only one inline formula as that formula', () => {
        expect(parseRichBlocks('$x^2$')).toEqual([{ type: 'latex', formula: 'x^2' }]);
    });

    it('keeps prose with inline math together as one flowed block', () => {
        expect(parseRichBlocks('the loss $L_{o2o}$ is small')).toEqual([
            { type: 'inline-math', source: 'the loss $L_{o2o}$ is small' }
        ]);
    });

    it('does not mistake prices for math', () => {
        expect(parseRichBlocks('costs $5 and $10 each')).toEqual([{ type: 'text', text: 'costs $5 and $10 each' }]);
    });

    it('lifts images out of a paragraph, with size hints', () => {
        expect(parseRichBlocks('see ![[fig 1.png|200]] and ![alt](https://x.io/a.png)')).toEqual([
            { type: 'text', text: 'see' },
            { type: 'image', target: 'fig 1.png', width: 200 },
            { type: 'text', text: 'and' },
            { type: 'image', target: 'https://x.io/a.png', width: undefined }
        ]);
    });

    it('reads a pipe table with alignment', () => {
        const [table] = parseRichBlocks('| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |');
        expect(table).toEqual({
            type: 'table', header: ['a', 'b'], rows: [['1', '2'], ['3', '4']], align: ['left', 'right']
        });
    });

    it('does not take a lone pipe line for a table', () => {
        expect(parseRichBlocks('a | b')[0].type).toBe('text');
    });
});

describe('buildInlineFormula', () => {
    it('turns prose into \\text and keeps math as math', () => {
        expect(buildInlineFormula('loss $x^2$ here', 1000)).toBe('\\text{loss }x^2\\text{ here}');
    });

    it('escapes LaTeX specials in prose', () => {
        expect(buildInlineFormula('50% of $a$', 1000)).toContain('50\\%');
    });

    it('wraps long text into a left-aligned array', () => {
        const formula = buildInlineFormula('word '.repeat(40) + '$a$', 200);
        expect(formula.startsWith('\\begin{array}{l}')).toBe(true);
        expect(formula).toContain('\\\\');
    });
});

describe('fitImage', () => {
    it('shrinks to the node width and keeps the aspect ratio', () => {
        expect(fitImage(1600, 800)).toEqual({ width: 320, height: 160 });
    });
    it('honours a smaller width hint', () => {
        expect(fitImage(1600, 800, 160)).toEqual({ width: 160, height: 80 });
    });
    it('falls back when the size is unknown', () => {
        expect(fitImage(0, 0)).toEqual({ width: 240, height: 160 });
    });
});

describe('scene with rich content', () => {
    const byType = (elements: ExcalidrawElement[], type: string) => elements.filter(element => element.type === type);

    it('draws a formula as an image element carrying its latex', () => {
        const scene = sceneFor('$$a+b$$');
        const [image] = byType(scene.elements, 'image');
        expect(image.customData).toEqual({ latex: 'a+b' });
        expect(image.fileId).toMatch(/^[0-9a-f]{40}$/);
        expect(image.groupIds).toHaveLength(1);
    });

    it('lists embedded images and formulas in the markdown', () => {
        const md = buildExcalidrawMindmapFile([{
            title: 'Note', path: 'a/Note.md', headings: [],
            highlights: [{ text: '![[fig.png]]', comments: ['$$a+b$$'], line: 1 }]
        }], { assets })!;

        expect(md).toContain('## Embedded Files');
        expect(md).toMatch(/\n[0-9a-f]{40}: \[\[a\/images\/fig\.png\]\]\n/);
        expect(md).toMatch(/\n[0-9a-f]{40}: \$\$a\+b\$\$\n/);
        expect(md.indexOf('## Embedded Files')).toBeLessThan(md.indexOf('## Drawing'));
    });

    it('writes no Embedded Files section when there is nothing to embed', () => {
        const md = buildExcalidrawMindmapFile([{
            title: 'Note', headings: [], highlights: [{ text: 'plain', line: 1 }]
        }])!;
        expect(md).not.toContain('Embedded Files');
    });

    it('keeps an unresolvable image visible as its source', () => {
        const scene = sceneFor('![[missing.png]]');
        expect(byType(scene.elements, 'image')).toHaveLength(0);
        expect(byType(scene.elements, 'text').some(text => text.text === '![[missing.png]]')).toBe(true);
    });

    it('draws a table as bound cells inside one group', () => {
        const scene = sceneFor('| a | b |\n|---|---|\n| 1 | 2 |');
        const grouped = scene.elements.filter(element => element.type === 'rectangle' && (element.groupIds as string[]).length > 0);
        // The node's box plus 2 rows x 2 columns.
        expect(grouped).toHaveLength(5);
        const texts = byType(scene.elements, 'text').filter(text => text.originalText !== 'Note');
        expect(texts.map(text => text.originalText)).toEqual(['a', 'b', '1', '2']);
        for (const text of texts) {
            const host = scene.elements.find(element => element.id === text.containerId);
            expect((host?.boundElements as Array<{ id: string }>).some(bound => bound.id === text.id)).toBe(true);
        }
    });

    it('flows inline math with its sentence as one wrapped formula image', () => {
        const md = buildExcalidrawMindmapFile([{
            title: 'Note', headings: [], highlights: [{ text: 'the loss $L$ is small', line: 1 }]
        }], { assets })!;
        expect(md).toMatch(/: \$\$\\text\{the loss \}L\\text\{ is small\}\$\$\n/);
    });

    it('keeps plain nodes as before: one bound label, no group', () => {
        const scene = sceneFor('plain words');
        const box = scene.elements.find(element => element.type === 'rectangle' && 'growthMode' in (element.customData as object))!;
        expect(box.groupIds).toEqual([]);
        expect(byType(scene.elements, 'image')).toHaveLength(0);
    });

    it('keeps element ids unique and eight characters across a rich scene', () => {
        const scene = sceneFor('text $$a$$ ![[x.png]]\n\n| a | b |\n|---|---|\n| 1 | 2 |', ['c $b$ d']);
        const ids = scene.elements.map(element => element.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every(id => /^[A-Za-z0-9]{8}$/.test(id))).toBe(true);
    });
});
