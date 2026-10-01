import {
    colorForEmoji, createHighlightMarkup, emojiForColor, highlightSourcePattern, isRecolorable,
    recolorHighlightMarkup, splitColorEmoji
} from './highlight-markup';

describe('createHighlightMarkup', () => {
    it('writes a plain markdown highlight when no colour is asked for', () => {
        expect(createHighlightMarkup('a quote')).toBe('==a quote==');
        expect(createHighlightMarkup('a quote', '')).toBe('==a quote==');
    });

    it('writes the colour as a background, so the note itself shows it', () => {
        expect(createHighlightMarkup('a quote', '#ffd700'))
            .toBe('<mark style="background: #ffd700;">a quote</mark>');
    });
});

describe('recolorHighlightMarkup', () => {
    it('turns a markdown highlight into a coloured mark', () => {
        expect(recolorHighlightMarkup('==a quote==', '#ff6b6b'))
            .toBe('<mark style="background: #ff6b6b;">a quote</mark>');
    });

    it('leaves a markdown highlight alone when the colour is cleared', () => {
        expect(recolorHighlightMarkup('==a quote==', '')).toBe('==a quote==');
    });

    it('replaces the background of a mark it wrote before', () => {
        expect(recolorHighlightMarkup('<mark style="background: #ffd700;">a quote</mark>', '#45b7d1'))
            .toBe('<mark style="background: #45b7d1;">a quote</mark>');
    });

    it('returns a mark to plain markdown when the colour is cleared', () => {
        expect(recolorHighlightMarkup('<mark style="background: #ffd700;">a quote</mark>', ''))
            .toBe('==a quote==');
    });

    it('keeps other style declarations and other attributes', () => {
        expect(recolorHighlightMarkup(
            '<mark class="hltr-yellow" style="background: yellow; font-weight: bold">a quote</mark>',
            '#96ceb4'
        )).toBe('<mark class="hltr-yellow" style="background: #96ceb4; font-weight: bold;">a quote</mark>');
    });

    it('adds a background to a mark that had none', () => {
        expect(recolorHighlightMarkup('<mark>a quote</mark>', '#ffd700'))
            .toBe('<mark style="background: #ffd700;">a quote</mark>');
    });

    it('handles background-color as well as background', () => {
        expect(recolorHighlightMarkup('<mark style="background-color: red;">a quote</mark>', '#ffd700'))
            .toBe('<mark style="background: #ffd700;">a quote</mark>');
    });

    it('keeps a multi-line highlight intact', () => {
        expect(recolorHighlightMarkup('==first line\n\nsecond line==', '#ffd700'))
            .toBe('<mark style="background: #ffd700;">first line\n\nsecond line</mark>');
    });

    it('leaves markup it does not own alone', () => {
        // Rewriting these would mean guessing at another plugin's conventions.
        expect(recolorHighlightMarkup('%%a comment%%', '#ffd700')).toBeNull();
        expect(recolorHighlightMarkup('<span style="background: red">a quote</span>', '#ffd700')).toBeNull();
        expect(recolorHighlightMarkup('<font color="#835cf5">a quote</font>', '#ffd700')).toBeNull();
        expect(recolorHighlightMarkup('plain text', '#ffd700')).toBeNull();
    });

    it('round-trips through a colour change and back', () => {
        const marked = recolorHighlightMarkup('==a quote==', '#ffd700')!;
        const recoloured = recolorHighlightMarkup(marked, '#ff6b6b')!;
        expect(recolorHighlightMarkup(recoloured, '')).toBe('==a quote==');
    });
});

describe('isRecolorable', () => {
    it('claims the two forms this plugin writes', () => {
        expect(isRecolorable('==a quote==')).toBe(true);
        expect(isRecolorable('<mark style="background: #ffd700;">a quote</mark>')).toBe(true);
    });

    it('disclaims everything else', () => {
        expect(isRecolorable('%%a comment%%')).toBe(false);
        expect(isRecolorable('<span style="background: red">a quote</span>')).toBe(false);
    });
});

describe('Obsidian 1.14 colour emoji', () => {
    const palette = { red: '#ff6b6b', green: '#96ceb4', blue: '#45b7d1' };

    it('splits a leading colour emoji off the text', () => {
        expect(splitColorEmoji('🔴 important')).toEqual({ emoji: '🔴', text: 'important' });
        expect(splitColorEmoji('🟣no space')).toEqual({ emoji: '🟣', text: 'no space' });
        expect(splitColorEmoji('plain 🔴 text')).toEqual({ text: 'plain 🔴 text' });
    });

    it('maps emoji to the palette and back', () => {
        expect(colorForEmoji('🔴', palette)).toBe('#ff6b6b');
        expect(emojiForColor('#45B7D1', palette)).toBe('🔵');
        expect(emojiForColor('#4ecdc4', palette)).toBeUndefined();
    });

    it('writes a palette colour as an emoji highlight and others as <mark>', () => {
        expect(createHighlightMarkup('hi', '#ff6b6b', palette)).toBe('==🔴 hi==');
        expect(createHighlightMarkup('hi', '#4ecdc4', palette)).toContain('<mark');
        expect(createHighlightMarkup('hi', '#ff6b6b')).toContain('<mark');
    });

    it('replaces or drops the emoji when recolouring', () => {
        expect(recolorHighlightMarkup('==🔴 hi==', '#96ceb4', palette)).toBe('==🟢 hi==');
        expect(recolorHighlightMarkup('==🔴 hi==', '', palette)).toBe('==hi==');
        expect(recolorHighlightMarkup('==🔴 hi==', '#4ecdc4', palette)).toContain('<mark');
        expect(recolorHighlightMarkup('==hi==', '#ff6b6b', palette)).toBe('==🔴 hi==');
    });

    it('migrates an old <mark> colour to the emoji syntax', () => {
        expect(recolorHighlightMarkup('<mark style="background: #ff6b6b;">hi</mark>', '#ff6b6b', palette)).toBe('==🔴 hi==');
    });

    it('finds a highlight with or without its emoji', () => {
        const re = new RegExp(highlightSourcePattern('hi'));
        expect(re.test('==hi==')).toBe(true);
        expect(re.test('==🟠 hi==')).toBe(true);
        expect(re.test('==ohi==')).toBe(false);
    });
});

describe('orange and purple', () => {
    it('use the palette slots when given, fixed defaults otherwise', () => {
        expect(colorForEmoji('🟠', { orange: '#111111' })).toBe('#111111');
        expect(colorForEmoji('🟣')).toBe('#a78bfa');
        expect(createHighlightMarkup('hi', '#ff9f43', { orange: '#ff9f43' })).toBe('==🟠 hi==');
    });
});
