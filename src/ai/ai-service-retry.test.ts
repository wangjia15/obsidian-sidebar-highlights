import { Platform } from 'obsidian';
import { AiService, describeAiError } from './ai-service';
import { AiError, DEFAULT_AI_SETTINGS, cloneAiSettings, addUsage, EMPTY_AI_USAGE, type AiErrorKind } from './types';
import type { Provider, StreamHandlers } from './providers/provider';
import { i18n } from '../i18n';

const messages = [{ role: 'user' as const, content: 'question' }];
const profile = { id: 'test', name: 'Test', providerId: 'openai' as const, baseUrl: 'https://example.com', apiKey: 'test', model: 'test' };
const answer = { text: 'answer', usage: { promptTokens: 7, completionTokens: 3 } };

function setup(maxRetries = 2) {
    const settings = { ...cloneAiSettings(DEFAULT_AI_SETTINGS), enabled: true, profiles: [profile], maxRetries };
    const provider: Provider = { kind: 'fake', complete: jest.fn(), stream: jest.fn() };
    const service = new AiService(() => settings);
    jest.spyOn(service, 'providerFor').mockReturnValue(provider);
    return { service, complete: provider.complete as jest.Mock, stream: provider.stream as jest.Mock, settings };
}

let previousFetch: typeof fetch;
beforeAll(async () => { await i18n.init(); });
beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    // canStream requires desktop fetch; the fake provider never uses it.
    previousFetch = global.fetch;
    global.fetch = jest.fn();
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    Platform.isMobile = false;
    global.fetch = previousFetch;
});

it('ships two retries by default', () => { expect(DEFAULT_AI_SETTINGS.maxRetries).toBe(2); });

it.each(['complete', 'stream'] as const)('%s retries with exponential jitter and returns only final usage', async mode => {
    const { service, complete, stream } = setup();
    const send = mode === 'complete' ? complete : stream;
    send.mockRejectedValueOnce(new AiError('rate-limit', '429'))
        .mockRejectedValueOnce(new AiError('server', '503')).mockResolvedValue(answer);
    const onRetry = jest.fn();
    const pending = mode === 'complete' ? service.complete(messages, { onRetry }) : service.stream(messages, { onDelta: jest.fn(), onRetry });
    await jest.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenLastCalledWith({ attempt: 1, delayMs: 1000 });
    await jest.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenLastCalledWith({ attempt: 2, delayMs: 2000 });
    await jest.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual(answer);
    expect(send).toHaveBeenCalledTimes(3);
    expect(addUsage(EMPTY_AI_USAGE, (await pending).usage, '2026-09')).toMatchObject({ calls: 1, promptTokens: 7, completionTokens: 3 });
    expect((await service.complete(messages)).usage).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(3);
});

it.each(['timeout', 'network'] as AiErrorKind[])('retries %s errors', async kind => {
    const { service, complete } = setup();
    complete.mockRejectedValueOnce(new AiError(kind, 'failed')).mockResolvedValue(answer);
    const pending = service.complete(messages);
    await jest.runAllTimersAsync();
    expect(await pending).toEqual(answer);
    expect(complete).toHaveBeenCalledTimes(2);
});

it.each(['auth', 'bad-request', 'quota', 'aborted', 'unknown'] as AiErrorKind[])('does not retry or downgrade %s', async kind => {
    const { service, complete, stream } = setup();
    complete.mockRejectedValue(new AiError(kind, 'refusal'));
    stream.mockRejectedValue(new AiError(kind, 'refusal'));
    const onRetry = jest.fn();
    await expect(service.complete(messages, { onRetry })).rejects.toMatchObject({ kind, retries: 0 });
    await expect(service.stream(messages, { onDelta: jest.fn(), onRetry })).rejects.toMatchObject({ kind, retries: 0 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
});

it('honours the provider retriable flag', async () => {
    const { service, complete } = setup();
    complete.mockRejectedValue(new AiError('server', 'do not retry', { retriable: false }));
    await expect(service.complete(messages)).rejects.toMatchObject({ retries: 0 });
    expect(complete).toHaveBeenCalledTimes(1);
});

it.each([0, 2])('stops after the configured %s retries and describes the count', async maxRetries => {
    const { service, complete } = setup(maxRetries);
    complete.mockRejectedValue(new AiError('rate-limit', '429', { status: 429, detail: 'Too many requests' }));
    const pending = service.complete(messages).catch(error => error as AiError);
    await jest.runAllTimersAsync();
    const error = await pending;
    expect(error).toMatchObject({ kind: 'rate-limit', status: 429, detail: 'Too many requests', retries: maxRetries });
    expect(describeAiError(error)).toContain(`Retried ${maxRetries}`);
    expect(complete).toHaveBeenCalledTimes(maxRetries + 1);
});

it.each([0, 0.999])('adds random jitter (%s)', async random => {
    jest.spyOn(Math, 'random').mockReturnValue(random);
    const { service, complete } = setup(1);
    complete.mockRejectedValueOnce(new AiError('server', '503')).mockResolvedValue(answer);
    const onRetry = jest.fn();
    const pending = service.complete(messages, { onRetry });
    await jest.advanceTimersByTimeAsync(0);
    const delay = onRetry.mock.calls[0][0].delayMs;
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThanOrEqual(1500);
    expect(delay).not.toBe(1000);
    await jest.runAllTimersAsync();
    await pending;
});

it.each([0, 7500, 120000])('honours Retry-After %s ms with a 30 second cap', async retryAfterMs => {
    const { service, complete } = setup();
    complete.mockRejectedValueOnce(new AiError('rate-limit', '429', { retryAfterMs })).mockResolvedValue(answer);
    const onRetry = jest.fn();
    const pending = service.complete(messages, { onRetry });
    await jest.advanceTimersByTimeAsync(0);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, delayMs: Math.min(retryAfterMs, 30000) });
    await jest.runAllTimersAsync();
    expect(await pending).toEqual(answer);
});

it('caps exponential waits at 30 seconds', async () => {
    const { service, complete } = setup(8);
    complete.mockRejectedValue(new AiError('server', '503'));
    const onRetry = jest.fn();
    const pending = service.complete(messages, { onRetry }).catch(error => error);
    await jest.runAllTimersAsync();
    await pending;
    expect(onRetry.mock.calls.map(([event]) => event.delayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

it.each(['complete', 'stream'] as const)('%s cancels immediately during backoff', async mode => {
    const { service, complete, stream } = setup();
    const send = mode === 'complete' ? complete : stream;
    send.mockRejectedValue(new AiError('server', '503'));
    const controller = new AbortController();
    const options = { signal: controller.signal, onDelta: jest.fn() };
    const pending = (mode === 'complete' ? service.complete(messages, options) : service.stream(messages, options)).catch(error => error);
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'aborted' });
    expect(jest.getTimerCount()).toBe(0);
    await jest.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(mode === 'complete' ? 1 : 0);
});

it('retries the non-streaming fallback with the same remaining budget', async () => {
    const { service, complete, stream } = setup();
    stream.mockRejectedValueOnce(new AiError('network', 'CORS'));
    complete.mockRejectedValueOnce(new AiError('server', '503')).mockResolvedValue(answer);
    const onFallback = jest.fn();
    const onRetry = jest.fn();
    const pending = service.stream(messages, { onDelta: jest.fn(), onFallback, onRetry });
    await jest.runAllTimersAsync();
    expect(await pending).toEqual(answer);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls.map(([event]) => event.attempt)).toEqual([1, 2]);
});

it.each(['onDelta', 'onReasoning'] as const)('does not retry or fallback after %s printed content', async channel => {
    const { service, complete, stream } = setup();
    stream.mockImplementation(async (_request, handlers: StreamHandlers) => {
        handlers[channel]?.('partial');
        throw new AiError('network', 'disconnected');
    });
    const onRetry = jest.fn();
    const onFallback = jest.fn();
    await expect(service.stream(messages, { onDelta: jest.fn(), onReasoning: jest.fn(), onRetry, onFallback })).rejects.toMatchObject({ kind: 'network', retries: 0 });
    expect(stream).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
});

it('uses complete and its retries on mobile without opening a stream', async () => {
    Platform.isMobile = true;
    const { service, complete, stream } = setup();
    complete.mockRejectedValueOnce(new AiError('network', 'offline')).mockResolvedValue(answer);
    const pending = service.stream(messages, { onDelta: jest.fn() });
    await jest.runAllTimersAsync();
    expect(await pending).toEqual(answer);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(stream).not.toHaveBeenCalled();
});


it('announces fallback even after an earlier stream retry', async () => {
    const { service, complete, stream } = setup();
    stream.mockRejectedValueOnce(new AiError('server', '503')).mockRejectedValueOnce(new AiError('network', 'CORS'));
    complete.mockResolvedValue(answer);
    const onFallback = jest.fn();
    const pending = service.stream(messages, { onDelta: jest.fn(), onFallback });
    await jest.runAllTimersAsync();
    expect(await pending).toEqual(answer);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
});

it('does not open fallback when retries are disabled', async () => {
    const { service, complete, stream } = setup(0);
    stream.mockRejectedValue(new AiError('network', 'CORS'));
    const onFallback = jest.fn();
    await expect(service.stream(messages, { onDelta: jest.fn(), onFallback })).rejects.toMatchObject({ kind: 'network', retries: 0 });
    expect(complete).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
});

it('cancels if the retry observer stops the run before the timer is created', async () => {
    const { service, complete } = setup();
    complete.mockRejectedValue(new AiError('server', '503'));
    const controller = new AbortController();
    await expect(service.complete(messages, { signal: controller.signal, onRetry: () => controller.abort() })).rejects.toMatchObject({ kind: 'aborted' });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
});
