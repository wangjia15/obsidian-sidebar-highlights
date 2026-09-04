import { OpenAiCompatibleProvider } from './openai-compatible';
import { AiError, type AiProfile } from '../types';
import { lastRequest, lastRequestBody, mockRequestUrl, resetRequests, respondWith as respond } from '../test-support';

function profile(overrides: Partial<AiProfile> = {}): AiProfile {
    return {
        id: 'p1',
        name: 'Test',
        providerId: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-secret-value',
        model: 'gpt-4o-mini',
        ...overrides
    };
}


describe('OpenAiCompatibleProvider', () => {
    const provider = new OpenAiCompatibleProvider();
    const signal = new AbortController().signal;

    beforeEach(() => {
        resetRequests();
    });

    describe('request construction', () => {
        it('posts to /chat/completions on the configured base URL', async () => {
            respond(200, { choices: [{ message: { content: 'hi' } }] });

            await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hello' }] }, signal, 1000);

            expect(lastRequest().url).toBe('https://api.example.com/v1/chat/completions');
            expect(lastRequest().method).toBe('POST');
        });

        it('tolerates a base URL with a trailing slash', async () => {
            respond(200, { choices: [{ message: { content: 'hi' } }] });

            await provider.complete(
                { profile: profile({ baseUrl: 'https://api.example.com/v1/' }), messages: [{ role: 'user', content: 'hello' }] },
                signal,
                1000
            );

            expect(lastRequest().url).toBe('https://api.example.com/v1/chat/completions');
        });

        it('sends the key as a bearer token', async () => {
            respond(200, { choices: [{ message: { content: 'hi' } }] });

            await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hello' }] }, signal, 1000);

            expect(lastRequest().headers?.['Authorization']).toBe('Bearer sk-secret-value');
        });

        it('omits the Authorization header entirely when no key is set', async () => {
            respond(200, { choices: [{ message: { content: 'hi' } }] });

            await provider.complete(
                { profile: profile({ apiKey: '', providerId: 'ollama' }), messages: [{ role: 'user', content: 'hello' }] },
                signal,
                1000
            );

            expect(lastRequest().headers).not.toHaveProperty('Authorization');
        });

        it('passes system messages through as a system role', async () => {
            respond(200, { choices: [{ message: { content: 'hi' } }] });

            await provider.complete(
                {
                    profile: profile(),
                    messages: [
                        { role: 'system', content: 'be brief' },
                        { role: 'user', content: 'hello' }
                    ]
                },
                signal,
                1000
            );

            expect(lastRequestBody().messages).toEqual([
                { role: 'system', content: 'be brief' },
                { role: 'user', content: 'hello' }
            ]);
        });

        it('omits temperature and max_tokens when the profile leaves them unset', async () => {
            respond(200, { choices: [{ message: { content: 'hi' } }] });

            await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'hello' }] }, signal, 1000);

            const body = lastRequestBody();
            expect(body).not.toHaveProperty('temperature');
            expect(body).not.toHaveProperty('max_tokens');
        });

        it('sends temperature 0 rather than treating it as unset', async () => {
            respond(200, { choices: [{ message: { content: 'hi' } }] });

            await provider.complete(
                { profile: profile({ temperature: 0 }), messages: [{ role: 'user', content: 'hello' }] },
                signal,
                1000
            );

            expect(lastRequestBody().temperature).toBe(0);
        });

        it('lets a per-request override win over the profile value', async () => {
            respond(200, { choices: [{ message: { content: 'hi' } }] });

            await provider.complete(
                { profile: profile({ maxTokens: 100 }), messages: [{ role: 'user', content: 'hello' }], maxTokens: 16 },
                signal,
                1000
            );

            expect(lastRequestBody().max_tokens).toBe(16);
        });
    });

    describe('response parsing', () => {
        it('reads a plain string content', async () => {
            respond(200, { model: 'gpt-4o-mini', choices: [{ message: { content: '  three points  ' } }], usage: { prompt_tokens: 12, completion_tokens: 5 } });

            const result = await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'x' }] }, signal, 1000);

            expect(result.text).toBe('three points');
            expect(result.model).toBe('gpt-4o-mini');
            expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 5 });
        });

        it('joins the array-of-parts content shape some servers return', async () => {
            respond(200, { choices: [{ message: { content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] } }] });

            const result = await provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'x' }] }, signal, 1000);

            expect(result.text).toBe('part one part two');
        });

        it('rejects an empty completion instead of returning a blank comment', async () => {
            respond(200, { choices: [{ message: { content: '   ' } }] });

            await expect(
                provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'x' }] }, signal, 1000)
            ).rejects.toMatchObject({ kind: 'unknown' });
        });

        it('reports a non-JSON body as a bad request rather than crashing', async () => {
            respond(200, '<html>gateway</html>');

            await expect(
                provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'x' }] }, signal, 1000)
            ).rejects.toMatchObject({ kind: 'bad-request' });
        });
    });

    describe('error mapping', () => {
        const cases: Array<[number, string]> = [
            [401, 'auth'],
            [403, 'auth'],
            [402, 'quota'],
            [429, 'rate-limit'],
            [400, 'bad-request'],
            [404, 'bad-request'],
            [500, 'server'],
            [503, 'server']
        ];

        it.each(cases)('maps HTTP %i to %s', async (status, kind) => {
            respond(status, { error: { message: 'nope' } });

            await expect(
                provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'x' }] }, signal, 1000)
            ).rejects.toMatchObject({ kind });
        });

        it('carries the provider message through as detail', async () => {
            respond(401, { error: { message: 'Incorrect API key provided' } });

            await expect(
                provider.complete({ profile: profile(), messages: [{ role: 'user', content: 'x' }] }, signal, 1000)
            ).rejects.toMatchObject({ detail: 'Incorrect API key provided' });
        });

        it('marks rate limiting and server errors as retriable, auth failures as not', async () => {
            respond(429, {});
            const rateLimited = await provider
                .complete({ profile: profile(), messages: [{ role: 'user', content: 'x' }] }, signal, 1000)
                .catch((error: AiError) => error);
            expect(rateLimited).toMatchObject({ retriable: true });

            respond(401, {});
            const unauthorized = await provider
                .complete({ profile: profile(), messages: [{ role: 'user', content: 'x' }] }, signal, 1000)
                .catch((error: AiError) => error);
            expect(unauthorized).toMatchObject({ retriable: false });
        });
    });

    describe('listModels', () => {
        it('extracts and sorts model ids', async () => {
            respond(200, { data: [{ id: 'gpt-4o' }, { id: 'a-model' }, { id: 'gpt-4o-mini' }] });

            const models = await provider.listModels(profile(), signal, 1000);

            expect(models).toEqual(['a-model', 'gpt-4o', 'gpt-4o-mini']);
            expect(lastRequest().url).toBe('https://api.example.com/v1/models');
            expect(lastRequest().method).toBe('GET');
        });

        it('rejects a payload without a data array', async () => {
            respond(200, { models: [] });

            await expect(provider.listModels(profile(), signal, 1000)).rejects.toMatchObject({ kind: 'bad-request' });
        });
    });
});
