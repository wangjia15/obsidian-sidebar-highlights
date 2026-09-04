import { i18n, t } from '../i18n';
import {
    PROMPT_VARIABLES,
    buildMessages,
    builtinPrompts,
    enabledPrompts,
    hasUserChanges,
    interpolate,
    isBuiltinPromptId,
    removeStoredPrompt,
    resolvePrompts,
    unknownVariables,
    upsertStoredPrompt,
    variablesUsed
} from './prompt-library';
import type { StoredPrompt } from './types';

beforeAll(async () => {
    await i18n.init();
});

describe('interpolate', () => {
    it('substitutes a known variable', () => {
        expect(interpolate('Summarize: {{selection}}', { selection: 'text' }).text).toBe('Summarize: text');
    });

    it('substitutes the same variable everywhere it appears', () => {
        expect(interpolate('{{selection}} / {{selection}}', { selection: 'x' }).text).toBe('x / x');
    });

    it('tolerates whitespace inside the braces', () => {
        expect(interpolate('{{  selection  }}', { selection: 'x' }).text).toBe('x');
    });

    it('leaves an unknown variable in place and reports it', () => {
        const result = interpolate('{{slection}} and {{selection}}', { selection: 'x' });

        expect(result.text).toBe('{{slection}} and x');
        expect(result.unknown).toEqual(['slection']);
    });

    it('reports a known variable that has no value, and substitutes nothing', () => {
        const result = interpolate('Note: {{note}}|', {});

        expect(result.text).toBe('Note: |');
        expect(result.missing).toEqual(['note']);
    });

    it('treats an empty string as missing rather than substituting a blank', () => {
        expect(interpolate('{{comments}}', { comments: '' }).missing).toEqual(['comments']);
    });

    it('does not rescan a substituted value, so quoted syntax cannot recurse', () => {
        // A highlight that quotes this very syntax must not expand a second time.
        const result = interpolate('{{selection}}', { selection: 'see {{selection}} and {{note}}', note: 'LEAK' });

        expect(result.text).toBe('see {{selection}} and {{note}}');
        expect(result.text).not.toContain('LEAK');
    });

    it('leaves single braces alone', () => {
        expect(interpolate('{selection} stays', { selection: 'x' }).text).toBe('{selection} stays');
    });

    it('reports each unknown variable once even when repeated', () => {
        expect(interpolate('{{foo}} {{foo}}', {}).unknown).toEqual(['foo']);
    });

    it('handles a template with no variables at all', () => {
        const result = interpolate('plain text', { selection: 'x' });

        expect(result.text).toBe('plain text');
        expect(result.unknown).toEqual([]);
        expect(result.missing).toEqual([]);
    });
});

describe('variablesUsed', () => {
    it('lists variables in first-appearance order without duplicates', () => {
        expect(variablesUsed('{{note}} {{selection}} {{note}}')).toEqual(['note', 'selection']);
    });

    it('separates unknown names from the recognized ones', () => {
        expect(unknownVariables('{{selection}} {{nope}}')).toEqual(['nope']);
    });
});

describe('builtin prompts', () => {
    it('ships the six presets the plan calls for', () => {
        expect(builtinPrompts().map(prompt => prompt.id)).toEqual([
            'summarize',
            'explain',
            'translate',
            'ask',
            'tags',
            'diagram'
        ]);
    });

    it('gives every builtin a translated name, an icon and a template', () => {
        for (const prompt of builtinPrompts()) {
            expect(prompt.name).not.toBe('');
            expect(prompt.name).not.toContain('ai.prompts.');
            expect(prompt.icon).toBeTruthy();
            expect(prompt.template.trim()).not.toBe('');
            expect(prompt.builtin).toBe(true);
            expect(prompt.enabled).toBe(true);
        }
    });

    it('references only known variables in every shipped template', () => {
        for (const prompt of builtinPrompts()) {
            expect(unknownVariables(prompt.template)).toEqual([]);
        }
    });

    it('passes the highlight to every builtin', () => {
        for (const prompt of builtinPrompts()) {
            expect(variablesUsed(prompt.template)).toContain('selection');
        }
    });

    it('asks the diagram prompt for exactly one mermaid block', () => {
        const diagram = builtinPrompts().find(prompt => prompt.id === 'diagram');

        // The sidebar renderer draws a fenced mermaid block and nothing else,
        // so the instruction and the renderer have to agree.
        expect(diagram?.template).toContain('```mermaid');
        expect(diagram?.system).toContain('one fenced mermaid code block');
    });

    it('makes the translate prompt depend on a target language', () => {
        const translate = builtinPrompts().find(prompt => prompt.id === 'translate');

        expect(variablesUsed(translate?.template ?? '')).toContain('targetLang');
    });
});

describe('resolvePrompts', () => {
    it('returns the shipped builtins when nothing is stored', () => {
        expect(resolvePrompts([]).map(prompt => prompt.id)).toEqual(builtinPrompts().map(prompt => prompt.id));
    });

    it('applies a one-field patch without freezing the rest of the builtin', () => {
        const shipped = builtinPrompts()[0];
        const resolved = resolvePrompts([{ id: 'summarize', enabled: false }]);
        const summarize = resolved.find(prompt => prompt.id === 'summarize');

        expect(summarize?.enabled).toBe(false);
        // The point of storing a patch: the template still tracks the shipped one.
        expect(summarize?.template).toBe(shipped.template);
        expect(summarize?.name).toBe(shipped.name);
    });

    it('lets a patch override the template when the user really did edit it', () => {
        const resolved = resolvePrompts([{ id: 'explain', template: 'mine: {{selection}}' }]);

        expect(resolved.find(prompt => prompt.id === 'explain')?.template).toBe('mine: {{selection}}');
    });

    it('ignores undefined fields in a patch rather than blanking the builtin', () => {
        const shipped = builtinPrompts().find(prompt => prompt.id === 'tags');
        const resolved = resolvePrompts([{ id: 'tags', template: undefined, name: undefined, enabled: false }]);
        const tags = resolved.find(prompt => prompt.id === 'tags');

        expect(tags?.template).toBe(shipped?.template);
        expect(tags?.name).toBe(shipped?.name);
        expect(tags?.enabled).toBe(false);
    });

    it('appends user prompts after the builtins', () => {
        const resolved = resolvePrompts([{ id: 'mine', name: 'Mine', template: '{{selection}}' }]);

        expect(resolved).toHaveLength(builtinPrompts().length + 1);
        expect(resolved[resolved.length - 1]).toMatchObject({ id: 'mine', builtin: false });
    });

    it('names an untitled user prompt rather than showing a blank menu row', () => {
        const resolved = resolvePrompts([{ id: 'mine', template: '{{selection}}' }]);

        expect(resolved.find(prompt => prompt.id === 'mine')?.name).toBe(t('ai.prompts.untitled'));
    });

    it('orders by sortOrder', () => {
        const resolved = resolvePrompts([
            { id: 'summarize', sortOrder: 99 },
            { id: 'mine', name: 'Mine', template: '{{selection}}', sortOrder: -1 }
        ]);

        expect(resolved[0].id).toBe('mine');
        expect(resolved[resolved.length - 1].id).toBe('summarize');
    });

    it('never marks a user prompt as builtin, whatever was stored', () => {
        const stored = [{ id: 'mine', name: 'Mine', template: '{{selection}}' }] as StoredPrompt[];

        expect(resolvePrompts(stored).find(prompt => prompt.id === 'mine')?.builtin).toBe(false);
    });
});

describe('enabledPrompts', () => {
    it('drops disabled prompts', () => {
        const ids = enabledPrompts([{ id: 'summarize', enabled: false }]).map(prompt => prompt.id);

        expect(ids).not.toContain('summarize');
        expect(ids).toContain('explain');
    });

    it('drops a prompt whose template was emptied, which would send nothing', () => {
        expect(enabledPrompts([{ id: 'explain', template: '   ' }]).map(prompt => prompt.id)).not.toContain('explain');
    });
});

describe('stored prompt list', () => {
    it('adds a patch that is not there yet', () => {
        expect(upsertStoredPrompt([], { id: 'summarize', enabled: false })).toEqual([{ id: 'summarize', enabled: false }]);
    });

    it('merges into an existing patch instead of replacing it wholesale', () => {
        const next = upsertStoredPrompt([{ id: 'summarize', enabled: false }], { id: 'summarize', name: 'Digest' });

        expect(next).toEqual([{ id: 'summarize', enabled: false, name: 'Digest' }]);
    });

    it('does not mutate the array it was given', () => {
        const original: StoredPrompt[] = [{ id: 'summarize', enabled: false }];
        upsertStoredPrompt(original, { id: 'explain', enabled: false });

        expect(original).toHaveLength(1);
    });

    it('reverts a builtin by removing its patch', () => {
        const stored = [{ id: 'summarize', template: 'mine' }];
        const reverted = removeStoredPrompt(stored, 'summarize');

        expect(reverted).toEqual([]);
        expect(resolvePrompts(reverted).find(prompt => prompt.id === 'summarize')?.template)
            .toBe(builtinPrompts()[0].template);
    });

    it('reports whether a builtin carries user changes', () => {
        expect(hasUserChanges([{ id: 'summarize', enabled: false }], 'summarize')).toBe(true);
        expect(hasUserChanges([], 'summarize')).toBe(false);
    });

    it('recognizes builtin ids', () => {
        expect(isBuiltinPromptId('diagram')).toBe(true);
        expect(isBuiltinPromptId('mine')).toBe(false);
        expect(isBuiltinPromptId('constructor')).toBe(false);
    });
});

describe('buildMessages', () => {
    const prompt = resolvePrompts([])[0];

    it('puts the system prompt first and the filled template second', () => {
        const { messages } = buildMessages(prompt, { selection: 'the text' });

        expect(messages[0].role).toBe('system');
        expect(messages[1].role).toBe('user');
        expect(messages[1].content).toContain('the text');
    });

    it('omits the system message when a prompt has none', () => {
        const { messages } = buildMessages({ ...prompt, system: '   ' }, { selection: 'x' });

        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('user');
    });

    it('hands back the interpolation report so the caller can warn', () => {
        const { interpolation } = buildMessages({ ...prompt, template: '{{nope}} {{selection}}' }, { selection: 'x' });

        expect(interpolation.unknown).toEqual(['nope']);
    });
});

describe('variable list', () => {
    it('covers every variable the builtin templates reference', () => {
        const used = new Set(builtinPrompts().flatMap(prompt => variablesUsed(prompt.template)));

        for (const name of used) {
            expect(PROMPT_VARIABLES).toContain(name);
        }
    });
});
