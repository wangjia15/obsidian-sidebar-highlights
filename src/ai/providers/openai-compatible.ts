import { AiError, type AiProfile, type AiRequest, type AiResult } from '../types';
import { httpJson, httpStream, joinUrl, pick, pickNumber, pickString, requireText, type Provider, type StreamHandlers } from './provider';
import { isDoneSentinel, parseEventData } from './sse';

/**
 * Chat Completions. Shared by OpenAI, DeepSeek, Moonshot, SiliconFlow,
 * OpenRouter, Ollama and LM Studio — six of the nine builtin providers plus
 * the default for custom endpoints.
 */
export class OpenAiCompatibleProvider implements Provider {
    readonly kind = 'openai-compatible';

    private headers(profile: AiProfile): Record<string, string> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const key = profile.apiKey.trim();
        if (key) {
            headers['Authorization'] = `Bearer ${key}`;
        }
        if (profile.providerId === 'openrouter') {
            // OpenRouter attributes requests by these; it rejects neither when
            // they are absent, but sending them keeps usage legible in its UI.
            headers['HTTP-Referer'] = 'https://github.com/trevware/obsidian-sidebar-highlights';
            headers['X-Title'] = 'Obsidian Sidebar Highlights';
        }
        return headers;
    }

    /** Shared so the streaming and non-streaming requests cannot drift apart. */
    private buildBody(request: AiRequest, stream: boolean): Record<string, unknown> {
        const { profile } = request;
        const temperature = request.temperature ?? profile.temperature;
        const maxTokens = request.maxTokens ?? profile.maxTokens;

        const body: Record<string, unknown> = {
            model: profile.model,
            messages: request.messages.map(message => ({ role: message.role, content: message.content })),
            stream
        };
        // Omitted rather than defaulted: reasoning models reject an explicit
        // temperature, and every provider here has a sane server-side default.
        if (typeof temperature === 'number') body.temperature = temperature;
        if (typeof maxTokens === 'number') body.max_tokens = maxTokens;

        if (stream) {
            // Without this the usage block never arrives on a streamed
            // response. Providers that do not know the option ignore it.
            body.stream_options = { include_usage: true };
        }

        return body;
    }

    async complete(request: AiRequest, signal: AbortSignal, timeoutMs: number): Promise<AiResult> {
        const { profile } = request;
        const body = this.buildBody(request, false);

        const { json } = await httpJson({
            url: joinUrl(profile.baseUrl, '/chat/completions'),
            method: 'POST',
            headers: this.headers(profile),
            body,
            signal,
            timeoutMs
        });

        const content = pick(json, 'choices', 0, 'message', 'content');
        const text = typeof content === 'string' ? content : flattenContentParts(content);

        return {
            text: requireText(text, 'The provider'),
            model: pickString(json, 'model') ?? profile.model,
            usage: {
                promptTokens: pickNumber(json, 'usage', 'prompt_tokens'),
                completionTokens: pickNumber(json, 'usage', 'completion_tokens')
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
            url: joinUrl(profile.baseUrl, '/chat/completions'),
            headers: this.headers(profile),
            body: this.buildBody(request, true),
            signal,
            timeoutMs,
            onEvent: event => {
                if (isDoneSentinel(event.data)) return undefined;

                const json = parseEventData(event.data);
                if (json === undefined) return undefined;

                // An error can arrive mid-stream, after a 200 has already been
                // sent, so the status code alone does not prove success.
                const message = pickString(json, 'error', 'message');
                if (message) throw new AiError('server', message);

                model = pickString(json, 'model') ?? model;
                usage.promptTokens = pickNumber(json, 'usage', 'prompt_tokens') ?? usage.promptTokens;
                usage.completionTokens = pickNumber(json, 'usage', 'completion_tokens') ?? usage.completionTokens;

                const delta = pick(json, 'choices', 0, 'delta', 'content');
                const chunk = typeof delta === 'string' ? delta : flattenContentParts(delta);
                if (!chunk) return undefined;

                handlers.onDelta(chunk);
                return chunk;
            }
        });

        return { text: requireText(text, 'The provider'), model, usage };
    }

    async listModels(profile: AiProfile, signal: AbortSignal, timeoutMs: number): Promise<string[]> {
        const { json } = await httpJson({
            url: joinUrl(profile.baseUrl, '/models'),
            method: 'GET',
            headers: this.headers(profile),
            signal,
            timeoutMs
        });

        const data = pick(json, 'data');
        if (!Array.isArray(data)) {
            throw new AiError('bad-request', 'Model list had an unexpected shape');
        }

        return data
            .map(entry => pickString(entry, 'id'))
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    }
}

/**
 * A few OpenAI-compatible servers answer with the newer array-of-parts content
 * shape instead of a plain string. Joining the text parts costs little and
 * turns an "empty response" error into a working call.
 */
function flattenContentParts(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content
        .map(part => (typeof part === 'string' ? part : pickString(part, 'text') ?? ''))
        .join('');
}
