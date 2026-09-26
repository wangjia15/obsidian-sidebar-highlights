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
    note: ['preview', 'append', 'new-markdown', 'new-html', 'highlights']
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
    /** See PromptPreset.mergeParts. */
    mergeParts?: boolean;
    /**
     * False ships the prompt switched off: useful, but specialised enough that
     * listing it in every menu by default would crowd out the common ones.
     */
    enabledByDefault?: boolean;
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
const MIRROR = 'Answer in the same language as the text you are given.';
const MIRROR_DOC = 'Answer in the same language as the document.';
/** Shared by every prompt that reads a paper: invented detail is the failure that costs a reader most. */
const GROUNDED = 'Base everything on the text provided. If something is not stated there, say so plainly instead of guessing, and never invent numbers, citations or results.';
/** Filled only when note context is enabled; the prompts are written to work without it. */
const CONTEXT_BLOCK = 'Surrounding text from the same note, for reference (may be empty):\n"""\n{{context}}\n"""';

const BUILTIN_PROMPT_DEFS: BuiltinPromptDef[] = [
    {
        id: 'summarize',
        icon: 'list',
        nameKey: 'ai.prompts.summarize',
        system: `You condense passages of academic papers and other texts for a reader's own notes. ${MIRROR} ${GROUNDED}`,
        template: 'Summarize the passage below in at most three bullet points. Lead with its main claim or finding; keep the author\'s terminology, and keep any key numbers (metrics, sizes, percentages) exactly. Output only the bullets.\n\n"""\n{{selection}}\n"""',
        outputTarget: 'both'
    },
    {
        id: 'explain',
        icon: 'lightbulb',
        nameKey: 'ai.prompts.explain',
        system: `You explain difficult passages — often from research papers — to a smart reader outside the field. ${MIRROR} ${GROUNDED}`,
        template: 'Explain the passage below.\n\n1. **In plain words** — what it says, in two or three sentences.\n2. **Key terms** — any jargon or acronym it relies on, one line each.\n3. **Why it matters** — what role this plays in the author\'s argument.\n4. **Example** — one concrete example, only if it genuinely helps.\n\nBe concise and skip any section that would be empty.\n\n"""\n{{selection}}\n"""\n\n' + CONTEXT_BLOCK,
        outputTarget: 'both'
    },
    {
        id: 'translate',
        icon: 'languages',
        nameKey: 'ai.prompts.translate',
        system: 'You are an academic translator. You output translations and nothing else.',
        template: 'Translate the following into {{targetLang}}, in a fluent academic register.\n\nRules:\n- Keep citation markers ([12], (Smith et al., 2020)), numbers, formulas, code and model/dataset names unchanged.\n- For each established technical term, give the translation followed by the original in parentheses the first time it appears, e.g. 注意力机制 (attention mechanism).\n- Output only the translation, with no commentary and no quotation marks.\n\n{{selection}}',
        outputTarget: 'both'
    },
    {
        id: 'terms',
        icon: 'book-open',
        nameKey: 'ai.prompts.terms',
        system: `You are a glossary writer for readers of research papers. ${MIRROR}`,
        template: 'List the technical terms, acronyms and named methods, models or datasets in the passage below that a reader might not know. For each, output one bullet: **term** (expansion if an acronym) — a one-sentence definition as the term is used here. Skip everyday words. If the passage defines a term itself, use its definition. Output only the list.\n\n"""\n{{selection}}\n"""\n\n' + CONTEXT_BLOCK,
        outputTarget: 'both'
    },
    {
        id: 'critique',
        icon: 'scale',
        nameKey: 'ai.prompts.critique',
        system: `You are a rigorous but fair peer reviewer. ${MIRROR} ${GROUNDED}`,
        template: 'Critically assess the claim or argument in the passage below.\n\n- **Claim** — what exactly is being asserted, in one sentence.\n- **Evidence** — what support the passage offers, and how strong it is.\n- **Assumptions** — what must hold for the claim to be true.\n- **Weaknesses** — gaps, confounds, overreach or alternative explanations.\n- **What would convince me** — the evidence or experiment that would settle it.\n\nKeep each point short and specific to this passage.\n\n"""\n{{selection}}\n"""\n\n' + CONTEXT_BLOCK,
        outputTarget: 'both'
    },
    {
        id: 'formula',
        icon: 'sigma',
        nameKey: 'ai.prompts.formula',
        system: `You explain mathematics in research papers step by step. ${MIRROR} ${GROUNDED}`,
        template: 'Explain the formula or mathematical passage below.\n\n1. **What it computes** — its purpose in one or two sentences.\n2. **Symbols** — each symbol and its meaning, as a list. Write math in LaTeX between $…$.\n3. **Intuition** — how the pieces combine and why the formula has this shape.\n4. **Edge cases** — what happens at extreme values, if that is informative.\n\nIf a symbol is not defined in the text given, say it is undefined rather than guessing.\n\n"""\n{{selection}}\n"""\n\n' + CONTEXT_BLOCK,
        outputTarget: 'both'
    },
    {
        id: 'results',
        icon: 'table',
        nameKey: 'ai.prompts.results',
        system: `You interpret experimental results in research papers. ${MIRROR} ${GROUNDED}`,
        template: 'Interpret the experimental results below (a results paragraph, table or ablation).\n\n- **Setup** — what is compared, on which data, with which metric (and whether higher or lower is better).\n- **Key numbers** — the most important results, quoted exactly.\n- **Takeaway** — what the results show, in one or two sentences.\n- **Caveats** — missing baselines, small margins, cherry-picked settings or anything else a careful reader should notice.\n\n"""\n{{selection}}\n"""\n\n' + CONTEXT_BLOCK,
        outputTarget: 'both'
    },
    {
        id: 'ask',
        icon: 'help-circle',
        nameKey: 'ai.prompts.ask',
        system: `You help a reader interrogate what they are reading. ${MIRROR}`,
        template: 'Read the passage below and pose the three questions most worth digging into — about its assumptions, its evidence, or how it connects to the rest of the work. Prefer questions the text does not already answer. Output only the questions, one per line.\n\n"""\n{{selection}}\n"""',
        outputTarget: 'both'
    },
    {
        id: 'ideas',
        icon: 'flask-conical',
        nameKey: 'ai.prompts.ideas',
        system: `You are a research mentor who turns reading into research ideas. ${MIRROR}`,
        template: 'Based on the passage below, suggest three concrete follow-up research ideas: extensions, applications to other settings, or experiments that would test its limits. For each, give a one-line idea and one sentence on why it is promising. Output only the three ideas as a numbered list.\n\n"""\n{{selection}}\n"""\n\n' + CONTEXT_BLOCK,
        outputTarget: 'both',
        enabledByDefault: false
    },
    {
        id: 'tags',
        icon: 'tags',
        nameKey: 'ai.prompts.tags',
        system: 'You label notes for retrieval.',
        template: 'Suggest three to five tags for the following, formatted as Obsidian tags: a leading #, lowercase, hyphens instead of spaces. Prefer topic, method and task names over generic words. Output only the tags on a single line, separated by spaces.\n\n{{selection}}',
        outputTarget: 'both'
    },
    {
        id: 'image-comment',
        icon: 'image',
        nameKey: 'ai.prompts.imageComment',
        // Only offered on image highlights (see isImageOnlyPrompt): the image
        // itself travels with the request, and {{selection}} names it.
        system: `You read figures, charts, tables and diagrams from research papers and other documents, and comment on them for a reader's notes. ${GROUNDED}`,
        template: 'Comment on the attached image for my notes.\n\n- **What it is** — the kind of figure (architecture diagram, plot, table, example…) and what it depicts.\n- **How to read it** — axes, legend, components or panels, briefly.\n- **Main point** — the finding or idea it conveys; quote key numbers or labels exactly as shown.\n- **Worth noticing** — anything surprising, subtle, or easy to miss.\n\nBe concise. Only describe what is visible; if text in the image is illegible, say so.\n\nImage: {{selection}}\nNote: {{noteTitle}}\n\n' + CONTEXT_BLOCK,
        outputTarget: 'both'
    },
    {
        id: 'note-summary',
        icon: 'scroll-text',
        nameKey: 'ai.prompts.noteSummary',
        scope: 'note',
        system: `You summarize a document for the person who wrote or collected it. ${MIRROR_DOC} ${GROUNDED}`,
        template: 'Summarize the note below.\n\nOpen with one sentence saying what it is about, then give the main points as bullets in the order the note makes them. Keep the author\'s own terminology and key numbers. Do not add anything the note does not say.\n\n# {{noteTitle}}\n\n{{note}}',
        outputTarget: 'preview',
        mergeParts: true
    },
    {
        id: 'paper-card',
        icon: 'file-text',
        nameKey: 'ai.prompts.paperCard',
        scope: 'note',
        system: `You write structured reading notes on research papers. ${MIRROR_DOC} ${GROUNDED}`,
        template: 'Write a reading card for the paper below, in Markdown, with exactly these sections:\n\n## TL;DR\nOne or two sentences.\n## Problem & motivation\nWhat problem it tackles and why existing approaches fall short.\n## Method\nThe core idea and the main components, as a short list.\n## Contributions\nWhat the authors claim is new, as a list.\n## Experiments\nDatasets, baselines and metrics.\n## Key results\nThe headline numbers, quoted exactly.\n## Limitations\nThose the authors state, and any that are evident but unstated (mark these as such).\n## Takeaways\nWhat is worth remembering or reusing.\n\nWrite "Not stated" for anything the paper does not cover.\n\n# {{noteTitle}}\n\n{{note}}',
        outputTarget: 'preview',
        mergeParts: true
    },
    {
        id: 'paper-review',
        icon: 'scale',
        nameKey: 'ai.prompts.paperReview',
        scope: 'note',
        system: `You are an experienced, fair and constructive peer reviewer. ${MIRROR_DOC} ${GROUNDED}`,
        template: 'Review the paper below as a reviewer for a top venue would, in Markdown:\n\n## Summary\nWhat the paper does, in a short paragraph.\n## Strengths\n## Weaknesses\nBe specific: point to the section, claim or experiment each concerns.\n## Questions for the authors\n## Missing experiments or comparisons\n## Overall assessment\nTwo or three sentences on significance, novelty and soundness.\n\n# {{noteTitle}}\n\n{{note}}',
        outputTarget: 'preview',
        mergeParts: true
    },
    {
        id: 'highlight-review',
        icon: 'highlighter',
        nameKey: 'ai.prompts.highlightReview',
        scope: 'note',
        system: `You help a reader consolidate what they marked while reading. ${MIRROR_DOC}`,
        template: 'Below are the passages I highlighted in this note, each followed by my own comments (indented), and then the note itself for context.\n\nWrite, in Markdown:\n## Key takeaways\nThe main ideas my highlights capture, grouped by theme — not one bullet per highlight.\n## How they connect\nThe relationships between the ideas.\n## Open questions\nQuestions my highlights and comments raise but do not answer.\n## Gaps\nImportant parts of the note I did not highlight, if any.\n\n# {{noteTitle}}\n\n## My highlights\n{{highlights}}\n\n## The note\n{{note}}',
        outputTarget: 'preview',
        mergeParts: true
    },
    {
        id: 'paper-quiz',
        icon: 'graduation-cap',
        nameKey: 'ai.prompts.paperQuiz',
        scope: 'note',
        system: `You write review questions that test real understanding, not recall of trivia. ${MIRROR_DOC} ${GROUNDED}`,
        template: 'Write 6 to 10 self-test questions about the note below, covering its core ideas, method, key results and limitations. Mix "why" and "how" questions with factual ones.\n\nFormat each as a collapsed Obsidian callout, exactly like this, with a blank line between questions:\n\n> [!question]- The question\n> The answer, in one to three sentences.\n\nOutput only the callouts.\n\n# {{noteTitle}}\n\n{{note}}',
        outputTarget: 'preview'
    },
    {
        id: 'reproduce',
        icon: 'list-checks',
        nameKey: 'ai.prompts.reproduce',
        scope: 'note',
        system: `You help researchers reproduce published work. ${MIRROR_DOC} ${GROUNDED}`,
        template: 'Extract a reproduction checklist from the paper below, in Markdown:\n\n## Resources\nCode, data and model links; licences if stated.\n## Data\nDatasets, splits, preprocessing.\n## Model & training\nArchitecture details, hyperparameters, optimizer, schedule, compute.\n## Evaluation\nMetrics and protocol.\n## Missing details\nWhat you would need to know to reproduce it that the paper does not say.\n\nUse "Not stated" wherever the paper is silent.\n\n# {{noteTitle}}\n\n{{note}}',
        outputTarget: 'preview',
        mergeParts: true,
        enabledByDefault: false
    },
    {
        id: 'related-work',
        icon: 'network',
        nameKey: 'ai.prompts.relatedWork',
        scope: 'note',
        system: `You map how a research paper positions itself against prior work. ${MIRROR_DOC} ${GROUNDED}`,
        template: 'From the paper below, map the prior work it discusses, in Markdown:\n\nGroup the works into lines of research. For each group, give a heading, then one bullet per work: the work (as the paper cites it) — what it does — how this paper differs from or builds on it. End with a short paragraph on the gap this paper claims to fill.\n\n# {{noteTitle}}\n\n{{note}}',
        outputTarget: 'preview',
        mergeParts: true,
        enabledByDefault: false
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
        template: 'Pick out the passages in the note below that are most worth highlighting — the claims, definitions and findings a reader would want to come back to.\n\nRules:\n- Copy each passage **exactly** as it appears, character for character. Do not paraphrase, translate, correct or re-punctuate it. If you cannot quote a passage verbatim, skip it; do not rewrite it.\n- One passage per line, with no numbering, no bullets, no quotation marks and no commentary.\n- Each passage must be a continuous run of text from a single line of the note.\n- Prefer a whole sentence or clause; never a single word.\n- At most 10 passages. Fewer is better than padding.\n\n# {{noteTitle}}\n\n{{note}}',
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

/** Prompts that only make sense with an image attached. */
const IMAGE_ONLY_PROMPT_IDS = new Set(['image-comment']);

export function isImageOnlyPrompt(prompt: Pick<PromptPreset, 'id'>): boolean {
    return IMAGE_ONLY_PROMPT_IDS.has(prompt.id);
}

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
        enabled: def.enabledByDefault ?? true,
        sortOrder,
        ...(def.mergeParts ? { mergeParts: true } : {})
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
