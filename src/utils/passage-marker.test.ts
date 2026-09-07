import { existingMarkupRanges, markPassages, parsePassages } from './passage-marker';

describe('parsePassages', () => {
    it('takes one passage per line', () => {
        expect(parsePassages('first passage\nsecond passage'))
            .toEqual(['first passage', 'second passage']);
    });

    it('strips bullets, numbering and blockquote markers', () => {
        expect(parsePassages('- a bullet\n2. a number\n> a quote marker'))
            .toEqual(['a bullet', 'a number', 'a quote marker']);
    });

    it('strips a matched pair of wrapping quotes', () => {
        expect(parsePassages('"a quoted passage"\n“a curly one”'))
            .toEqual(['a quoted passage', 'a curly one']);
    });

    it('keeps an opening quote that is not matched at the end', () => {
        expect(parsePassages('"as he put it, and then some')).toEqual(['"as he put it, and then some']);
    });

    it('drops blank lines, stray punctuation and echoed headings', () => {
        expect(parsePassages('a real passage\n\n## Section\n-\nanother real one'))
            .toEqual(['a real passage', 'another real one']);
    });

    it('keeps a passage that has no whitespace at all', () => {
        // Chinese and Japanese prose does not put spaces between words; a
        // whitespace requirement here would drop every passage in a CJK note.
        expect(parsePassages('这是一个值得标记的论断\n- 另一个重要的段落'))
            .toEqual(['这是一个值得标记的论断', '另一个重要的段落']);
    });

    it('drops duplicates so one passage is not marked twice', () => {
        expect(parsePassages('same passage\nsame passage')).toEqual(['same passage']);
    });
});

describe('markPassages', () => {
    it('wraps a passage where the note already has it', () => {
        const result = markPassages('One sentence. Another sentence.', ['Another sentence']);
        expect(result.content).toBe('One sentence. ==Another sentence==.');
        expect(result.marked).toEqual(['Another sentence']);
    });

    it('writes a coloured mark when a colour is set', () => {
        const result = markPassages('a b c', ['a b'], { color: '#ffd700' });
        expect(result.content).toBe('<mark style="background: #ffd700;">a b</mark> c');
    });

    it('marks several passages without disturbing each other\'s offsets', () => {
        const content = 'alpha beta. gamma delta. epsilon zeta.';
        const result = markPassages(content, ['epsilon zeta', 'alpha beta', 'gamma delta']);
        expect(result.content).toBe('==alpha beta==. ==gamma delta==. ==epsilon zeta==.');
        expect(result.unmatched).toEqual([]);
    });

    it('reports a passage the note does not contain instead of inserting it', () => {
        const content = 'the note as written';
        const result = markPassages(content, ['a paraphrase of the note']);
        expect(result.content).toBe(content);
        expect(result.unmatched).toEqual(['a paraphrase of the note']);
    });

    it('never invents text: the marked note is the original plus delimiters only', () => {
        const content = 'Some prose worth keeping, and some not.';
        const result = markPassages(content, ['prose worth keeping', 'invented sentence']);
        expect(result.content.replace(/==/g, '')).toBe(content);
    });

    it('matches across reflowed whitespace', () => {
        // The model collapsed the note's line break into a single space.
        const content = 'a claim that runs\nacross two lines';
        const result = markPassages(content, ['a claim that runs across two lines']);
        // The passage spans a newline, which markdown cannot hold in one
        // highlight, so it is reported rather than written badly.
        expect(result.unmatched).toHaveLength(1);
        expect(result.content).toBe(content);
    });

    it('matches when only spacing within a line differs', () => {
        const result = markPassages('spaced   out  words here', ['spaced out words']);
        expect(result.content).toBe('==spaced   out  words== here');
    });

    it('leaves a passage that is already highlighted alone', () => {
        const content = 'before ==already marked== after';
        const result = markPassages(content, ['already marked']);
        expect(result.content).toBe(content);
        expect(result.alreadyMarked).toEqual(['already marked']);
        expect(result.unmatched).toEqual([]);
    });

    it('marks the unmarked occurrence when the text appears twice', () => {
        const content = '==repeated text== and repeated text again';
        const result = markPassages(content, ['repeated text']);
        expect(result.content).toBe('==repeated text== and ==repeated text== again');
    });

    it('stays out of an existing <mark>', () => {
        const content = '<mark style="background: #ff0;">coloured passage</mark>';
        expect(markPassages(content, ['coloured passage']).content).toBe(content);
    });

    it('stays out of a native comment', () => {
        const content = '%% a note to self %%';
        expect(markPassages(content, ['a note to self']).content).toBe(content);
    });

    it('stays out of a footnote definition', () => {
        const content = 'body\n\n[^1]: a comment on the passage';
        expect(markPassages(content, ['a comment on the passage']).content).toBe(content);
    });

    it('stays out of an inline footnote', () => {
        const content = 'body ^[an inline comment] more';
        expect(markPassages(content, ['an inline comment']).content).toBe(content);
    });

    it('stays out of frontmatter', () => {
        const content = '---\ntitle: a promising title\n---\n\nbody text here';
        expect(markPassages(content, ['a promising title']).content).toBe(content);
    });

    it('stays out of ranges the caller excludes, such as code blocks', () => {
        const content = 'prose\n```\nconst a = 1;\n```\n';
        const excluded = [{ start: content.indexOf('```'), end: content.lastIndexOf('```') + 3 }];
        const result = markPassages(content, ['const a = 1;'], { excludedRanges: excluded });
        expect(result.content).toBe(content);
    });

    it('does not let two overlapping passages nest their delimiters', () => {
        const content = 'a longer claim about things';
        const result = markPassages(content, ['a longer claim about things', 'longer claim']);
        expect(result.content).toBe('==a longer claim about things==');
        expect(result.unmatched).toEqual(['longer claim']);
    });

    it('returns the note untouched for an empty passage list', () => {
        expect(markPassages('unchanged', []).content).toBe('unchanged');
    });

    it('marks a Chinese passage, which carries no word spacing', () => {
        const content = '前面的话。这是一个值得标记的论断。后面的话。';
        const result = markPassages(content, ['这是一个值得标记的论断']);
        expect(result.content).toBe('前面的话。==这是一个值得标记的论断==。后面的话。');
    });

    it('treats regex metacharacters in a passage as literal text', () => {
        const content = 'the cost is $5.00 (plus tax)';
        const result = markPassages(content, ['$5.00 (plus tax)']);
        expect(result.content).toBe('the cost is ==$5.00 (plus tax)==');
    });
});

describe('existingMarkupRanges', () => {
    it('finds each form a highlight or comment can take', () => {
        const content = '==a== %%b%% <mark>c</mark> ^[d] [^1]: e';
        expect(existingMarkupRanges(content).length).toBeGreaterThanOrEqual(5);
    });

    it('finds nothing in plain prose', () => {
        expect(existingMarkupRanges('just words here')).toEqual([]);
    });
});
