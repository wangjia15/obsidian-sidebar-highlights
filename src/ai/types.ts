/**
 * Shared types for the AI layer.
 *
 * Nothing in `src/ai/` may import from the views or renderers: the dependency
 * direction is views -> renderers -> ai -> obsidian, which keeps this layer
 * unit-testable without a DOM.
 */

/** Providers we ship a default configuration for. */
export type BuiltinProviderId =
    | 'openai'
    | 'anthropic'
    | 'gemini'
    | 'deepseek'
    | 'moonshot'
    | 'siliconflow'
    | 'openrouter'
    | 'ollama'
    | 'lmstudio';

export type ProviderId = BuiltinProviderId | 'custom';

/**
 * The wire format a profile speaks. Six of the nine builtin providers are
 * OpenAI-compatible and share a single implementation; only Anthropic and
 * Gemini need their own.
 */
export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini';

export interface AiProfile {
    id: string;
    /** User-facing name, e.g. "DeepSeek 主力". */
    name: string;
    providerId: ProviderId;
    /**
     * Wire format for `providerId: 'custom'`. Ignored for builtin providers,
     * whose kind comes from the registry so that a future registry fix reaches
     * existing profiles.
     */
    customKind?: ProviderKind;
    baseUrl: string;
    /** Stored in plain text in data.json — see the warning in the settings tab. */
    apiKey: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
}

export interface AiMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface AiRequest {
    profile: AiProfile;
    messages: AiMessage[];
    /** Overrides the profile value when present. */
    temperature?: number;
    maxTokens?: number;
}

export interface AiUsage {
    promptTokens?: number;
    completionTokens?: number;
}

export interface AiResult {
    text: string;
    model?: string;
    usage?: AiUsage;
}

/**
 * Every provider failure is normalized to one of these before it reaches the
 * UI, so the UI never has to pattern-match on a provider's raw error body.
 */
export type AiErrorKind =
    | 'auth'
    | 'rate-limit'
    | 'quota'
    | 'network'
    | 'timeout'
    | 'bad-request'
    | 'server'
    | 'aborted'
    | 'unknown';

export class AiError extends Error {
    readonly kind: AiErrorKind;
    readonly status?: number;
    readonly retriable: boolean;
    /** Provider-supplied detail, already stripped of anything key-shaped. */
    readonly detail?: string;

    constructor(kind: AiErrorKind, message: string, options: { status?: number; retriable?: boolean; detail?: string } = {}) {
        super(message);
        this.name = 'AiError';
        this.kind = kind;
        this.status = options.status;
        this.retriable = options.retriable ?? (kind === 'rate-limit' || kind === 'server' || kind === 'network' || kind === 'timeout');
        this.detail = options.detail;
    }
}

/**
 * What a prompt runs on.
 *
 * `highlight` prompts act on one highlight (or on each in turn, for a batch)
 * and are reached from a card, the editor's context menu and the palette.
 * `note` prompts act on the whole document and are reached from the sidebar
 * toolbar. The scope decides which variables resolve and which output targets
 * make sense, so it is one field rather than an inference from the template.
 */
export type PromptScope = 'highlight' | 'note';

/**
 * Where a preset's output is allowed to go.
 *
 * `preview`, `comment` and `both` belong to highlight prompts. Note prompts can
 * write back, mark passages, or create a Markdown/HTML document. The prompt
 * editor only offers the targets its scope can use.
 */
export type PromptOutputTarget =
    | 'preview'
    | 'comment'
    | 'both'
    | 'append'
    | 'highlights'
    | 'new-markdown'
    | 'new-html';

/** A prompt as the rest of the plugin sees it: every field resolved. */
export interface PromptPreset {
    id: string;
    name: string;
    /** lucide icon name. */
    icon?: string;
    system?: string;
    /** User message template, may contain {{variable}} placeholders. */
    template: string;
    /** Builtin presets cannot be deleted, only disabled or overridden. */
    builtin: boolean;
    scope: PromptScope;
    outputTarget: PromptOutputTarget;
    enabled: boolean;
    sortOrder: number;
}

/**
 * What actually goes in data.json.
 *
 * For a builtin id this is a *patch*, not a copy: disabling a builtin stores
 * only `{ id, enabled: false }`, so later improvements to that builtin's
 * wording still reach the user. Storing a full copy would silently freeze the
 * template at whatever version happened to be installed when they flipped the
 * toggle. Deleting the patch restores the shipped prompt.
 *
 * For any other id it is a complete user-authored prompt.
 */
export interface StoredPrompt {
    id: string;
    name?: string;
    icon?: string;
    system?: string;
    template?: string;
    scope?: PromptScope;
    outputTarget?: PromptOutputTarget;
    enabled?: boolean;
    sortOrder?: number;
}

export interface AiSettings {
    /** Master switch. False means the plugin makes no network calls at all. */
    enabled: boolean;
    profiles: AiProfile[];
    activeProfileId: string | null;
    /** Only user-added prompts and patches over builtins; see StoredPrompt. */
    prompts: StoredPrompt[];
    defaultTargetLanguage: string;
    /** Upper bound on note text injected as context. */
    contextCharLimit: number;
    /**
     * Upper bound on the note text a whole-note prompt sends.
     *
     * Separate from `contextCharLimit`, and much larger, because the two answer
     * different questions: that one is "how much surrounding context may a
     * highlight prompt borrow", this one is "how much of the document may the
     * document prompt see". Summarising a note from its first 4,000 characters
     * would be summarising its opening.
     */
    noteCharLimit: number;
    /** Default false: send only the highlight itself, not the whole note. */
    includeNoteContext: boolean;
    includeExistingComments: boolean;
    /** Show the "this will be sent to <url>" confirmation before the first send. */
    confirmBeforeSend: boolean;
    /** Desktop only; falls back to a non-streaming retry when fetch fails. */
    streaming: boolean;
    requestTimeoutMs: number;
    /**
     * Colour written into the note for a highlight the model picked out, as a
     * hex value. Empty writes plain `==text==`, like any other highlight.
     *
     * Worth having its own colour: a passage a model chose and one the reader
     * chose are not the same claim, and the sidebar's colour filter is then
     * enough to tell them apart.
     */
    extractedHighlightColor: string;
    /** Rich (block-level) rendering of comments, including mermaid. */
    renderRichContent: boolean;
    renderMermaid: boolean;
    /** Max height in px for a diagram rendered inline in the sidebar. */
    maxDiagramHeight: number;
    /** Local-only call and token totals; never sent anywhere. */
    usage: AiUsageTotals;
}

/**
 * Running totals for the current month.
 *
 * Deliberately not a per-call log: a history of every prompt would be a record
 * of what the user has been reading and thinking about, sitting in plain text
 * in the vault. Totals answer "am I using this a lot?" without keeping that.
 */
export interface AiUsageTotals {
    /** `YYYY-MM` the totals below cover; a new month resets them. */
    month: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
}

export const EMPTY_AI_USAGE: AiUsageTotals = {
    month: '',
    calls: 0,
    promptTokens: 0,
    completionTokens: 0
};

/** The month key used to decide when totals roll over. */
export function usageMonth(date: Date = new Date()): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Folds one result into the running totals, rolling over at a month boundary.
 * Pure, so the rollover rule is testable without a plugin or a clock.
 */
export function addUsage(totals: AiUsageTotals, usage: AiUsage | undefined, month: string): AiUsageTotals {
    const base = totals.month === month ? totals : { ...EMPTY_AI_USAGE, month };
    return {
        month,
        calls: base.calls + 1,
        promptTokens: base.promptTokens + (usage?.promptTokens ?? 0),
        completionTokens: base.completionTokens + (usage?.completionTokens ?? 0)
    };
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
    enabled: false,
    profiles: [],
    activeProfileId: null,
    prompts: [],
    defaultTargetLanguage: '',
    contextCharLimit: 4000,
    // Enough for a long note in one request without being a bill by accident;
    // longer notes are split into requests at natural document boundaries.
    noteCharLimit: 24000,
    includeNoteContext: false,
    includeExistingComments: false,
    confirmBeforeSend: true,
    // On, because the fallback makes it safe to be: a stream that cannot be
    // established becomes one ordinary request. Off, every answer arrives as a
    // single blob after a silent wait, which reads as the plugin being slow.
    streaming: true,
    requestTimeoutMs: 60000,
    // Plain `==text==`, the same as a highlight made by hand. Opting into a
    // colour is a decision about the note's own markup, so it is the user's.
    extractedHighlightColor: '',
    renderRichContent: true,
    renderMermaid: true,
    maxDiagramHeight: 320,
    usage: EMPTY_AI_USAGE
};

/** Deep copy, so a profile edit can never mutate the module-level defaults. */
export function cloneAiSettings(source: AiSettings): AiSettings {
    return {
        ...source,
        profiles: source.profiles.map(profile => ({ ...profile })),
        prompts: source.prompts.map(prompt => ({ ...prompt })),
        usage: { ...source.usage }
    };
}
