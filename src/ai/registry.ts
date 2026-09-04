import type { BuiltinProviderId, ProviderKind, AiProfile } from './types';

export interface ProviderDescriptor {
    id: BuiltinProviderId;
    /** Shown in the provider dropdown. Product names are not translated. */
    label: string;
    kind: ProviderKind;
    defaultBaseUrl: string;
    defaultModel: string;
    /** Offered as datalist suggestions; the model field stays free text. */
    suggestedModels: string[];
    requiresKey: boolean;
    /** Where the user gets a key, linked from the settings tab. */
    apiKeyUrl?: string;
}

/**
 * Base URLs are stored without a trailing slash and *with* the version segment
 * the provider's own docs use, so what the user sees here matches what they
 * copy from those docs.
 */
export const PROVIDERS: Record<BuiltinProviderId, ProviderDescriptor> = {
    openai: {
        id: 'openai',
        label: 'OpenAI',
        kind: 'openai-compatible',
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        suggestedModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
        requiresKey: true,
        apiKeyUrl: 'https://platform.openai.com/api-keys'
    },
    anthropic: {
        id: 'anthropic',
        label: 'Anthropic',
        kind: 'anthropic',
        defaultBaseUrl: 'https://api.anthropic.com/v1',
        defaultModel: 'claude-sonnet-5',
        suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        requiresKey: true,
        apiKeyUrl: 'https://console.anthropic.com/settings/keys'
    },
    gemini: {
        id: 'gemini',
        label: 'Google Gemini',
        kind: 'gemini',
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        defaultModel: 'gemini-2.0-flash',
        suggestedModels: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro'],
        requiresKey: true,
        apiKeyUrl: 'https://aistudio.google.com/app/apikey'
    },
    deepseek: {
        id: 'deepseek',
        label: 'DeepSeek',
        kind: 'openai-compatible',
        defaultBaseUrl: 'https://api.deepseek.com/v1',
        defaultModel: 'deepseek-chat',
        suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
        requiresKey: true,
        apiKeyUrl: 'https://platform.deepseek.com/api_keys'
    },
    moonshot: {
        id: 'moonshot',
        label: 'Moonshot',
        kind: 'openai-compatible',
        defaultBaseUrl: 'https://api.moonshot.cn/v1',
        defaultModel: 'moonshot-v1-8k',
        suggestedModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
        requiresKey: true,
        apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys'
    },
    siliconflow: {
        id: 'siliconflow',
        label: 'SiliconFlow',
        kind: 'openai-compatible',
        defaultBaseUrl: 'https://api.siliconflow.cn/v1',
        defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
        suggestedModels: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
        requiresKey: true,
        apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak'
    },
    openrouter: {
        id: 'openrouter',
        label: 'OpenRouter',
        kind: 'openai-compatible',
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'openai/gpt-4o-mini',
        suggestedModels: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-5', 'google/gemini-2.0-flash-001'],
        requiresKey: true,
        apiKeyUrl: 'https://openrouter.ai/keys'
    },
    ollama: {
        id: 'ollama',
        label: 'Ollama',
        kind: 'openai-compatible',
        defaultBaseUrl: 'http://localhost:11434/v1',
        defaultModel: 'llama3.2',
        suggestedModels: ['llama3.2', 'qwen2.5', 'mistral'],
        requiresKey: false
    },
    lmstudio: {
        id: 'lmstudio',
        label: 'LM Studio',
        kind: 'openai-compatible',
        defaultBaseUrl: 'http://localhost:1234/v1',
        defaultModel: 'local-model',
        suggestedModels: ['local-model'],
        requiresKey: false
    }
};

export const PROVIDER_ORDER: BuiltinProviderId[] = [
    'openai',
    'anthropic',
    'gemini',
    'deepseek',
    'moonshot',
    'siliconflow',
    'openrouter',
    'ollama',
    'lmstudio'
];

export function isBuiltinProvider(id: string): id is BuiltinProviderId {
    return PROVIDER_ORDER.includes(id as BuiltinProviderId);
}

/**
 * A custom profile carries its own wire format; a builtin one reads it from
 * the registry so a registry correction reaches profiles already saved.
 */
export function resolveProviderKind(profile: AiProfile): ProviderKind {
    if (profile.providerId === 'custom') {
        return profile.customKind ?? 'openai-compatible';
    }
    return PROVIDERS[profile.providerId].kind;
}

export function providerLabel(profile: AiProfile): string {
    if (profile.providerId === 'custom') return 'Custom';
    return PROVIDERS[profile.providerId].label;
}

/** True when the profile's provider needs a key and none has been entered. */
export function isMissingRequiredKey(profile: AiProfile): boolean {
    if (profile.apiKey.trim()) return false;
    if (profile.providerId === 'custom') return false;
    return PROVIDERS[profile.providerId].requiresKey;
}
