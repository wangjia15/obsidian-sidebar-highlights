import { t } from '../i18n';
import type { PromptOutputTarget, PromptPreset, PromptScope, StoredPrompt } from './types';

/**
 * The variables a template may reference. Anything else is left in the text
 * verbatim and reported, so a typo shows up in the editor instead of silently
 * sending `{{slection}}` to the model.
 */
export const PROMPT_VARIABLES = [
    'selection',
    'comments',
    'note',
    'context',
    'noteTitle',
    'filePath',
    'tags',
    'collection',
    'targetLang',
    'input',
    'highlights'
] as const;

export type PromptVariableName = typeof PROMPT_VARIABLES[number];

export type PromptVariables = Partial<Record<PromptVariableName, string>>;

/**
 * The variables each scope can actually fill.
 *
 * A note prompt has no highlight, so `{{selection}}` and `{{context}}` would
 * resolve to nothing; a highlight prompt has no list of the note's highlights.
 * Stating it here lets the editor grey out what a template cannot use instead
 * of leaving the user to find out from an empty answer.
 */
const SCOPE_VARIABLES: Record<PromptScope, readonly PromptVariableName[]> = {
    highlight: ['selection', 'comments', 'note', 'context', 'noteTitle', 'filePath', 'tags', 'collection', 'targetLang', 'input'],
    note: ['note', 'noteTitle', 'filePath', 'highlights', 'targetLang', 'input']
};

export function variablesForScope(scope: PromptScope): readonly PromptVariableName[] {
    return SCOPE_VARIABLES[scope];
}

/** The output targets a scope can use; see PromptOutputTarget. */
const SCOPE_OUTPUT_TARGETS: Record<PromptScope, readonly PromptOutputTarget[]> = {
    highlight: ['both', 'preview', 'comment'],
    note: ['preview', 'append', 'highlights']
};

export function outputTargetsFor(scope: PromptScope): readonly PromptOutputTarget[] {
    return SCOPE_OUTPUT_TARGETS[scope];
}

/** Every target any scope allows, for validating what a stored prompt names. */
const OUTPUT_TARGETS = new Set<PromptOutputTarget>([
    ...SCOPE_OUTPUT_TARGETS.highlight,
    ...SCOPE_OUTPUT_TARGETS.note
]);

/** The target to fall back to when a stored one does not belong to the scope. */
export function defaultOutputTarget(scope: PromptScope): PromptOutputTarget {
    return SCOPE_OUTPUT_TARGETS[scope][0];
}

/**
 * The variable a scope's templates are built around, and whose absence is worth
 * warning about in the editor.
 */
export function primaryVariable(scope: PromptScope): PromptVariableName {
    return scope === 'note' ? 'note' : 'selection';
}

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

interface BuiltinPromptDef {
    id: string;
    icon: string;
    /** Display names are translated; the templates themselves are not — see below. */
    nameKey: string;
    system: string;
    template: string;
    scope?: PromptScope;
    outputTarget: PromptOutputTarget;
}

/**
 * Builtin prompts.
 *
 * Templates are written in English and tell the model to answer in the
 * language of the input, rather than being translated per locale. That keeps
 * one source of truth for wording that has to be tuned against real model
 * behaviour, and it means a Chinese highlight still gets a Chinese answer from
 * an English-locale install. Only the display names are localized, because
 * those are chrome rather than instructions.
 */
const BUILTIN_PROMPT_DEFS: BuiltinPromptDef[] = [
    {
        id: 'summarize',
        icon: 'list',
        nameKey: 'ai.prompts.summarize',
        system: 'You condense text for a reader\'s own notes. Answer in the same language as the text you are given.',
        template: 'Summarize the following in at most three bullet points, keeping the author\'s own terminology. Output only the bullets.\n\n{{selection}}',
        outputTarget: 'both'
    },
    {
        id: 'explain',
        icon: 'lightbulb',
        nameKey: 'ai.prompts.explain',
        system: 'You explain difficult passages plainly. Answer in the same language as the text you are given.',
        template: 'Explain the following for someone meeting it for the first time. Use plain language, and add one concrete example if it earns its place.\n\n{{selection}}',
        outputTarget: 'both'
    },
    {
        id: 'translate',
        icon: 'languages',
        nameKey: 'ai.prompts.translate',
        system: 'You are a translator. You output translations and nothing else.',
        template: 'Translate the following into {{targetLang}}. Output only the translation, with no commentary and no quotation marks.\n\n{{selection}}',
        outputTarget: 'both'
    },
    {
        id: 'ask',
        icon: 'help-circle',
        nameKey: 'ai.prompts.ask',
        system: 'You help a reader interrogate what they are reading. Answer in the same language as the text you are given.',
        template: 'Read the following and pose the three questions most worth digging into. Output only the questions, one per line.\n\n{{selection}}',
        outputTarget: 'both'
    },
    {
        id: 'tags',
        icon: 'tags',
        nameKey: 'ai.prompts.tags',
        system: 'You label notes for retrieval.',
        template: 'Suggest three to five tags for the following, formatted as Obsidian tags: a leading #, lowercase, hyphens instead of spaces. Output only the tags on a single line, separated by spaces.\n\n{{selection}}',
        outputTarget: 'both'
    },
    {
        id: 'note-summary',
        icon: 'scroll-text',
        nameKey: 'ai.prompts.noteSummary',
        scope: 'note',
        system: 'You summarize a document for the person who wrote or collected it. Answer in the same language as the document.',
        template: 'Summarize the note below.\n\nOpen with one sentence saying what it is about, then give the main points as bullets in the order the note makes them. Keep the author\'s own terminology. Do not add anything the note does not say.\n\n# {{noteTitle}}\n\n{{note}}',
        outputTarget: 'preview'
    },
    {
        id: 'note-extract',
        icon: 'highlighter',
        nameKey: 'ai.prompts.noteExtract',
        scope: 'note',
        // The one preset whose output shape the code depends on: each line is
        // matched back against the note, so anything but bare quotes fails to
        // find its passage. See utils/passage-marker.ts.
        system: 'You select passages to highlight. You quote the document verbatim and output nothing else.',
        template: 'Pick out the passages in the note below that are most worth highlighting — the claims, definitions and findings a reader would want to come back to.\n\nRules:\n- Copy each passage **exactly** as it appears, character for character. Do not paraphrase, translate, correct or re-punctuate it.\n- One passage per line, with no numbering, no bullets, no quotation marks and no commentary.\n- Each passage must be a continuous run of text from a single line of the note.\n- Prefer a whole sentence or clause; never a single word.\n- At most 10 passages. Fewer is better than padding.\n\n# {{noteTitle}}\n\n{{note}}',
        outputTarget: 'highlights'
    },
    {
        id: 'note-outline',
        icon: 'list-tree',
        nameKey: 'ai.prompts.noteOutline',
        scope: 'note',
        system: 'You outline documents. Answer in the same language as the document.',
        template: 'Write an outline of the note below as a nested markdown list: each section, and under it the points it makes. Output only the list.\n\n# {{noteTitle}}\n\n{{note}}',
        outputTarget: 'append'
    },
    {
        id: 'diagram',
        icon: 'workflow',
        nameKey: 'ai.prompts.diagram',
        // The one preset whose output shape matters to the renderer: a single
        // fenced mermaid block is what the sidebar's rich renderer can draw.
        system: 'You draw Mermaid diagrams. You output exactly one fenced mermaid code block and nothing else.',
        template: 'Draw the process or the relationships described below as a Mermaid diagram.\n\nOutput exactly one ```mermaid fenced code block, with no explanation before or after it. Use `flowchart TD` unless another diagram type genuinely fits better. Keep node labels short, and wrap any label containing punctuation in double quotes.\n\n{{selection}}',
        outputTarget: 'both'
    }
];

const BUILTIN_IDS = new Set(BUILTIN_PROMPT_DEFS.map(def => def.id));

export function isBuiltinPromptId(id: string): boolean {
    return BUILTIN_IDS.has(id);
}

/** The shipped form of a builtin, before any user patch is applied. */
export function builtinPrompt(def: BuiltinPromptDef, sortOrder: number): PromptPreset {
    return {
        id: def.id,
        name: t(def.nameKey),
        icon: def.icon,
        system: def.system,
        template: def.template,
        builtin: true,
        scope: def.scope ?? 'highlight',
        outputTarget: def.outputTarget,
        enabled: true,
        sortOrder
    };
}

export function builtinPrompts(): PromptPreset[] {
    return BUILTIN_PROMPT_DEFS.map((def, index) => builtinPrompt(def, index));
}

/**
 * Drops keys explicitly set to undefined so they do not blank out a builtin's
 * value, and never carries `id` through — spreading this over a builtin must
 * not be able to change which prompt it is. Written field by field rather than
 * by iterating, so the types survive and `id` is excluded structurally.
 */
function definedOnly(patch: StoredPrompt): Omit<StoredPrompt, 'id'> {
    const result: Omit<StoredPrompt, 'id'> = {};
    if (patch.name !== undefined) result.name = patch.name;
    if (patch.icon !== undefined) result.icon = patch.icon;
    if (patch.system !== undefined) result.system = patch.system;
    if (patch.template !== undefined) result.template = patch.template;
    if (patch.scope !== undefined) result.scope = patch.scope;
    if (patch.outputTarget !== undefined) result.outputTarget = patch.outputTarget;
    if (patch.enabled !== undefined) result.enabled = patch.enabled;
    if (patch.sortOrder !== undefined) result.sortOrder = patch.sortOrder;
    return result;
}

/**
 * Keeps a resolved prompt's scope and target consistent.
 *
 * A stored prompt can name a target its scope cannot use — an import, a
 * hand-edited data.json, or a prompt whose scope was switched — and running one
 * would mean writing a comment for a note that has no highlight to hang it on.
 * The scope wins, since that is what the menus dispatch on.
 */
function withValidTarget(prompt: PromptPreset): PromptPreset {
    return outputTargetsFor(prompt.scope).includes(prompt.outputTarget)
        ? prompt
        : { ...prompt, outputTarget: defaultOutputTarget(prompt.scope) };
}

/**
 * Merges the shipped builtins with what the user has stored.
 *
 * A stored entry whose id matches a builtin patches that builtin; any other
 * entry is a user-authored prompt. The result is always sorted the way the
 * menus should list it.
 */
export function resolvePrompts(stored: StoredPrompt[]): PromptPreset[] {
    const patches = new Map<string, StoredPrompt>();
    for (const entry of stored) {
        if (isBuiltinPromptId(entry.id)) patches.set(entry.id, entry);
    }

    const resolved: PromptPreset[] = BUILTIN_PROMPT_DEFS.map((def, index) => {
        const base = builtinPrompt(def, index);
        const patch = patches.get(def.id);
        return patch
            ? withValidTarget({ ...base, ...definedOnly(patch), id: def.id, builtin: true })
            : base;
    });

    let nextOrder = BUILTIN_PROMPT_DEFS.length;
    for (const entry of stored) {
        if (isBuiltinPromptId(entry.id)) continue;
        // Prompts stored before whole-note prompts existed have no scope, and
        // every one of them was written against a highlight.
        const scope = entry.scope ?? 'highlight';
        resolved.push(withValidTarget({
            id: entry.id,
            name: entry.name ?? t('ai.prompts.untitled'),
            icon: entry.icon,
            system: entry.system,
            template: entry.template ?? '',
            builtin: false,
            scope,
            outputTarget: entry.outputTarget ?? defaultOutputTarget(scope),
            enabled: entry.enabled ?? true,
            sortOrder: entry.sortOrder ?? nextOrder++
        }));
    }

    return resolved.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export function enabledPrompts(stored: StoredPrompt[]): PromptPreset[] {
    return resolvePrompts(stored).filter(prompt => prompt.enabled && prompt.template.trim() !== '');
}

/** The enabled prompts of one scope, which is what each menu actually lists. */
export function enabledPromptsForScope(stored: StoredPrompt[], scope: PromptScope): PromptPreset[] {
    return enabledPrompts(stored).filter(prompt => prompt.scope === scope);
}

/**
 * Writes a patch into the stored list, replacing any existing entry for that
 * id. Returns a new array rather than mutating, so callers can assign and save.
 */
export function upsertStoredPrompt(stored: StoredPrompt[], patch: StoredPrompt): StoredPrompt[] {
    const index = stored.findIndex(entry => entry.id === patch.id);
    if (index === -1) return [...stored, patch];
    const next = [...stored];
    next[index] = { ...next[index], ...patch };
    return next;
}

/**
 * Removes a user prompt, or reverts a builtin to its shipped form — both are
 * the same operation on the stored list, which is the point of storing patches.
 */
export function removeStoredPrompt(stored: StoredPrompt[], id: string): StoredPrompt[] {
    return stored.filter(entry => entry.id !== id);
}

export function hasUserChanges(stored: StoredPrompt[], id: string): boolean {
    return stored.some(entry => entry.id === id);
}

export interface InterpolationResult {
    text: string;
    /** Placeholders we do not recognize; left in the text verbatim. */
    unknown: string[];
    /** Recognized placeholders with no value available; replaced with nothing. */
    missing: string[];
}

/**
 * Substitutes {{variables}} in a template.
 *
 * A single pass, so a value that itself contains `{{selection}}` is not
 * re-scanned — otherwise a highlight quoting this very syntax would expand
 * again and could recurse.
 */
export function interpolate(template: string, variables: PromptVariables): InterpolationResult {
    const unknown = new Set<string>();
    const missing = new Set<string>();
    const known = new Set<string>(PROMPT_VARIABLES);

    const text = template.replace(VARIABLE_PATTERN, (match, rawName: string) => {
        if (!known.has(rawName)) {
            unknown.add(rawName);
            return match;
        }
        const value = variables[rawName as PromptVariableName];
        if (value === undefined || value === '') {
            missing.add(rawName);
            return '';
        }
        return value;
    });

    return { text, unknown: [...unknown], missing: [...missing] };
}

/** The variables a template actually references, in the order they first appear. */
export function variablesUsed(template: string): string[] {
    const found: string[] = [];
    for (const match of template.matchAll(VARIABLE_PATTERN)) {
        if (!found.includes(match[1])) found.push(match[1]);
    }
    return found;
}

export function unknownVariables(template: string): string[] {
    const known = new Set<string>(PROMPT_VARIABLES);
    return variablesUsed(template).filter(name => !known.has(name));
}

/**
 * Variables the template uses that its scope cannot fill — spelled correctly,
 * but reaching for something that is not there. `{{selection}}` in a whole-note
 * prompt is the case worth catching: it is what a highlight prompt looks like,
 * and it would resolve to nothing without any error at all.
 */
export function outOfScopeVariables(template: string, scope: PromptScope): string[] {
    const known = new Set<string>(PROMPT_VARIABLES);
    const usable = new Set<string>(variablesForScope(scope));
    return variablesUsed(template).filter(name => known.has(name) && !usable.has(name));
}

/** Builds the messages for one run of a prompt. */
export function buildMessages(prompt: PromptPreset, variables: PromptVariables): {
    messages: { role: 'system' | 'user'; content: string }[];
    interpolation: InterpolationResult;
} {
    const interpolation = interpolate(prompt.template, variables);
    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (prompt.system?.trim()) {
        messages.push({ role: 'system', content: prompt.system.trim() });
    }
    messages.push({ role: 'user', content: interpolation.text.trim() });
    return { messages, interpolation };
}

/**
 * Validates pasted JSON down to the fields we understand, dropping anything
 * else. Returns null when the payload is not a prompt list at all.
 */
export function parseStoredPrompts(raw: string): StoredPrompt[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!Array.isArray(parsed)) return null;

    const result: StoredPrompt[] = [];
    for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) return null;
        const record = entry as Record<string, unknown>;
        if (typeof record.id !== 'string' || !record.id.trim()) return null;

        const prompt: StoredPrompt = { id: record.id };
        if (typeof record.name === 'string') prompt.name = record.name;
        if (typeof record.icon === 'string') prompt.icon = record.icon;
        if (typeof record.system === 'string') prompt.system = record.system;
        if (typeof record.template === 'string') prompt.template = record.template;
        if (record.scope === 'highlight' || record.scope === 'note') prompt.scope = record.scope;
        if (OUTPUT_TARGETS.has(record.outputTarget as PromptOutputTarget)) {
            prompt.outputTarget = record.outputTarget as PromptOutputTarget;
        }
        if (typeof record.enabled === 'boolean') prompt.enabled = record.enabled;
        if (typeof record.sortOrder === 'number' && Number.isFinite(record.sortOrder)) {
            prompt.sortOrder = record.sortOrder;
        }

        // A non-builtin entry with no template would resolve to an unusable
        // prompt, so reject the payload rather than import something broken.
        if (!isBuiltinPromptId(prompt.id) && !prompt.template?.trim()) return null;

        result.push(prompt);
    }

    return result;
}
