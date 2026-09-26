import { findImageEmbedAt, findImageEmbeds, imageDisplayName, imageMimeType, isImageHighlightText, parseImageEmbed } from './image-embed';

describe('parseImageEmbed', () => {
    it('reads a wiki embed, dropping a size alias', () => {
        expect(parseImageEmbed('![[attachments/chart.png|300]]')).toEqual({
            syntax: 'wiki', target: 'attachments/chart.png', alt: undefined
        });
    });

    it('keeps a wiki alias that is a caption', () => {
        expect(parseImageEmbed('![[chart.PNG|Revenue by year]]')?.alt).toBe('Revenue by year');
    });

    it('reads a markdown embed with a local, encoded path', () => {
        expect(parseImageEmbed('![图表](assets/my%20chart.jpg)')).toEqual({
            syntax: 'markdown', target: 'assets/my chart.jpg', alt: '图表'
        });
    });

    it('reads angle-bracketed paths and titles', () => {
        expect(parseImageEmbed('![](<my chart.webp> "title")')?.target).toBe('my chart.webp');
    });

    it('accepts a remote image whatever its URL looks like', () => {
        expect(parseImageEmbed('![](https://example.com/render?id=1)')?.target).toBe('https://example.com/render?id=1');
    });

    it('rejects non-image embeds and text around an image', () => {
        expect(parseImageEmbed('![[note]]')).toBeNull();
        expect(parseImageEmbed('![[doc.pdf]]')).toBeNull();
        expect(parseImageEmbed('see ![[a.png]]')).toBeNull();
        expect(parseImageEmbed('[[a.png]]')).toBeNull();
        expect(isImageHighlightText('plain text')).toBe(false);
    });
});

describe('image helpers', () => {
    it('maps extensions to MIME types', () => {
        expect(imageMimeType('a/b.JPEG')).toBe('image/jpeg');
        expect(imageMimeType('https://x.com/a.png?x=1')).toBe('image/png');
        expect(imageMimeType('a.md')).toBeUndefined();
    });

    it('names an image by its file, with any caption first', () => {
        expect(imageDisplayName({ syntax: 'wiki', target: 'a/b/chart.png' })).toBe('chart.png');
        expect(imageDisplayName({ syntax: 'wiki', target: 'chart.png', alt: 'Sales' })).toBe('Sales (chart.png)');
    });
});

describe('findImageEmbedAt', () => {
    const line = 'Before ![[a.png]] and ![x](b.jpg) and ![[note]]';

    it('finds the embed under the cursor', () => {
        expect(findImageEmbedAt(line, 10)).toEqual({ from: 7, to: 17, highlighted: false });
        expect(findImageEmbedAt(line, 25)).toEqual({ from: 22, to: 33, highlighted: false });
    });

    it('ignores non-image embeds and plain text', () => {
        expect(findImageEmbedAt(line, 2)).toBeNull();
        expect(findImageEmbedAt(line, 42)).toBeNull();
    });

    it('reports an embed that is already highlighted', () => {
        expect(findImageEmbedAt('==![[a.png]]==', 5)?.highlighted).toBe(true);
    });
});

describe('findImageEmbeds', () => {
    it('lists image embeds with offsets and whether each is highlighted', () => {
        const content = 'a ![[x.png]]\n==![[y.jpg]]==\n<mark style="background: #fff;">![[z.png]]</mark>[^1]\n![[note]]';
        const found = findImageEmbeds(content);
        expect(found.map(match => [match.embed.target, match.highlighted])).toEqual([
            ['x.png', false], ['y.jpg', true], ['z.png', true]
        ]);
        expect(content.slice(found[0].from, found[0].to)).toBe('![[x.png]]');
    });
});
