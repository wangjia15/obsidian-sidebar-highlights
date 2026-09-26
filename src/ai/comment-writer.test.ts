import {
    appendFootnoteDefinition,
    buildFootnote,
    canUseInlineFootnote,
    commentEditsForHighlight,
    formatForFootnote,
    locateHighlight,
    nextFootnoteKey,
    writeCommentForHighlight
} from './comment-writer';
import type { HighlightAnchor } from './comment-writer';
import { extractFootnoteDefinitions } from '../utils/footnote-parser';

describe('nextFootnoteKey', () => {
    it('starts at 1 for a note without footnotes', () => {
        expect(nextFootnoteKey('Plain text, nothing else.')).toBe('1');
    });

    it('continues past the highest numeric key', () => {
        expect(nextFootnoteKey('a[^1] b[^3]')).toBe('4');
    });

    it('reserves keys that only appear as references', () => {
        // The definition was deleted; reusing the orphaned key would silently
        // attach new comments to wherever that reference still points.
        expect(nextFootnoteKey('x[^2] y[^7]')).toBe('8');
    });

    it('falls back to numbering when only named keys exist', () => {
        expect(nextFootnoteKey('[^note]: a named footnote')).toBe('1');
    });
});

describe('canUseInlineFootnote', () => {
    it('accepts plain text', () => {
        expect(canUseInlineFootnote('a tidy comment')).toBe(true);
    });

    it('rejects a closing bracket, which would end the footnote early', () => {
        expect(canUseInlineFootnote('see [1] here')).toBe(false);
    });

    it('rejects line breaks, which the inline form cannot span', () => {
        expect(canUseInlineFootnote('two\nlines')).toBe(false);
        expect(canUseInlineFootnote('carriage\rreturn')).toBe(false);
    });
});

describe('formatForFootnote', () => {
    it('collapses to one line when the parser only reads one', () => {
        expect(formatForFootnote('  first\n\nsecond   third  ', { allowMultiline: false }))
            .toBe('first second third');
    });

    it('keeps line breaks once the parser can read them', () => {
        expect(formatForFootnote('  first\nsecond  ', { allowMultiline: true }))
            .toBe('first\nsecond');
    });

    it('returns an empty string for blank answers', () => {
        expect(formatForFootnote(' \n\n ', { allowMultiline: false })).toBe('');
    });
});

describe('buildFootnote', () => {
    it('builds an inline footnote when preferred and possible', () => {
        const footnote = buildFootnote('==quote==', 'a tidy comment', true);
        expect(footnote).toEqual({
            style: 'inline',
            reference: '^[a tidy comment]',
            definition: null,
            key: null
        });
    });

    it('falls back to a standard footnote for text the inline form cannot hold', () => {
        const footnote = buildFootnote('==quote== [^1]: old', 'has ] bracket', true);
        expect(footnote.style).toBe('standard');
        expect(footnote.reference).toBe('[^2]');
        expect(footnote.definition).toBe('[^2]: has ] bracket');
        expect(footnote.key).toBe('2');
    });

    it('honours the preference against inline footnotes', () => {
        const footnote = buildFootnote('note', 'a tidy comment', false);
        expect(footnote.style).toBe('standard');
        expect(footnote.reference).toBe('[^1]');
    });
});

describe('appendFootnoteDefinition', () => {
    it('returns just the definition for an empty note', () => {
        expect(appendFootnoteDefinition('', '[^1]: comment')).toBe('[^1]: comment\n');
    });

    it('separates the definition from body text with a blank line', () => {
        expect(appendFootnoteDefinition('A paragraph.', '[^1]: comment'))
            .toBe('A paragraph.\n\n[^1]: comment\n');
    });

    it('keeps a run of definitions on consecutive lines', () => {
        expect(appendFootnoteDefinition('para\n\n[^1]: first', '[^2]: second'))
            .toBe('para\n\n[^1]: first\n[^2]: second\n');
    });

    it('trims trailing whitespace before appending', () => {
        expect(appendFootnoteDefinition('para  \n\t ', '[^1]: comment'))
            .toBe('para\n\n[^1]: comment\n');
    });
});

describe('locateHighlight', () => {
    const anchor = (over: Partial<HighlightAnchor>): HighlightAnchor => ({
        text: 'quote',
        startOffset: 0,
        ...over
    });

    it('finds the highlight and points at its end', () => {
        const location = locateHighlight('before ==quote== after', anchor({}));
        expect(location).not.toBeNull();
        expect(location!.matchEnd - location!.matchStart).toBe('==quote=='.length);
        expect(location!.insertAt).toBe(location!.matchEnd);
    });

    it('picks the occurrence nearest the recorded offset', () => {
        const content = '==quote== one ==quote== two ==quote== three';
        const nearEnd = locateHighlight(content, anchor({ startOffset: content.length }));
        expect(nearEnd?.matchStart).toBe(content.lastIndexOf('==quote=='));

        const nearStart = locateHighlight(content, anchor({ startOffset: 0 }));
        expect(nearStart?.matchStart).toBe(0);
    });

    it('searches for native comments with their delimiters', () => {
        const location = locateHighlight('%%note%% text', anchor({ text: 'note', isNativeComment: true }));
        expect(location?.matchStart).toBe(0);
    });

    it('searches the custom-pattern full match when present', () => {
        const location = locateHighlight('?~custom~?', anchor({ fullMatch: '?~custom~?' }));
        expect(location?.matchStart).toBe(0);
    });

    it('never falls back to == for a custom pattern, whose delimiters are its own', () => {
        // The same text also appears as an ordinary highlight; attaching the
        // comment there would put it on a different highlight entirely.
        const content = 'a ==custom== b';
        expect(locateHighlight(content, anchor({ text: 'custom', type: 'custom', fullMatch: '?~custom~?' })))
            .toBeNull();
    });

    it('finds a highlight the note writes as a coloured <mark>', () => {
        const content = 'before <mark style="background: #ffd700;">quote</mark> after';
        const location = locateHighlight(content, anchor({ type: 'html', startOffset: 7 }));
        expect(content.slice(location!.matchStart, location!.matchEnd))
            .toBe('<mark style="background: #ffd700;">quote</mark>');
    });

    it('finds a <mark> even when the stored highlight still says ==text==', () => {
        // Colouring a highlight rewrites its markup; until the next scan the
        // sidebar's copy is a step behind, and the comment must still land.
        const content = 'before <mark style="background: #ffd700;">quote</mark> after';
        const location = locateHighlight(content, anchor({ startOffset: 7 }));
        expect(location?.matchStart).toBe(content.indexOf('<mark'));
    });

    it('finds the other HTML highlight forms', () => {
        const span = '<span style="background:#ff0">quote</span>';
        expect(locateHighlight(span, anchor({ type: 'html' }))?.matchEnd).toBe(span.length);

        const font = '<font color="red">quote</font>';
        expect(locateHighlight(font, anchor({ type: 'html' }))?.matchEnd).toBe(font.length);
    });

    it('prefers markdown over HTML when both hold the same text', () => {
        const content = '==quote== and <mark>quote</mark>';
        expect(locateHighlight(content, anchor({ startOffset: 0 }))?.matchStart).toBe(0);
    });

    it('attaches after a footnote already on an HTML highlight', () => {
        const content = '<mark>quote</mark>[^1] rest';
        const location = locateHighlight(content, anchor({ type: 'html' }));
        expect(location?.insertAt).toBe('<mark>quote</mark>[^1]'.length);
    });

    it('falls back to the generic HTML form when the stored markup is stale', () => {
        // Recoloured in the note since the sidebar last scanned it.
        const content = '<mark style="background: #ff0000;">quote</mark>';
        const location = locateHighlight(content, anchor({
            type: 'html',
            fullMatch: '<mark style="background: #ffd700;">quote</mark>'
        }));
        expect(location?.matchEnd).toBe(content.length);
    });

    it('returns null when the highlight is gone', () => {
        expect(locateHighlight('nothing here', anchor({}))).toBeNull();
    });

    it('returns null for an empty needle', () => {
        expect(locateHighlight('anything', anchor({ text: '', fullMatch: '' }))).toBeNull();
    });

    it('attaches after footnotes already on the highlight', () => {
        const content = '==quote==[^1] ==other==';
        const location = locateHighlight(content, anchor({}));
        expect(location?.insertAt).toBe('==quote==[^1]'.length);
    });

    it('attaches after a run of footnotes, standard and inline mixed', () => {
        const content = '==quote==[^1] ^[inline] then';
        const location = locateHighlight(content, anchor({}));
        expect(location?.insertAt).toBe('==quote==[^1] ^[inline]'.length);
    });
});

describe('writeCommentForHighlight', () => {
    const anchor: HighlightAnchor = { text: 'quote', startOffset: 0 };

    it('writes an inline footnote next to the highlight', () => {
        const write = writeCommentForHighlight('a ==quote== b', anchor, 'a tidy comment', true);
        expect(write).not.toBeNull();
        expect(write?.content).toBe('a ==quote==^[a tidy comment] b');
        expect(write?.style).toBe('inline');
    });

    it('writes a standard reference plus a definition at the end', () => {
        const write = writeCommentForHighlight('a ==quote== b', anchor, 'a tidy comment', false);
        expect(write?.content).toBe('a ==quote==[^1] b\n\n[^1]: a tidy comment\n');
        expect(write?.key).toBe('1');
    });

    it('places a second comment beside the first, not before it', () => {
        const first = writeCommentForHighlight('==quote== body', anchor, 'first', false);
        const second = writeCommentForHighlight(first!.content, anchor, 'second', false);
        expect(second?.content).toContain('==quote==[^1][^2] body');
        expect(second?.content.endsWith('[^2]: second\n')).toBe(true);
    });

    it('continues the key sequence across writes', () => {
        const first = writeCommentForHighlight('==quote== body', anchor, 'first', false);
        const second = writeCommentForHighlight(first!.content, anchor, 'second', false);
        expect(second?.key).toBe('2');
    });

    it('writes nothing when the highlight cannot be found', () => {
        expect(writeCommentForHighlight('the text was edited', anchor, 'comment', true)).toBeNull();
    });
});

describe('commentEditsForHighlight', () => {
    const anchor: HighlightAnchor = { text: 'quote', startOffset: 0 };

    /** Applies the edits the way an editor would, in the order given. */
    const apply = (content: string, edits: ReturnType<typeof commentEditsForHighlight>): string => {
        let result = content;
        for (const edit of edits!) {
            result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
        }
        return result;
    };

    const sameAsWholeDocument = (content: string, preferInline: boolean) => {
        const edits = commentEditsForHighlight(content, anchor, 'a tidy comment', preferInline);
        const whole = writeCommentForHighlight(content, anchor, 'a tidy comment', preferInline);
        expect(apply(content, edits)).toBe(whole!.content);
    };

    it('produces the same text as the whole-document write, inline', () => {
        sameAsWholeDocument('a ==quote== b', true);
    });

    it('produces the same text as the whole-document write, standard', () => {
        sameAsWholeDocument('a ==quote== b', false);
    });

    it('matches when the note already ends in a definition', () => {
        sameAsWholeDocument('==quote== body\n\n[^1]: first', false);
    });

    it('matches when the note ends in trailing whitespace', () => {
        sameAsWholeDocument('==quote== body\n\n  \n\t', false);
    });

    it('matches for a highlight at the very end of the note', () => {
        sameAsWholeDocument('body ==quote==', false);
    });

    it('matches for an HTML highlight', () => {
        const content = 'a <mark style="background: #ffd700;">quote</mark> b';
        const html: HighlightAnchor = { text: 'quote', startOffset: 2, type: 'html' };
        const edits = commentEditsForHighlight(content, html, 'note', false);
        expect(apply(content, edits))
            .toBe(writeCommentForHighlight(content, html, 'note', false)!.content);
    });

    it('inserts an inline footnote as a single edit', () => {
        const edits = commentEditsForHighlight('a ==quote== b', anchor, 'note', true);
        expect(edits).toEqual([{ text: '^[note]', from: 'a ==quote=='.length, to: 'a ==quote=='.length }]);
    });

    it('puts the end-of-note definition before the reference', () => {
        // The reverse order would insert the reference first and leave the
        // definition edit pointing at offsets that had already moved.
        const edits = commentEditsForHighlight('==quote== body', anchor, 'note', false);
        expect(edits).toHaveLength(2);
        expect(edits![0].from).toBeGreaterThan(edits![1].from);
    });

    it('returns null when the highlight cannot be found', () => {
        expect(commentEditsForHighlight('the text was edited', anchor, 'note', true)).toBeNull();
    });
});

describe('multi-line comments', () => {
    const anchor: HighlightAnchor = { text: 'quote', startOffset: 0 };

    it('indents continuation lines in the definition', () => {
        const footnote = buildFootnote('note', 'first\nsecond', false);
        expect(footnote.definition).toBe('[^1]: first\n    second');
    });

    it('leaves blank lines unindented between paragraphs', () => {
        const footnote = buildFootnote('note', 'para one\n\npara two', false);
        expect(footnote.definition).toBe('[^1]: para one\n\n    para two');
    });

    it('round-trips through the footnote parser', () => {
        const answer = 'Structure:\n\n```mermaid\ngraph TD; A-->B;\n```';
        const write = writeCommentForHighlight('==quote== body', anchor, answer, false);
        expect(write).not.toBeNull();
        expect(extractFootnoteDefinitions(write!.content).get(write!.key!)).toBe(answer);
    });

    it('appends the next definition directly after a multi-line one', () => {
        const first = appendFootnoteDefinition('para', '[^1]: a\n    b');
        expect(appendFootnoteDefinition(first, '[^2]: c')).toBe('para\n\n[^1]: a\n    b\n[^2]: c\n');
    });

    it('normalizes CRLF answers before storing', () => {
        expect(formatForFootnote('a\r\nb', { allowMultiline: true })).toBe('a\nb');
    });

    it('still collapses for the inline form', () => {
        expect(formatForFootnote('a\nb', { allowMultiline: false })).toBe('a b');
    });
});
