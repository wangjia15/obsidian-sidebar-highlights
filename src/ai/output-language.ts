import type { AiMessage, AiSettings, PromptPreset } from './types';

/**
 * Which language an answer should be written in.
 *
 * `ui` follows the language Obsidian is displayed in, `source` leaves the
 * builtin prompts' "answer in the language of the text" alone, and `custom`
 * names a language outright.
 */
export type OutputLanguageMode = 'ui' | 'source' | 'custom';

/**
 * Resolves the language to answer in, or undefined to leave the prompt as
 * written. A per-run override always wins.
 */
export function resolveOutputLanguage(
    settings: Pick<AiSettings, 'outputLanguageMode' | 'customOutputLanguage'>,
    uiLanguage: string,
    override?: string
): string | undefined {
    const explicit = override?.trim();
    if (explicit) return explicit;

    switch (settings.outputLanguageMode) {
        case 'source':
            return undefined;
        case 'custom':
            return settings.customOutputLanguage.trim() || uiLanguage;
        default:
            return uiLanguage;
    }
}

/**
 * Whether a prompt's output language is already decided by the prompt itself.
 *
 * A translation names its own target through {{targetLang}}, and extracted
 * passages must be quoted verbatim — forcing a language onto either would
 * break what the prompt is for.
 */
export function promptFixesItsOwnLanguage(prompt: Pick<PromptPreset, 'template' | 'outputTarget'>): boolean {
    return prompt.outputTarget === 'highlights' || prompt.template.includes('{{targetLang}}');
}

/**
 * The builtin prompts tell the model to mirror the input's language. Left in
 * place next to an output-language rule, the two contradict each other, and
 * models — reasoning models especially — tend to side with the sentence that
 * describes the text in front of them. So it is removed rather than overruled.
 */
const MIRROR_LANGUAGE = /\s*Answer in the same language as the (?:text|document)(?: you are given)?\.?/gi;

function isChinese(language: string): boolean {
    return /中文|汉语|漢語|chinese|^zh\b/i.test(language);
}

/**
 * Makes the model answer in `language`.
 *
 * Stated twice on purpose: once in the system prompt, and once as the last
 * line of the final user turn. Many OpenAI-compatible models (DeepSeek's
 * reasoner among them) give the system prompt little weight, and an English
 * template wrapped around English source text otherwise wins — which is how a
 * Chinese reader ends up with an English answer.
 */
export function applyOutputLanguage(messages: AiMessage[], language: string): void {
    const instruction = `Always write your answer in ${language}, whatever language the source text is in. Keep verbatim quotations, code and proper nouns unchanged.`;

    const system = messages.find(message => message.role === 'system');
    if (system) {
        system.content = `${system.content.replace(MIRROR_LANGUAGE, '').trim()}\n\n${instruction}`;
    } else {
        messages.unshift({ role: 'system', content: instruction });
    }

    const lastUser = [...messages].reverse().find(message => message.role === 'user');
    if (lastUser) {
        const reminder = isChinese(language)
            ? `请使用${language}回答。`
            : `Answer in ${language}.`;
        lastUser.content = `${lastUser.content.trimEnd()}\n\n${reminder}`;
    }
}
