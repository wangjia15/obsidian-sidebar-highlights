import { existingMarkupRanges, markPassages, parsePassages, parsePassageAnswers } from './passage-marker';

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

describe('punctuation-tolerant passage matching', () => {
    it.each([
        ['他说「你好」之后', '他说"你好"之后'],
        ['他说『你好』之后', "他说'你好'之后"],
        ['say “hello” and «bye»', 'say "hello" and "bye"'],
        ['say ‘hello’ and ‹bye›', "say 'hello' and 'bye'"],
        ['first —— second – third ‐ fourth ‑ fifth − sixth ― end', 'first - second - third - fourth - fifth - sixth - end'],
        ['Ａｚ０９！＂＃＄％＆＇（）＊＋，－．／：；＜＝＞？＠［\\］＾＿｀｛｜｝～', 'Az09!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'],
        ['wait…then...', 'wait...then…'],
        ['他说「Ａ１」  ——\t等待…', '他说"A1" - 等待...']
    ])('wraps original characters for %s', (original, passage) => {
        const result = markPassages('before ' + original + ' after', [passage]);
        expect(result.content).toBe('before ==' + original + '== after');
        expect(result.marked).toEqual([original]);
        expect(markPassages(passage, [original]).content).toBe('==' + passage + '==');
        expect(result.content.replace(/==/g, '')).toBe('before ' + original + ' after');
    });

    it('chooses the first eligible repeated occurrence', () => {
        expect(markPassages('==他说「你好」之后== 他说「你好」之后 他说「你好」之后', ['他说"你好"之后']).content)
            .toBe('==他说「你好」之后== ==他说「你好」之后== 他说「你好」之后');
    });

    it.each(['==%s==', '<mark>%s</mark>', '%%%% %s %%%%', 'body ^[%s]', 'body\n[^1]: %s', '---\ntitle: %s\n---'])('preserves protected markup %s', wrapper => {
        const content = wrapper.replace('%s', '他说「你好」之后');
        expect(markPassages(content, ['他说"你好"之后']).content).toBe(content);
    });

    it('preserves code ranges and continues searching outside them', () => {
        const code = '\x60\x60\x60\n他说「你好」之后\n\x60\x60\x60';
        const result = markPassages(code + '\n他说「你好」之后', ['他说"你好"之后'], { excludedRanges: [{ start: 0, end: code.length }] });
        expect(result.content).toBe(code + '\n==他说「你好」之后==');
    });

    it('deduplicates parsed chunk answers before marking', () => {
        const passages = parsePassageAnswers(['- 他说「你好」  之后', '1. 他说"你好" 之后\nother passage']);
        expect(passages).toEqual(['他说「你好」  之后', 'other passage']);
        expect(markPassages('他说「你好」  之后 他说「你好」  之后', passages).marked).toHaveLength(1);
    });

    it('reports newly marked, already highlighted and missing passages independently', () => {
        const result = markPassages('新的「段落」 ==已有「段落」==', ['新的"段落"', '已有"段落"', '不存在的段落']);
        expect([result.marked.length, result.alreadyMarked.length, result.unmatched.length]).toEqual([1, 1, 1]);
    });
});

it('does not describe comments or code as already highlighted', () => {
    const content = '%% protected comment %% code passage ==existing highlight==';
    const result = markPassages(content, ['protected comment', 'code passage', 'existing highlight'], {
        excludedRanges: [{ start: content.indexOf('code passage'), end: content.indexOf(' ==') }]
    });
    expect(result.content).toBe(content);
    expect(result.alreadyMarked).toEqual(['existing highlight']);
    expect(result.unmatched).toEqual(['protected comment', 'code passage']);
});
