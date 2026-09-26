import { Platform } from 'obsidian';
import { t } from '../i18n';
import { PROVIDERS, isMissingRequiredKey, providerLabel, resolveProviderKind } from './registry';
import { AiError, type AiMessage, type AiProfile, type AiResult, type AiSettings, type ProviderKind } from './types';
import { AnthropicProvider } from './providers/anthropic';
import { GeminiProvider } from './providers/gemini';
import { OpenAiCompatibleProvider } from './providers/openai-compatible';
import { redact, toAiError, type Provider } from './providers/provider';

/**
 * Output budget for the connection test: enough for a reasoning model's
 * preamble as well as the one word being asked for. See testConnection.
 */
const TEST_CONNECTION_MAX_TOKENS = 512;

export interface RetryEvent {
    /** One-based retry number. */
    attempt: number;
    delayMs: number;
}

export interface CompleteOptions {
    /** Announced before backoff, so Stop remains available while waiting. */
    onRetry?: (event: RetryEvent) => void;
    /** Defaults to the active profile. */
    profile?: AiProfile;
    signal?: AbortSignal;
    temperature?: number;
    maxTokens?: number;
    /** Force a fresh answer for regenerate and connection tests. */
    bypassCache?: boolean;
}

export interface StreamOptions extends CompleteOptions {
    /** Called with each piece of text as it arrives. */
    onDelta: (text: string) => void;
    /**
     * Called with a reasoning model's thinking while it is still thinking. It
     * is not part of the answer — see StreamHandlers.onReasoning — but showing
     * it is the difference between a slow request and an apparently dead one.
     */
    onReasoning?: (text: string) => void;
    /**
     * Called before the independent non-streaming fallback. No visible stream
     * output has been emitted; this transport switch does not consume a retry.
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
    private readonly cache = new Map<string, AiResult>();

    private cacheKey(messages: AiMessage[], profile: AiProfile, options: CompleteOptions): string {
        // Images are replaced by a fingerprint: a key holding every image's
        // base64 body would keep megabytes alive per cached answer.
        const keyed = messages.map(message => message.images?.length
            ? { ...message, images: message.images.map(image => `${image.mimeType}:${image.data.length}:${fingerprint(image.data)}`) }
            : message);
        return JSON.stringify([profile, keyed, options.temperature, options.maxTokens]);
    }

    private remember(key: string, result: AiResult): AiResult {
        if (result.text.trim()) {
            this.cache.delete(key);
            this.cache.set(key, { ...result, usage: undefined });
            while (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value as string);
        }
        return result;
    }

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
        if (signal.aborted) throw new AiError('aborted', 'Request cancelled');
        const key = this.cacheKey(messages, profile, options);
        const cached = options.bypassCache ? undefined : this.cache.get(key);
        if (cached) return { ...cached };

        try {
            const result = await this.withRetry(() => provider.complete(
                {
                    profile,
                    messages,
                    temperature: options.temperature,
                    maxTokens: options.maxTokens
                },
                signal,
                this.settings.requestTimeoutMs
            ), signal, options);
            if (signal.aborted) throw new AiError('aborted', 'Request cancelled');
            return this.remember(key, result);
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
        if (typeof window.fetch !== 'function') return false;

        const target = profile ?? this.getActiveProfile();
        return target != null && this.providerFor(target).stream != null;
    }

    /**
     * Tries streaming once, then falls back before any visible output unless
     * the error is a refusal or cancellation. The transport fallback is an
     * independent safety net, even with retries disabled; complete owns its
     * full retry budget. Visible output never triggers another request.
     */
    async stream(messages: AiMessage[], options: StreamOptions): Promise<AiResult> {
        const profile = options.profile ?? this.getActiveProfile();
        const problem = this.checkReadiness(profile);
        if (problem || !profile) {
            throw new AiError('bad-request', t(problem?.reasonKey ?? 'ai.readiness.noProfile'));
        }

        const signal = options.signal ?? new AbortController().signal;
        const provider = this.providerFor(profile);
        if (signal.aborted) throw new AiError('aborted', 'Request cancelled');
        const key = this.cacheKey(messages, profile, options);
        const cached = options.bypassCache ? undefined : this.cache.get(key);
        if (cached) {
            options.onDelta(cached.text);
            return { ...cached };
        }

        if (!this.canStream(profile) || !provider.stream) return this.complete(messages, options);

        let emitted = false;
        try {
            const result = await provider.stream({
                profile, messages, temperature: options.temperature, maxTokens: options.maxTokens
            }, {
                onDelta: text => {
                    if (text) emitted = true;
                    options.onDelta(text);
                },
                onReasoning: text => {
                    // Thinking is visible too: repeating it is not safe.
                    if (text && options.onReasoning) emitted = true;
                    options.onReasoning?.(text);
                }
            }, signal, this.settings.requestTimeoutMs);
            if (signal.aborted) throw new AiError('aborted', 'Request cancelled');
            return this.remember(key, result);
        } catch (error) {
            if (signal.aborted) throw new AiError('aborted', 'Request cancelled');
            const normalized = toAiError(error);
            if (emitted || normalized.kind === 'auth' || normalized.kind === 'bad-request'
                || normalized.kind === 'quota' || normalized.kind === 'aborted') {
                throw normalized;
            }
            options.onFallback?.();
        }
        return this.complete(messages, { ...options, profile });
    }

    /** Retrying a non-streaming request; transport fallback is independent. */
    private async withRetry(
        send: () => Promise<AiResult>,
        signal: AbortSignal,
        options: CompleteOptions
    ): Promise<AiResult> {
        const configured = this.settings.maxRetries ?? 2;
        const maxRetries = Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 2;
        let retries = 0;
        for (;;) {
            if (signal.aborted) throw new AiError('aborted', 'Request cancelled');
            try {
                const result = await send();
                if (signal.aborted) throw new AiError('aborted', 'Request cancelled');
                return result;
            } catch (error) {
                if (signal.aborted) throw new AiError('aborted', 'Request cancelled');
                const normalized = toAiError(error);
                if (!normalized.retriable || retries >= maxRetries) {
                    throw new AiError(normalized.kind, normalized.message, {
                        status: normalized.status, detail: normalized.detail,
                        retriable: normalized.retriable, retryAfterMs: normalized.retryAfterMs,
                        retries: retries > 0 ? retries : undefined
                    });
                }
                const retryAfter = normalized.retryAfterMs;
                const delayMs = Math.min(30000,
                    retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0
                        ? retryAfter
                        : Math.round(1000 * 2 ** Math.min(retries, 30) * (0.5 + Math.random())));
                options.onRetry?.({ attempt: retries + 1, delayMs });
                await waitForRetry(delayMs, signal);
                retries++;
            }
        }
    }

    /**
     * A minimal round trip used by the "Test connection" button. What it has to
     * prove is that the key, the URL and the model name all line up — the
     * answer's content is beside the point.
     *
     * The budget is nonetheless not as tiny as that invites. A reasoning model
     * spends output tokens thinking before it says anything, so a cap of a
     * dozen or so is consumed entirely by the reasoning trace: the provider
     * answers 200 with `finish_reason: "length"` and an empty message, the
     * response parser rightly refuses an empty answer, and the button reports a
     * failed connection for a connection that plainly worked. Room for a short
     * thought and one word costs a fraction of a cent and removes that whole
     * class of false failure.
     */
    async testConnection(profile: AiProfile, signal?: AbortSignal): Promise<string> {
        const result = await this.complete(
            [{ role: 'user', content: 'Reply with the single word: ok' }],
            { profile, signal, maxTokens: TEST_CONNECTION_MAX_TOKENS, bypassCache: true }
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
    const message = aiError.detail ? `${headline} — ${aiError.detail}` : headline;
    return aiError.kind === 'aborted' || !aiError.retries ? message : `${message} — ${t('ai.errors.retried', { count: aiError.retries })}`;
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

/** FNV-1a over a string. Only used to tell cached images apart, not for security. */
function fingerprint(text: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}

/** Cancels backoff immediately and releases both timer and abort listener. */
function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new AiError('aborted', 'Request cancelled'));
            return;
        }
        const onAbort = () => {
            window.clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(new AiError('aborted', 'Request cancelled'));
        };
        const timer = window.setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
