import {
    buildNoteVariables,
    buildVariables,
    formatHighlightList,
    payloadSize,
    truncate,
    windowAround,
    type ContextSource,
    type NoteContextSource
} from './context-builder';
import { DEFAULT_AI_SETTINGS, cloneAiSettings, type AiSettings } from './types';

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
    return { ...cloneAiSettings(DEFAULT_AI_SETTINGS), enabled: true, ...overrides };
}

function source(overrides: Partial<ContextSource> = {}): ContextSource {
    return { highlightText: 'the highlight', ...overrides };
}

describe('truncate', () => {
    it('leaves text shorter than the limit untouched', () => {
        expect(truncate('short', 100)).toBe('short');
    });

    it('leaves text exactly at the limit untouched, with no marker', () => {
        expect(truncate('12345', 5)).toBe('12345');
    });

    it('marks text that was cut', () => {
        expect(truncate('123456', 5)).toBe('12345…');
    });

    it('returns nothing for a zero or negative budget', () => {
        expect(truncate('anything', 0)).toBe('');
        expect(truncate('anything', -5)).toBe('');
    });

    it('does not split a surrogate pair', () => {
        // '😀' is two UTF-16 units; cutting at 3 would land inside it and leave
        // a lone high surrogate that reaches the model as a replacement char.
        const text = `ab😀cd`;
        const cut = truncate(text, 3);

        expect(cut).toBe('ab…');
        expect(cut).not.toMatch(/[\uD800-\uDBFF]/);
    });

    it('keeps a surrogate pair that fits whole', () => {
        expect(truncate('ab😀cd', 4)).toBe('ab😀…');
    });
});

describe('windowAround', () => {
    const content = '0123456789'.repeat(10); // 100 chars

    it('returns everything when the note fits the budget', () => {
        expect(windowAround('short note', 3, 100)).toBe('short note');
    });

    it('centres the window on the offset', () => {
        const result = windowAround(content, 50, 10);

        expect(result).toContain('…');
        expect(result.replace(/…/g, '')).toHaveLength(10);
        expect(content.indexOf(result.replace(/…/g, ''))).toBeLessThanOrEqual(50);
    });

    it('does not mark the start when the window begins at the start', () => {
        const result = windowAround(content, 0, 10);

        expect(result.startsWith('…')).toBe(false);
        expect(result.endsWith('…')).toBe(true);
    });

    it('does not mark the end when the window reaches the end', () => {
        const result = windowAround(content, 99, 10);

        expect(result.startsWith('…')).toBe(true);
        expect(result.endsWith('…')).toBe(false);
    });

    it('clamps an offset past the end of the note', () => {
        expect(() => windowAround(content, 5000, 10)).not.toThrow();
        expect(windowAround(content, 5000, 10).endsWith('…')).toBe(false);
    });

    it('returns nothing for an empty note or a zero budget', () => {
        expect(windowAround('', 0, 10)).toBe('');
        expect(windowAround(content, 5, 0)).toBe('');
    });

    it('never leaves a partial surrogate at either edge', () => {
        const emoji = '😀'.repeat(50);
        const result = windowAround(emoji, 50, 11);

        expect(result).not.toMatch(/^[\uDC00-\uDFFF]/);
        expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
    });
});

describe('buildVariables privacy gates', () => {
    const fullSource = source({
        comments: ['first comment', 'second comment'],
        noteContent: 'the entire note body',
        noteTitle: 'My note',
        filePath: 'Notes/My note.md',
        highlightOffset: 4
    });

    it('sends only the highlight on default settings', () => {
        const variables = buildVariables(fullSource, settings());

        expect(variables.selection).toBe('the highlight');
        expect(variables.note).toBeUndefined();
        expect(variables.context).toBeUndefined();
        expect(variables.comments).toBeUndefined();
    });

    it('withholds note content until the note setting is on', () => {
        const off = buildVariables(fullSource, settings({ includeNoteContext: false }));
        const on = buildVariables(fullSource, settings({ includeNoteContext: true }));

        expect(off.note).toBeUndefined();
        expect(on.note).toBe('the entire note body');
    });

    it('withholds comments until the comments setting is on', () => {
        const off = buildVariables(fullSource, settings({ includeExistingComments: false }));
        const on = buildVariables(fullSource, settings({ includeExistingComments: true }));

        expect(off.comments).toBeUndefined();
        expect(on.comments).toBe('first comment\n\nsecond comment');
    });

    it('leaves comments undefined when the highlight has none, even with the gate open', () => {
        const variables = buildVariables(source({ comments: [] }), settings({ includeExistingComments: true }));

        expect(variables.comments).toBeUndefined();
    });

    it('ignores comments that are only whitespace', () => {
        const variables = buildVariables(
            source({ comments: ['  ', '\n'] }),
            settings({ includeExistingComments: true })
        );

        expect(variables.comments).toBeUndefined();
    });
});

describe('buildVariables values', () => {
    it('trims the highlight text', () => {
        expect(buildVariables(source({ highlightText: '  spaced  ' }), settings()).selection).toBe('spaced');
    });

    it('joins tags with spaces and collections with commas', () => {
        const variables = buildVariables(
            source({ tags: ['#a', '#b'], collections: ['Research', 'Reading'] }),
            settings()
        );

        expect(variables.tags).toBe('#a #b');
        expect(variables.collection).toBe('Research, Reading');
    });

    it('leaves empty lists undefined rather than sending a blank', () => {
        const variables = buildVariables(source({ tags: [], collections: [] }), settings());

        expect(variables.tags).toBeUndefined();
        expect(variables.collection).toBeUndefined();
    });

    it('caps note content at the configured limit', () => {
        const variables = buildVariables(
            source({ noteContent: 'x'.repeat(500) }),
            settings({ includeNoteContext: true, contextCharLimit: 100 })
        );

        expect(variables.note).toHaveLength(101); // 100 characters plus the cut marker
    });

    it('falls back to a truncated note when the highlight offset is unknown', () => {
        const variables = buildVariables(
            source({ noteContent: 'y'.repeat(500), highlightOffset: undefined }),
            settings({ includeNoteContext: true, contextCharLimit: 50 })
        );

        expect(variables.context).toBe(variables.note);
    });
});

describe('buildVariables target language', () => {
    it('prefers an explicit per-run language', () => {
        const variables = buildVariables(source(), settings({ defaultTargetLanguage: 'French' }), {
            targetLanguage: 'German',
            fallbackLanguage: 'English'
        });

        expect(variables.targetLang).toBe('German');
    });

    it('falls back to the configured default', () => {
        const variables = buildVariables(source(), settings({ defaultTargetLanguage: 'French' }), {
            fallbackLanguage: 'English'
        });

        expect(variables.targetLang).toBe('French');
    });

    it('falls back to the UI language when nothing is configured', () => {
        const variables = buildVariables(source(), settings({ defaultTargetLanguage: '' }), {
            fallbackLanguage: '简体中文'
        });

        expect(variables.targetLang).toBe('简体中文');
    });

    it('is undefined when there is nothing to fall back to', () => {
        expect(buildVariables(source(), settings()).targetLang).toBeUndefined();
    });
});

describe('formatHighlightList', () => {
    it('lists passages as bullets with comments nested under them', () => {
        expect(formatHighlightList([
            { text: 'first passage', comments: ['a thought'] },
            { text: 'second passage' }
        ])).toBe('- first passage\n    - a thought\n- second passage');
    });

    it('flattens a passage that spans lines onto one bullet', () => {
        expect(formatHighlightList([{ text: 'runs\nacross  lines' }]))
            .toBe('- runs across lines');
    });

    it('drops empty passages and empty comments', () => {
        expect(formatHighlightList([
            { text: '   ' },
            { text: 'kept', comments: ['', '  ', 'real'] }
        ])).toBe('- kept\n    - real');
    });

    it('is empty for no highlights', () => {
        expect(formatHighlightList([])).toBe('');
        expect(formatHighlightList(undefined)).toBe('');
    });
});

describe('buildNoteVariables', () => {
    const noteSource = (overrides: Partial<NoteContextSource> = {}): NoteContextSource =>
        ({ noteContent: 'The whole note text.', noteTitle: 'A note', filePath: 'a/note.md', ...overrides });

    it('sends the note even with includeNoteContext off', () => {
        // Running a prompt whose subject is the document is the decision to
        // send the document; gating it would answer about nothing.
        const variables = buildNoteVariables(noteSource(), settings({ includeNoteContext: false }));
        expect(variables.note).toBe('The whole note text.');
    });

    it('bounds the note by noteCharLimit, not contextCharLimit', () => {
        const variables = buildNoteVariables(
            noteSource({ noteContent: 'abcdefghij' }),
            settings({ contextCharLimit: 2, noteCharLimit: 5 })
        );
        expect(variables.note).toBe('abcde…');
    });

    it('resolves the title and path', () => {
        const variables = buildNoteVariables(noteSource(), settings());
        expect(variables.noteTitle).toBe('A note');
        expect(variables.filePath).toBe('a/note.md');
    });

    it('fills {{highlights}} from the note\'s own highlights', () => {
        const variables = buildNoteVariables(
            noteSource({ highlights: [{ text: 'a passage', comments: ['a note on it'] }] }),
            settings()
        );
        expect(variables.highlights).toBe('- a passage\n    - a note on it');
    });

    it('leaves {{highlights}} unset for a note with none', () => {
        expect(buildNoteVariables(noteSource(), settings()).highlights).toBeUndefined();
    });

    it('never resolves the highlight-only variables', () => {
        const variables = buildNoteVariables(noteSource(), settings());
        expect(variables.selection).toBeUndefined();
        expect(variables.context).toBeUndefined();
    });
});

describe('payloadSize', () => {
    it('counts every message, which is what the confirmation quotes', () => {
        expect(payloadSize([{ content: 'abc' }, { content: 'de' }])).toBe(5);
    });

    it('is zero for no messages', () => {
        expect(payloadSize([])).toBe(0);
    });
});
