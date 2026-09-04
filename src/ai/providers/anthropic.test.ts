import { AnthropicProvider } from './anthropic';
import type { AiProfile } from '../types';
import { lastRequest, lastRequestBody, mockRequestUrl, resetRequests, respondWith as respond } from '../test-support';

function profile(overrides: Partial<AiProfile> = {}): AiProfile {
    return {
        id: 'p1',
        name: 'Claude',
        providerId: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'test-key',
        model: 'claude-sonnet-5',
        ...overrides
    };
}


const okBody = { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 9, output_tokens: 2 } };

describe('AnthropicProvider', () => {
    const provider = new AnthropicProvider();
    const signal = new AbortController().signal;

    beforeEach(() => {
        resetRequests();
    });

    it('posts to /messages with the versioned key headers', async () => {
        respond(200, okBody);

        await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hi' }] }, signal, 1000);

        expect(lastRequest().url).toBe('https://api.anthropic.com/v1/messages');
        expect(lastRequest().headers?.['x-api-key']).toBe('test-key');
        expect(lastRequest().headers?.['anthropic-version']).toBe('2023-06-01');
    });

    it('does not send the browser-access header, which requestUrl does not need', async () => {
        respond(200, okBody);

        await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hi' }] }, signal, 1000);

        expect(lastRequest().headers).not.toHaveProperty('anthropic-dangerous-direct-browser-access');
    });

    it('lifts the system prompt out of messages into the top-level field', async () => {
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

        const body = lastRequestBody();
        expect(body.system).toBe('be brief');
        expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('joins multiple system messages rather than dropping all but one', async () => {
        respond(200, okBody);

        await provider.complete(
            {
                profile: profile(),
                messages: [
                    { role: 'system', content: 'first' },
                    { role: 'system', content: 'second' },
                    { role: 'user', content: 'hi' }
                ]
            },
            signal,
            1000
        );

        expect(lastRequestBody().system).toBe('first\n\nsecond');
    });

    it('always sends max_tokens, which the API requires', async () => {
        respond(200, okBody);

        await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hi' }] }, signal, 1000);

        expect(lastRequestBody().max_tokens).toBe(4096);
    });

    it('prefers an explicit max token limit over the required-field fallback', async () => {
        respond(200, okBody);

        await provider.complete(
            { profile: profile({ maxTokens: 512 }), messages: [{ role: 'user', content: 'hi' }] },
            signal,
            1000
        );

        expect(lastRequestBody().max_tokens).toBe(512);
    });

    it('rejects a request that carries only a system prompt', async () => {
        await expect(
            provider.complete({ profile: profile(), messages: [{ role: 'system', content: 'be brief' }] }, signal, 1000)
        ).rejects.toMatchObject({ kind: 'bad-request' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('concatenates text blocks and ignores non-text ones', async () => {
        respond(200, {
            content: [
                { type: 'thinking', thinking: 'ignored' },
                { type: 'text', text: 'first ' },
                { type: 'text', text: 'second' }
            ]
        });

        const result = await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hi' }] }, signal, 1000);

        expect(result.text).toBe('first second');
    });

    it('maps Anthropic token counts onto the shared usage shape', async () => {
        respond(200, okBody);

        const result = await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hi' }] }, signal, 1000);

        expect(result.usage).toEqual({ promptTokens: 9, completionTokens: 2 });
    });
});
