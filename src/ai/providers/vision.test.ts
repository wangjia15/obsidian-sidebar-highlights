import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { OpenAiCompatibleProvider } from './openai-compatible';
import type { AiMessage, AiProfile } from '../types';
import { lastRequestBody, resetRequests, respondWith as respond } from '../test-support';

/** Images attached to a user turn reach each provider in its own wire shape. */

const IMAGE = { mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'chart.png' };

function profile(overrides: Partial<AiProfile>): AiProfile {
    return {
        id: 'p1',
        name: 'Test',
        providerId: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-secret-value',
        model: 'model',
        ...overrides
    };
}

const messages: AiMessage[] = [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'what is this?', images: [IMAGE] }
];

describe('image attachments', () => {
    const signal = new AbortController().signal;

    beforeEach(() => resetRequests());

    it('sends OpenAI-compatible content parts with a data URL', async () => {
        respond(200, { choices: [{ message: { content: 'a chart' } }] });
        await new OpenAiCompatibleProvider().complete({ profile: profile({}), messages }, signal, 1000);

        const body = lastRequestBody() as { messages: { content: unknown }[] };
        expect(body.messages[0].content).toBe('be brief');
        expect(body.messages[1].content).toEqual([
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
        ]);
    });

    it('keeps text-only turns as plain strings for OpenAI-compatible servers', async () => {
        respond(200, { choices: [{ message: { content: 'ok' } }] });
        await new OpenAiCompatibleProvider().complete(
            { profile: profile({}), messages: [{ role: 'user', content: 'hi' }] }, signal, 1000
        );
        expect((lastRequestBody() as { messages: { content: unknown }[] }).messages[0].content).toBe('hi');
    });

    it('sends Anthropic base64 image blocks before the text', async () => {
        respond(200, { content: [{ type: 'text', text: 'a chart' }], model: 'claude' });
        await new AnthropicProvider().complete(
            { profile: profile({ providerId: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }), messages },
            signal,
            1000
        );

        const body = lastRequestBody() as { messages: { content: unknown }[] };
        expect(body.messages[0].content).toEqual([
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
            { type: 'text', text: 'what is this?' }
        ]);
    });

    it('sends Gemini inline_data parts', async () => {
        respond(200, { candidates: [{ content: { parts: [{ text: 'a chart' }] }, finishReason: 'STOP' }] });
        await new GeminiProvider().complete(
            { profile: profile({ providerId: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }), messages },
            signal,
            1000
        );

        const body = lastRequestBody() as { contents: { parts: unknown[] }[] };
        expect(body.contents[0].parts).toEqual([
            { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } },
            { text: 'what is this?' }
        ]);
    });
});
