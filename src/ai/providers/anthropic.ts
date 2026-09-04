import { AiError, type AiProfile, type AiRequest, type AiResult } from '../types';
import { httpJson, httpStream, joinUrl, pick, pickNumber, pickString, requireText, type Provider, type StreamHandlers } from './provider';
import { parseEventData } from './sse';

const ANTHROPIC_VERSION = '2023-06-01';

/** `max_tokens` is required by the Messages API, so a request without one still needs a value. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Anthropic Messages API.
 *
 * Two things differ from the OpenAI shape and are easy to get wrong:
 *
 * 1. The system prompt is a top-level `system` field, not a message with
 *    `role: 'system'`. Sending it as a message is rejected.
 * 2. `max_tokens` is required, not optional.
 *
 * A third difference bites only the streaming path: calling this API from a
 * browser context needs the `anthropic-dangerous-direct-browser-access: true`
 * header or CORS blocks it. `requestUrl` is not a browser context and does not
 * need it, so `headers()` omits it and `stream()` — which does go through
 * `fetch`, a real browser context — adds it.
 */
export class AnthropicProvider implements Provider {
    readonly kind = 'anthropic';

    private headers(profile: AiProfile): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'x-api-key': profile.apiKey.trim(),
            'anthropic-version': ANTHROPIC_VERSION
        };
    }

    /** Shared so the streaming and non-streaming requests cannot drift apart. */
    private buildBody(request: AiRequest, stream: boolean): Record<string, unknown> {
        const { profile } = request;

        const systemParts = request.messages
            .filter(message => message.role === 'system')
            .map(message => message.content);
        const turns = request.messages
            .filter(message => message.role !== 'system')
            .map(message => ({ role: message.role, content: message.content }));

        if (turns.length === 0) {
            throw new AiError('bad-request', 'Request had no user message');
        }

        const temperature = request.temperature ?? profile.temperature;
        const body: Record<string, unknown> = {
            model: profile.model,
            max_tokens: request.maxTokens ?? profile.maxTokens ?? DEFAULT_MAX_TOKENS,
            messages: turns,
            stream
        };
        if (systemParts.length > 0) body.system = systemParts.join('\n\n');
        if (typeof temperature === 'number') body.temperature = temperature;

        return body;
    }

    async complete(request: AiRequest, signal: AbortSignal, timeoutMs: number): Promise<AiResult> {
        const { profile } = request;
        const body = this.buildBody(request, false);

        const { json } = await httpJson({
            url: joinUrl(profile.baseUrl, '/messages'),
            method: 'POST',
            headers: this.headers(profile),
            body,
            signal,
            timeoutMs
        });

        return {
            text: requireText(collectText(pick(json, 'content')), 'Anthropic'),
            model: pickString(json, 'model') ?? profile.model,
            usage: {
                promptTokens: pickNumber(json, 'usage', 'input_tokens'),
                completionTokens: pickNumber(json, 'usage', 'output_tokens')
            }
        };
    }

    async stream(
        request: AiRequest,
        handlers: StreamHandlers,
        signal: AbortSignal,
        timeoutMs: number
    ): Promise<AiResult> {
        const { profile } = request;
        let model = profile.model;
        const usage: { promptTokens?: number; completionTokens?: number } = {};

        const text = await httpStream({
            url: joinUrl(profile.baseUrl, '/messages'),
            headers: {
                ...this.headers(profile),
                // Required here and only here: `fetch` is a browser context, so
                // without this header CORS rejects the request outright.
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: this.buildBody(request, true),
            signal,
            timeoutMs,
            onEvent: event => {
                if (event.event === 'error') {
                    const json = parseEventData(event.data);
                    throw new AiError('server', pickString(json, 'error', 'message') ?? 'Anthropic reported an error');
                }

                const json = parseEventData(event.data);
                if (json === undefined) return undefined;

                if (event.event === 'message_start') {
                    model = pickString(json, 'message', 'model') ?? model;
                    usage.promptTokens = pickNumber(json, 'message', 'usage', 'input_tokens') ?? usage.promptTokens;
                    return undefined;
                }

                if (event.event === 'message_delta') {
                    usage.completionTokens = pickNumber(json, 'usage', 'output_tokens') ?? usage.completionTokens;
                    return undefined;
                }

                if (event.event !== 'content_block_delta') return undefined;

                // Thinking blocks stream through here too; only text deltas
                // carry the answer.
                const chunk = pickString(json, 'delta', 'text');
                if (!chunk) return undefined;

                handlers.onDelta(chunk);
                return chunk;
            }
        });

        return { text: requireText(text, 'Anthropic'), model, usage };
    }
}

/** Content is an array of blocks; only the text ones carry the answer. */
function collectText(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content
        .filter(block => pickString(block, 'type') === 'text')
        .map(block => pickString(block, 'text') ?? '')
        .join('');
}
