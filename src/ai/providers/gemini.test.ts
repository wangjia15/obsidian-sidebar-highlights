import { GeminiProvider } from './gemini';
import type { AiProfile } from '../types';
import { lastRequest, lastRequestBody, resetRequests, respondWith as respond } from '../test-support';

function profile(overrides: Partial<AiProfile> = {}): AiProfile {
    return {
        id: 'p1',
        name: 'Gemini',
        providerId: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'test-key',
        model: 'gemini-2.0-flash',
        ...overrides
    };
}


const okBody = {
    modelVersion: 'gemini-2.0-flash',
    candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 }
};

describe('GeminiProvider', () => {
    const provider = new GeminiProvider();
    const signal = new AbortController().signal;

    beforeEach(() => {
        resetRequests();
    });

    it('puts the model in the URL path and the key in a header', async () => {
        respond(200, okBody);

        await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hi' }] }, signal, 1000);

        expect(lastRequest().url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
        );
        expect(lastRequest().headers?.['x-goog-api-key']).toBe('test-key');
    });

    it('escapes a model name that would otherwise break the path', async () => {
        respond(200, okBody);

        await provider.complete(
            { profile: profile({ model: 'tuned/my model' }), messages: [{ role: 'user', content: 'hi' }] },
            signal,
            1000
        );

        expect(lastRequest().url).toContain('/models/tuned%2Fmy%20model:generateContent');
    });

    it('renames the assistant role to model', async () => {
        respond(200, okBody);

        await provider.complete(
            {
                profile: profile(),
                messages: [
                    { role: 'user', content: 'first' },
                    { role: 'assistant', content: 'reply' },
                    { role: 'user', content: 'second' }
                ]
            },
            signal,
            1000
        );

        expect(lastRequestBody().contents).toEqual([
            { role: 'user', parts: [{ text: 'first' }] },
            { role: 'model', parts: [{ text: 'reply' }] },
            { role: 'user', parts: [{ text: 'second' }] }
        ]);
    });

    it('sends the system prompt as systemInstruction', async () => {
        respond(200, okBody);

        await provider.complete(
            {
                profile: profile(),
                messages: [
                    { role: 'system', content: 'be brief' },
                    { role: 'user', content: 'hi' }
                ]
            },
            signal,
            1000
        );

        expect(lastRequestBody().systemInstruction).toEqual({ parts: [{ text: 'be brief' }] });
    });

    it('omits generationConfig entirely when nothing is configured', async () => {
        respond(200, okBody);

        await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hi' }] }, signal, 1000);

        expect(lastRequestBody()).not.toHaveProperty('generationConfig');
    });

    it('maps max tokens onto maxOutputTokens', async () => {
        respond(200, okBody);

        await provider.complete(
            { profile: profile({ maxTokens: 256, temperature: 0.2 }), messages: [{ role: 'user', content: 'hi' }] },
            signal,
            1000
        );

        expect(lastRequestBody().generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 256 });
    });

    it('reports a blocked prompt instead of an empty response', async () => {
        // A blocked prompt comes back as HTTP 200 with no candidates, so this
        // would otherwise surface as a bare "empty response".
        respond(200, { promptFeedback: { blockReason: 'SAFETY' } });

        await expect(
            provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hi' }] }, signal, 1000)
        ).rejects.toMatchObject({ kind: 'bad-request', detail: 'SAFETY' });
    });

    it('surfaces a non-STOP finish reason when no text came back', async () => {
        respond(200, { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] });

        await expect(
            provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hi' }] }, signal, 1000)
        ).rejects.toMatchObject({ detail: 'MAX_TOKENS' });
    });

    it('maps Gemini token counts onto the shared usage shape', async () => {
        respond(200, okBody);

        const result = await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hi' }] }, signal, 1000);

        expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 3 });
    });

    it('strips the models/ prefix when listing models', async () => {
        respond(200, { models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-1.5-pro' }] });

        const models = await provider.listModels(profile(), signal, 1000);

        expect(models).toEqual(['gemini-1.5-pro', 'gemini-2.0-flash']);
    });
});
