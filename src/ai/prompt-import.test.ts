import { parseStoredPrompts } from './prompt-library';
import { resolvePrompts } from './prompt-library';
import type { StoredPrompt } from './types';

/**
 * Import replaces the user's whole prompt list, so anything this accepts is
 * something they have to live with. It is stricter than the type: a payload
 * that would resolve to an unusable prompt is rejected outright rather than
 * imported and silently skipped later.
 */
describe('parseStoredPrompts', () => {
    it('accepts an empty list', () => {
        expect(parseStoredPrompts('[]')).toEqual([]);
    });

    it('accepts a patch over a builtin', () => {
        expect(parseStoredPrompts('[{"id":"summarize","enabled":false}]')).toEqual([
            { id: 'summarize', enabled: false }
        ]);
    });

    it('accepts a complete user prompt', () => {
        const parsed = parseStoredPrompts(JSON.stringify([
            { id: 'mine', name: 'Mine', template: '{{selection}}', outputTarget: 'preview', enabled: true, sortOrder: 9 }
        ]));

        expect(parsed).toEqual([
            { id: 'mine', name: 'Mine', template: '{{selection}}', outputTarget: 'preview', enabled: true, sortOrder: 9 }
        ]);
    });

    it('drops fields it does not understand instead of storing them', () => {
        const parsed = parseStoredPrompts('[{"id":"summarize","enabled":false,"evil":"payload"}]');

        expect(parsed).toEqual([{ id: 'summarize', enabled: false }]);
    });

    it.each([
        ['not JSON at all', 'nonsense'],
        ['an object rather than a list', '{"id":"summarize"}'],
        ['a list of strings', '["summarize"]'],
        ['a null entry', '[null]'],
        ['an entry with no id', '[{"name":"Mine","template":"x"}]'],
        ['an entry whose id is not a string', '[{"id":42,"template":"x"}]'],
        ['an entry with a blank id', '[{"id":"  ","template":"x"}]'],
        ['a user prompt with no template', '[{"id":"mine","name":"Mine"}]'],
        ['a user prompt with a blank template', '[{"id":"mine","template":"   "}]']
    ])('rejects %s', (_label, raw) => {
        expect(parseStoredPrompts(raw)).toBeNull();
    });

    it('rejects an invalid outputTarget by dropping it rather than storing a bad value', () => {
        const parsed = parseStoredPrompts('[{"id":"summarize","outputTarget":"elsewhere"}]');

        expect(parsed).toEqual([{ id: 'summarize' }]);
    });

    it('drops a non-finite sortOrder', () => {
        expect(parseStoredPrompts('[{"id":"summarize","sortOrder":null}]')).toEqual([{ id: 'summarize' }]);
    });

    it('survives a round trip through export and import', () => {
        const original: StoredPrompt[] = [
            { id: 'summarize', enabled: false },
            { id: 'mine', name: 'Mine', template: 'do {{selection}}', outputTarget: 'comment', enabled: true, sortOrder: 6 }
        ];

        const reimported = parseStoredPrompts(JSON.stringify(original, null, 2));

        expect(reimported).toEqual(original);
        // And the resolved view is identical on both sides of the trip.
        expect(resolvePrompts(reimported ?? [])).toEqual(resolvePrompts(original));
    });
});
