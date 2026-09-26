import { httpJson, httpStream, joinUrl, kindForStatus, redact, toAiError } from './provider';
import { AiError } from '../types';
import { mockRequestUrl, requestAt, resetRequests, respondNever, respondWith } from '../test-support';

describe('joinUrl', () => {
    it.each([
        ['https://x.com/v1', '/models', 'https://x.com/v1/models'],
        ['https://x.com/v1/', '/models', 'https://x.com/v1/models'],
        ['https://x.com/v1///', '/models', 'https://x.com/v1/models']
    ])('joins %s with %s', (base, path, expected) => {
        expect(joinUrl(base, path)).toBe(expected);
    });
});

describe('redact', () => {
    it('masks OpenAI-style keys', () => {
        expect(redact('bad key sk-abcd1234efgh5678 supplied')).not.toContain('abcd1234efgh5678');
    });

    it('masks Google-style keys', () => {
        expect(redact('key AIzaSyA1B2C3D4E5F6G7 rejected')).not.toContain('SyA1B2C3D4E5F6G7');
    });

    it('masks any long opaque token', () => {
        const token = 'a'.repeat(40);
        expect(redact(`token ${token}`)).not.toContain(token);
    });

    it('leaves ordinary prose alone', () => {
        expect(redact('Incorrect API key provided')).toBe('Incorrect API key provided');
    });
});

describe('kindForStatus', () => {
    it.each([
        [401, 'auth'],
        [403, 'auth'],
        [402, 'quota'],
        [408, 'timeout'],
        [429, 'rate-limit'],
        [418, 'bad-request'],
        [500, 'server'],
        [504, 'timeout'],
        [200, 'unknown']
    ])('maps %i to %s', (status, kind) => {
        expect(kindForStatus(status)).toBe(kind);
    });
});

describe('toAiError', () => {
    it('passes an AiError through unchanged', () => {
        const original = new AiError('auth', 'nope');
        expect(toAiError(original)).toBe(original);
    });

    it('recognizes a dropped connection as a network failure', () => {
        expect(toAiError(new Error('net::ERR_INTERNET_DISCONNECTED')).kind).toBe('network');
    });

    it.each(['Failed to fetch', 'fetch failed', 'NetworkError when attempting to fetch resource', 'Load failed'])('recognizes browser network failure: %s', message => {
        expect(toAiError(new TypeError(message)).kind).toBe('network');
    });

    it('recognizes a refused local port as a network failure', () => {
        expect(toAiError(new Error('connect ECONNREFUSED 127.0.0.1:11434')).kind).toBe('network');
    });

    it('recognizes an AbortError by name', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        expect(toAiError(error).kind).toBe('aborted');
    });

    it('falls back to unknown for anything unrecognized', () => {
        expect(toAiError('something odd').kind).toBe('unknown');
    });

    it('redacts the message it carries forward', () => {
        expect(toAiError(new Error('failed with sk-abcd1234efgh5678')).message).not.toContain('abcd1234efgh5678');
    });
});

describe('httpJson', () => {
    beforeEach(() => {
        resetRequests();
    });

    const baseCall = {
        url: 'https://api.example.com/v1/chat/completions',
        method: 'POST' as const,
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: 1000
    };

    it('refuses to send when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(httpJson({ ...baseCall, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('rejects as aborted when the signal fires mid-flight', async () => {
        const controller = new AbortController();
        respondNever();

        const pending = httpJson({ ...baseCall, signal: controller.signal });
        controller.abort();

        await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    });

    it('rejects as a timeout when the response outlasts the budget', async () => {
        jest.useFakeTimers();
        respondNever();

        const pending = httpJson({ ...baseCall, signal: new AbortController().signal, timeoutMs: 50 });
        const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
        jest.advanceTimersByTime(51);

        await assertion;
        jest.useRealTimers();
    });

    it('does not throw for a 2xx with an empty body', async () => {
        respondWith(204, '');

        const result = await httpJson({ ...baseCall, signal: new AbortController().signal });

        expect(result.json).toBeUndefined();
        expect(result.status).toBe(204);
    });

    it('serializes the body as JSON', async () => {
        respondWith(200, {});

        await httpJson({ ...baseCall, body: { model: 'x' }, signal: new AbortController().signal });

        expect(requestAt(0).body).toBe('{"model":"x"}');
    });

    it('sends no body at all for a GET', async () => {
        respondWith(200, {});

        await httpJson({ ...baseCall, method: 'GET', signal: new AbortController().signal });

        expect(requestAt(0).body).toBeUndefined();
    });

    it('asks requestUrl not to throw so non-2xx statuses reach our own mapping', async () => {
        respondWith(200, {});

        await httpJson({ ...baseCall, signal: new AbortController().signal });

        expect(requestAt(0).throw).toBe(false);
    });

    it('strips key-shaped text out of an error body before it can be shown', async () => {
        respondWith(401, { error: { message: 'key sk-abcd1234efgh5678 is invalid' } });

        const error = await httpJson({ ...baseCall, signal: new AbortController().signal }).catch((e: AiError) => e);

        expect(error).toBeInstanceOf(AiError);
        expect((error as AiError).detail).not.toContain('abcd1234efgh5678');
    });
});

describe('Retry-After transport metadata', () => {
    beforeEach(() => { resetRequests(); jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    it.each([
        ['Retry-After', '3', 3000],
        ['retry-after', '0', 0],
        ['RETRY-AFTER', 'Thu, 01 Jan 2026 00:00:05 GMT', 5000],
        ['retry-after', 'Wed, 31 Dec 2025 23:59:59 GMT', 0],
        ['retry-after', '-1', undefined],
        ['retry-after', 'invalid', undefined]
    ])('carries %s: %s through httpJson', async (header, value, delay) => {
        jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        mockRequestUrl.mockResolvedValueOnce({ status: 429, text: 'busy', json: undefined, headers: { [header]: value } });
        await expect(httpJson({ url: 'https://example.com', method: 'POST', headers: {}, signal: new AbortController().signal, timeoutMs: 60000 }))
            .rejects.toMatchObject({ kind: 'rate-limit', retryAfterMs: delay });
    });
});


it('carries Retry-After through the streaming transport', async () => {
    const previousFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 503, text: async () => 'busy', headers: { get: (key: string) => key === 'retry-after' ? '4' : null }
    });
    try {
        await expect(httpStream({ url: 'https://example.com', headers: {}, body: {}, signal: new AbortController().signal, timeoutMs: 60000, onEvent: () => undefined }))
            .rejects.toMatchObject({ kind: 'server', retryAfterMs: 4000 });
    } finally {
        global.fetch = previousFetch;
    }
});
