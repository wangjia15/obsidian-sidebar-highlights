import { requestUrl } from 'obsidian';
import { AiError, type AiErrorKind, type AiProfile, type AiRequest, type AiResult } from '../types';
import { SseParser, type SseEvent } from './sse';

export interface Provider {
    readonly kind: string;
    complete(request: AiRequest, signal: AbortSignal, timeoutMs: number): Promise<AiResult>;
    /**
     * Optional: the same request, delivered incrementally. Desktop only, and
     * every caller must be able to fall back to `complete`.
     */
    stream?(
        request: AiRequest,
        handlers: StreamHandlers,
        signal: AbortSignal,
        timeoutMs: number
    ): Promise<AiResult>;
    /** Optional: populates the model suggestions in the profile editor. */
    listModels?(profile: AiProfile, signal: AbortSignal, timeoutMs: number): Promise<string[]>;
}

export interface HttpCall {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: unknown;
    signal: AbortSignal;
    timeoutMs: number;
}

export interface HttpResult {
    status: number;
    text: string;
    json: unknown;
}

/** Strips a trailing slash so callers can always join with a leading one. */
export function joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Anything that looks like a credential, replaced before a string can reach a
 * console or a Notice. Provider error bodies echo request material often
 * enough that scrubbing the body is worth the few regexes.
 */
export function redact(input: string): string {
    return input
        .replace(/\b(sk|xai|gsk|api|key)[-_][A-Za-z0-9_-]{8,}/gi, '$1-***')
        .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, match => `${match.slice(0, 4)}***`);
}

/** Trims a provider error body to something a Notice can carry. */
function summarizeBody(text: string): string | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;

    let message = trimmed;
    try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const error = parsed.error;
        if (typeof error === 'string') {
            message = error;
        } else if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
            message = (error as Record<string, unknown>).message as string;
        } else if (typeof parsed.message === 'string') {
            message = parsed.message;
        }
    } catch {
        // Not JSON — fall through and use the raw text.
    }

    const flattened = message.replace(/\s+/g, ' ').trim();
    const capped = flattened.length > 300 ? `${flattened.slice(0, 300)}…` : flattened;
    return redact(capped);
}

export function kindForStatus(status: number): AiErrorKind {
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate-limit';
    if (status === 402) return 'quota';
    if (status === 408 || status === 504) return 'timeout';
    if (status >= 500) return 'server';
    if (status >= 400) return 'bad-request';
    return 'unknown';
}

/** Accept delta seconds or an HTTP date; ignore malformed headers. */
function retryAfterDelay(value?: string | null): number | undefined {
    if (!value?.trim()) return undefined;
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        const ms = Number(trimmed) * 1000;
        return Number.isFinite(ms) ? ms : undefined;
    }
    // Date.parse accepts odd strings such as "-1" as dates; require the HTTP
    // date's time and timezone so an invalid delta never becomes a delay.
    if (!/\d{2}:\d{2}:\d{2}\s+GMT$/i.test(trimmed)) return undefined;
    const date = Date.parse(trimmed);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function errorForStatus(status: number, bodyText: string, retryAfter?: string | null): AiError {
    const kind = kindForStatus(status);
    return new AiError(kind, `HTTP ${status}`, { status, detail: summarizeBody(bodyText), retryAfterMs: retryAfterDelay(retryAfter) });
}

/**
 * Wraps `requestUrl` with abort and timeout support.
 *
 * `requestUrl` is deliberate rather than `fetch`: it bypasses CORS, behaves
 * identically on desktop and mobile, and needs no per-provider browser-access
 * header. What it does not do is stream, and it takes no AbortSignal — so an
 * abort here stops us waiting on the response, it does not cancel the request
 * already in flight. Streaming lives behind its own desktop-only path.
 */
export async function httpJson(call: HttpCall): Promise<HttpResult> {
    if (call.signal.aborted) {
        throw new AiError('aborted', 'Request aborted');
    }

    let timer: number | undefined;
    let onAbort: (() => void) | undefined;

    const guard = new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(() => {
            reject(new AiError('timeout', `Request timed out after ${Math.round(call.timeoutMs / 1000)}s`));
        }, call.timeoutMs);

        onAbort = () => reject(new AiError('aborted', 'Request aborted'));
        call.signal.addEventListener('abort', onAbort, { once: true });
    });

    const send = requestUrl({
        url: call.url,
        method: call.method,
        headers: call.headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        throw: false
    });

    try {
        const response = await Promise.race([send, guard]);
        const text = response.text ?? '';

        if (response.status < 200 || response.status >= 300) {
            const retryAfter = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
            throw errorForStatus(response.status, text, retryAfter);
        }

        let json: unknown = undefined;
        try {
            json = text ? JSON.parse(text) : undefined;
        } catch {
            throw new AiError('bad-request', 'Provider returned a non-JSON response', {
                status: response.status,
                detail: summarizeBody(text)
            });
        }

        return { status: response.status, text, json };
    } catch (error) {
        throw toAiError(error);
    } finally {
        if (timer !== undefined) window.clearTimeout(timer);
        if (onAbort) call.signal.removeEventListener('abort', onAbort);
        // Keep an in-flight request that lost the race from surfacing as an
        // unhandled rejection once it finally settles.
        void send.catch(() => undefined);
    }
}

/**
 * Normalizes anything thrown below this layer into an AiError. Network stacks
 * report failures as opaque strings, so the message is all we have to go on.
 */
export function toAiError(error: unknown): AiError {
    if (error instanceof AiError) return error;

    if (error instanceof Error) {
        const message = error.message || '';
        if (error.name === 'AbortError') {
            return new AiError('aborted', 'Request aborted');
        }
        if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ERR_NAME_NOT_RESOLVED|Failed to fetch|fetch failed|NetworkError|Load failed|net::/i.test(message)) {
            return new AiError('network', redact(message));
        }
        if (/timeout|ETIMEDOUT/i.test(message)) {
            return new AiError('timeout', redact(message));
        }
        if (/certificate|SSL|TLS/i.test(message)) {
            return new AiError('network', redact(message));
        }
        return new AiError('unknown', redact(message));
    }

    return new AiError('unknown', redact(String(error)));
}

/** Reads `a.b.c` off an unknown JSON value without casting at every call site. */
export function pick(value: unknown, ...path: (string | number)[]): unknown {
    let current: unknown = value;
    for (const key of path) {
        if (current === null || typeof current !== 'object') return undefined;
        current = (current as Record<string | number, unknown>)[key];
    }
    return current;
}

export function pickString(value: unknown, ...path: (string | number)[]): string | undefined {
    const found = pick(value, ...path);
    return typeof found === 'string' ? found : undefined;
}

export function pickNumber(value: unknown, ...path: (string | number)[]): number | undefined {
    const found = pick(value, ...path);
    return typeof found === 'number' ? found : undefined;
}

/** Providers must never return an empty completion silently. */
export function requireText(text: string | undefined, providerLabel: string): string {
    const trimmed = (text ?? '').trim();
    if (!trimmed) {
        throw new AiError('unknown', `${providerLabel} returned an empty response`);
    }
    return trimmed;
}

/**
 * How a caller watches a stream: text as it arrives, plus whatever usage the
 * provider reports along the way.
 */
export interface StreamHandlers {
    onDelta(text: string): void;
    /**
     * A reasoning model's thinking, when the provider streams it separately
     * from the answer. It can run for minutes before the first word of the
     * answer arrives, so a UI that ignores it looks like it has hung. Never
     * part of the result: it is shown while waiting and then replaced.
     */
    onReasoning?(text: string): void;
}

export interface StreamCall {
    url: string;
    headers: Record<string, string>;
    body: unknown;
    signal: AbortSignal;
    timeoutMs: number;
    /** Called for each complete SSE event; returns text to append, if any. */
    onEvent(event: SseEvent): string | undefined;
}

/**
 * Streams a response with native `fetch`.
 *
 * `requestUrl` cannot do this — it resolves once, with the whole body — so the
 * streaming path gives up its CORS immunity in exchange for incremental text.
 * That trade is why streaming is desktop-only and why every caller must be able
 * to fall back: on mobile, or behind a proxy that rejects the preflight, this
 * throws and the non-streaming path has to take over.
 *
 * The timeout here bounds silence, not total duration: a long answer that keeps
 * producing tokens is healthy, while a stream that stops sending is not.
 */
export async function httpStream(call: StreamCall): Promise<string> {
    if (call.signal.aborted) {
        throw new AiError('aborted', 'Request aborted');
    }

    const controller = new AbortController();
    const abortStream = () => controller.abort();
    call.signal.addEventListener('abort', abortStream, { once: true });

    let idleTimer: number | undefined;
    let timedOut = false;
    const resetIdleTimer = () => {
        if (idleTimer !== undefined) window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, call.timeoutMs);
    };

    try {
        resetIdleTimer();

        // Streaming is desktop-only; requestUrl is the non-streaming fallback.
        const response = await window.fetch(call.url, {
            method: 'POST',
            headers: { ...call.headers, Accept: 'text/event-stream' },
            body: JSON.stringify(call.body),
            signal: controller.signal
        });

        if (!response.ok) {
            throw errorForStatus(response.status, await response.text().catch(() => ''), response.headers?.get('retry-after'));
        }
        if (!response.body) {
            throw new AiError('network', 'The provider returned no response body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        let text = '';

        const consume = (events: SseEvent[]) => {
            for (const event of events) {
                const delta = call.onEvent(event);
                if (delta) text += delta;
            }
        };

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            resetIdleTimer();
            // `stream: true` keeps a multi-byte character split across two
            // network reads from decoding as two replacement characters.
            consume(parser.push(decoder.decode(value, { stream: true })));
        }

        consume(parser.push(decoder.decode()));
        consume(parser.flush());

        return text;
    } catch (error) {
        if (timedOut) {
            throw new AiError('timeout', `The stream stalled for more than ${Math.round(call.timeoutMs / 1000)}s`);
        }
        throw toAiError(error);
    } finally {
        if (idleTimer !== undefined) window.clearTimeout(idleTimer);
        call.signal.removeEventListener('abort', abortStream);
    }
}
