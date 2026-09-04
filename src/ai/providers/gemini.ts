import { AiError, type AiProfile, type AiRequest, type AiResult } from '../types';
import { httpJson, httpStream, joinUrl, pick, pickNumber, pickString, requireText, type Provider, type StreamHandlers } from './provider';
import { parseEventData } from './sse';

/**
 * Google Gemini `generateContent`.
 *
 * The model is part of the path rather than the body, the assistant role is
 * called `model`, and the system prompt goes in `systemInstruction`. A blocked
 * prompt comes back as HTTP 200 with no candidates, so that case is checked
 * explicitly — otherwise it would surface as a bare "empty response".
 */
export class GeminiProvider implements Provider {
    readonly kind = 'gemini';

    private headers(profile: AiProfile): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'x-goog-api-key': profile.apiKey.trim()
        };
    }

    /** Shared so the streaming and non-streaming requests cannot drift apart. */
    private buildBody(request: AiRequest): Record<string, unknown> {
        const { profile } = request;

        const systemParts = request.messages
            .filter(message => message.role === 'system')
            .map(message => message.content);
        const contents = request.messages
            .filter(message => message.role !== 'system')
            .map(message => ({
                role: message.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: message.content }]
            }));

        if (contents.length === 0) {
            throw new AiError('bad-request', 'Request had no user message');
        }

        const temperature = request.temperature ?? profile.temperature;
        const maxTokens = request.maxTokens ?? profile.maxTokens;
        const generationConfig: Record<string, unknown> = {};
        if (typeof temperature === 'number') generationConfig.temperature = temperature;
        if (typeof maxTokens === 'number') generationConfig.maxOutputTokens = maxTokens;

        const body: Record<string, unknown> = { contents };
        if (systemParts.length > 0) {
            body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
        }
        if (Object.keys(generationConfig).length > 0) {
            body.generationConfig = generationConfig;
        }

        return body;
    }

    async complete(request: AiRequest, signal: AbortSignal, timeoutMs: number): Promise<AiResult> {
        const { profile } = request;
        const body = this.buildBody(request);

        const { json } = await httpJson({
            url: joinUrl(profile.baseUrl, `/models/${encodeURIComponent(profile.model)}:generateContent`),
            method: 'POST',
            headers: this.headers(profile),
            body,
            signal,
            timeoutMs
        });

        const blockReason = pickString(json, 'promptFeedback', 'blockReason');
        if (blockReason) {
            throw new AiError('bad-request', 'Gemini blocked this prompt', { detail: blockReason });
        }

        const parts = pick(json, 'candidates', 0, 'content', 'parts');
        const text = Array.isArray(parts)
            ? parts.map(part => pickString(part, 'text') ?? '').join('')
            : '';

        // A truncated-by-safety answer has a finishReason worth surfacing.
        const finishReason = pickString(json, 'candidates', 0, 'finishReason');
        if (!text.trim() && finishReason && finishReason !== 'STOP') {
            throw new AiError('bad-request', 'Gemini returned no text', { detail: finishReason });
        }

        return {
            text: requireText(text, 'Gemini'),
            model: pickString(json, 'modelVersion') ?? profile.model,
            usage: {
                promptTokens: pickNumber(json, 'usageMetadata', 'promptTokenCount'),
                completionTokens: pickNumber(json, 'usageMetadata', 'candidatesTokenCount')
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
            // `alt=sse` is what makes this an event stream; without it Gemini
            // streams a JSON array, which the SSE parser cannot read.
            url: joinUrl(
                profile.baseUrl,
                `/models/${encodeURIComponent(profile.model)}:streamGenerateContent?alt=sse`
            ),
            headers: this.headers(profile),
            body: this.buildBody(request),
            signal,
            timeoutMs,
            onEvent: event => {
                const json = parseEventData(event.data);
                if (json === undefined) return undefined;

                const blockReason = pickString(json, 'promptFeedback', 'blockReason');
                if (blockReason) {
                    throw new AiError('bad-request', 'Gemini blocked this prompt', { detail: blockReason });
                }

                model = pickString(json, 'modelVersion') ?? model;
                usage.promptTokens = pickNumber(json, 'usageMetadata', 'promptTokenCount') ?? usage.promptTokens;
                usage.completionTokens =
                    pickNumber(json, 'usageMetadata', 'candidatesTokenCount') ?? usage.completionTokens;

                const parts = pick(json, 'candidates', 0, 'content', 'parts');
                const chunk = Array.isArray(parts)
                    ? parts.map(part => pickString(part, 'text') ?? '').join('')
                    : '';
                if (!chunk) return undefined;

                handlers.onDelta(chunk);
                return chunk;
            }
        });

        return { text: requireText(text, 'Gemini'), model, usage };
    }

    async listModels(profile: AiProfile, signal: AbortSignal, timeoutMs: number): Promise<string[]> {
        const { json } = await httpJson({
            url: joinUrl(profile.baseUrl, '/models'),
            method: 'GET',
            headers: this.headers(profile),
            signal,
            timeoutMs
        });

        const models = pick(json, 'models');
        if (!Array.isArray(models)) {
            throw new AiError('bad-request', 'Model list had an unexpected shape');
        }

        return models
            .map(entry => pickString(entry, 'name'))
            .filter((name): name is string => Boolean(name))
            // Names come back fully qualified as "models/gemini-2.0-flash".
            .map(name => name.replace(/^models\//, ''))
            .sort((a, b) => a.localeCompare(b));
    }
}
