import { Platform } from 'obsidian';
import { t } from '../i18n';
import { PROVIDERS, isMissingRequiredKey, providerLabel, resolveProviderKind } from './registry';
import { AiError, type AiMessage, type AiProfile, type AiResult, type AiSettings, type ProviderKind } from './types';
import { AnthropicProvider } from './providers/anthropic';
import { GeminiProvider } from './providers/gemini';
import { OpenAiCompatibleProvider } from './providers/openai-compatible';
import { redact, toAiError, type Provider } from './providers/provider';

export interface CompleteOptions {
    /** Defaults to the active profile. */
    profile?: AiProfile;
    signal?: AbortSignal;
    temperature?: number;
    maxTokens?: number;
}

export interface StreamOptions extends CompleteOptions {
    /** Called with each piece of text as it arrives. */
    onDelta: (text: string) => void;
    /**
     * Called when a stream could not be started and the request is being retried
     * without streaming, so the caller can drop whatever partial text it drew.
     */
    onFallback?: () => void;
}

export interface ReadinessProblem {
    /** i18n key describing what the user still has to do. */
    reasonKey: string;
}

/**
 * Owns provider selection, request dispatch and error normalization. Holds no
 * DOM and no plugin reference — settings arrive through a getter so the
 * service always sees the live values without keeping a stale copy.
 */
export class AiService {
    private readonly providers: Record<ProviderKind, Provider>;

    constructor(private readonly getSettings: () => AiSettings) {
        this.providers = {
            'openai-compatible': new OpenAiCompatibleProvider(),
            'anthropic': new AnthropicProvider(),
            'gemini': new GeminiProvider()
        };
    }

    get settings(): AiSettings {
        return this.getSettings();
    }

    getActiveProfile(): AiProfile | null {
        const { profiles, activeProfileId } = this.settings;
        if (profiles.length === 0) return null;
        return profiles.find(profile => profile.id === activeProfileId) ?? profiles[0];
    }

    /**
     * Whether a request can be made right now. Returns the specific thing that
     * is missing so the UI can point at it, rather than a bare boolean.
     */
    checkReadiness(profile: AiProfile | null = this.getActiveProfile()): ReadinessProblem | null {
        if (!this.settings.enabled) return { reasonKey: 'ai.readiness.disabled' };
        if (!profile) return { reasonKey: 'ai.readiness.noProfile' };
        if (!profile.baseUrl.trim()) return { reasonKey: 'ai.readiness.noBaseUrl' };
        if (!profile.model.trim()) return { reasonKey: 'ai.readiness.noModel' };
        if (isMissingRequiredKey(profile)) return { reasonKey: 'ai.readiness.noApiKey' };
        return null;
    }

    isReady(): boolean {
        return this.checkReadiness() === null;
    }

    providerFor(profile: AiProfile): Provider {
        return this.providers[resolveProviderKind(profile)];
    }

    async complete(messages: AiMessage[], options: CompleteOptions = {}): Promise<AiResult> {
        const profile = options.profile ?? this.getActiveProfile();
        const problem = this.checkReadiness(profile);
        if (problem || !profile) {
            throw new AiError('bad-request', t(problem?.reasonKey ?? 'ai.readiness.noProfile'));
        }

        const signal = options.signal ?? new AbortController().signal;
        const provider = this.providerFor(profile);

        try {
            return await provider.complete(
                {
                    profile,
                    messages,
                    temperature: options.temperature,
                    maxTokens: options.maxTokens
                },
                signal,
                this.settings.requestTimeoutMs
            );
        } catch (error) {
            throw toAiError(error);
        }
    }

    /**
     * Whether a streamed request is even possible here.
     *
     * Mobile is excluded outright: the streaming path uses `fetch`, which is
     * subject to CORS in a WebView, and no provider here sends the headers that
     * would satisfy it. Falling back on every mobile request would work but
     * would double every call, so the check happens before the first attempt.
     */
    canStream(profile?: AiProfile | null): boolean {
        if (!this.settings.streaming) return false;
        if (Platform.isMobile) return false;
        // A capability probe, not a request; see httpStream for why the
        // streaming path uses fetch at all.
        if (typeof fetch !== 'function') return false;

        const target = profile ?? this.getActiveProfile();
        return target != null && this.providerFor(target).stream != null;
    }

    /**
     * Streams a completion, falling back to a normal request when the stream
     * cannot be established.
     *
     * The fallback is what makes streaming safe to enable by default on
     * desktop: a proxy that rejects the preflight, a provider that does not
     * implement SSE, or a corporate TLS interceptor all end up as one ordinary
     * request instead of an error. An abort is never retried — the user asked
     * for it to stop.
     */
    async stream(messages: AiMessage[], options: StreamOptions): Promise<AiResult> {
        const profile = options.profile ?? this.getActiveProfile();
        const problem = this.checkReadiness(profile);
        if (problem || !profile) {
            throw new AiError('bad-request', t(problem?.reasonKey ?? 'ai.readiness.noProfile'));
        }

        const signal = options.signal ?? new AbortController().signal;
        const provider = this.providerFor(profile);

        if (this.canStream(profile) && provider.stream) {
            try {
                return await provider.stream(
                    {
                        profile,
                        messages,
                        temperature: options.temperature,
                        maxTokens: options.maxTokens
                    },
                    { onDelta: options.onDelta },
                    signal,
                    this.settings.requestTimeoutMs
                );
            } catch (error) {
                const normalized = toAiError(error);
                // An abort and a refusal from the provider are both real
                // answers; only a transport failure is worth retrying.
                if (normalized.kind === 'aborted' || normalized.kind === 'auth' || normalized.kind === 'bad-request') {
                    throw normalized;
                }
                this.logSafeWarning('streaming failed, retrying without it', normalized);
                options.onFallback?.();
            }
        }

        return this.complete(messages, options);
    }

    private logSafeWarning(message: string, error: unknown): void {
        console.warn(`Sidebar Highlights: ${message}:`, logSafe(error));
    }

    /**
     * A minimal round trip used by the "Test connection" button. Kept
     * deliberately tiny — one token of output is enough to prove the key,
     * the URL and the model name all line up.
     */
    async testConnection(profile: AiProfile, signal?: AbortSignal): Promise<string> {
        const result = await this.complete(
            [{ role: 'user', content: 'Reply with the single word: ok' }],
            { profile, signal, maxTokens: 16 }
        );
        return result.model ?? profile.model;
    }

    async listModels(profile: AiProfile, signal?: AbortSignal): Promise<string[]> {
        const provider = this.providerFor(profile);
        if (!provider.listModels) {
            throw new AiError('bad-request', t('ai.errors.noModelList', { provider: providerLabel(profile) }));
        }
        try {
            return await provider.listModels(
                profile,
                signal ?? new AbortController().signal,
                this.settings.requestTimeoutMs
            );
        } catch (error) {
            throw toAiError(error);
        }
    }
}

/**
 * Turns an error into one line a user can act on. The UI only ever sees this —
 * raw provider bodies and anything key-shaped are filtered out upstream.
 */
export function describeAiError(error: unknown): string {
    const aiError = toAiError(error);
    const headline = t(`ai.errors.${aiError.kind}`);
    if (!aiError.detail) return headline;
    return `${headline} — ${aiError.detail}`;
}

/** Builds a profile pre-filled from its provider's registry entry. */
export function createProfileForProvider(providerId: AiProfile['providerId'], id: string): AiProfile {
    if (providerId === 'custom') {
        return {
            id,
            name: t('ai.profile.defaultName', { provider: 'Custom' }),
            providerId: 'custom',
            customKind: 'openai-compatible',
            baseUrl: '',
            apiKey: '',
            model: ''
        };
    }

    const descriptor = PROVIDERS[providerId];
    return {
        id,
        name: t('ai.profile.defaultName', { provider: descriptor.label }),
        providerId,
        baseUrl: descriptor.defaultBaseUrl,
        apiKey: '',
        model: descriptor.defaultModel
    };
}

/** Console-safe rendering of an error, for the few places we log one. */
export function logSafe(error: unknown): string {
    const aiError = toAiError(error);
    return redact(`${aiError.kind}: ${aiError.message}${aiError.detail ? ` (${aiError.detail})` : ''}`);
}
