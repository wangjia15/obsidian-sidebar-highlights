import { AiService, describeAiError } from './ai-service';
import { AiError, DEFAULT_AI_SETTINGS, cloneAiSettings } from './types';
import { i18n } from '../i18n';
beforeAll(async () => { await i18n.init(); });
import { runBatch, summarize, type BatchItem, type BatchOutcome } from './batch-runner';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

function items(...labels: string[]): BatchItem<string>[] {
    return labels.map(label => ({ label, value: label }));
}

describe('runBatch', () => {
    it('runs every item in order', async () => {
        const seen: string[] = [];
        const outcome = await runBatch({
            items: items('a', 'b', 'c'),
            signal: new AbortController().signal,
            describeError,
            run: async value => { seen.push(value); }
        });

        expect(seen).toEqual(['a', 'b', 'c']);
        expect(outcome).toEqual({ succeeded: 3, failed: [], aborted: false });
    });

    it('keeps going after a failure', async () => {
        // One bad highlight out of fifty must not cost the other forty-nine.
        const seen: string[] = [];
        const outcome = await runBatch({
            items: items('a', 'bad', 'c'),
            signal: new AbortController().signal,
            describeError,
            run: async value => {
                if (value === 'bad') throw new Error('provider said no');
                seen.push(value);
            }
        });

        expect(seen).toEqual(['a', 'c']);
        expect(outcome.succeeded).toBe(2);
        expect(outcome.failed).toEqual([{ label: 'bad', reason: 'provider said no' }]);
        expect(outcome.aborted).toBe(false);
    });

    it('stops as soon as it is aborted', async () => {
        const controller = new AbortController();
        const seen: string[] = [];

        const outcome = await runBatch({
            items: items('a', 'b', 'c', 'd'),
            signal: controller.signal,
            describeError,
            run: async value => {
                seen.push(value);
                if (value === 'b') controller.abort();
            }
        });

        expect(seen).toEqual(['a', 'b']);
        expect(outcome.aborted).toBe(true);
        expect(outcome.succeeded).toBe(2);
    });

    it('does not record an abort as a failure', async () => {
        // The request throws because it was cancelled; that is the user's doing
        // and does not belong in a list of things that went wrong.
        const controller = new AbortController();
        const outcome = await runBatch({
            items: items('a', 'b'),
            signal: controller.signal,
            describeError,
            run: async () => {
                controller.abort();
                throw new Error('Request aborted');
            }
        });

        expect(outcome.failed).toEqual([]);
        expect(outcome.aborted).toBe(true);
        expect(outcome.succeeded).toBe(0);
    });

    it('runs nothing when aborted before it starts', async () => {
        const controller = new AbortController();
        controller.abort();
        const run = jest.fn();

        const outcome = await runBatch({
            items: items('a'),
            signal: controller.signal,
            describeError,
            run
        });

        expect(run).not.toHaveBeenCalled();
        expect(outcome).toEqual({ succeeded: 0, failed: [], aborted: true });
    });

    it('reports progress before each item and once at the end', async () => {
        const progress: string[] = [];
        await runBatch({
            items: items('a', 'b'),
            signal: new AbortController().signal,
            describeError,
            run: async () => undefined,
            onProgress: update => progress.push(`${update.done}/${update.total} ${update.current}`)
        });

        expect(progress).toEqual(['0/2 a', '1/2 b', '2/2 ']);
    });

    it('handles an empty list', async () => {
        const outcome = await runBatch({
            items: [],
            signal: new AbortController().signal,
            describeError,
            run: async () => undefined
        });

        expect(outcome).toEqual({ succeeded: 0, failed: [], aborted: false });
    });

    it('never overlaps two items', async () => {
        // Serial is the point: parallel requests are how a batch turns into a
        // rate-limit ban.
        let inFlight = 0;
        let maxInFlight = 0;

        await runBatch({
            items: items('a', 'b', 'c'),
            signal: new AbortController().signal,
            describeError,
            run: async () => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await Promise.resolve();
                inFlight--;
            }
        });

        expect(maxInFlight).toBe(1);
    });
});

describe('summarize', () => {
    const format = (key: string, values: Record<string, string | number>) => {
        if (key === 'done') return `Finished ${values.count}.`;
        if (key === 'stopped') return `Stopped after ${values.count}.`;
        return `${values.count} failed: ${values.names}`;
    };

    const outcome = (over: Partial<BatchOutcome>): BatchOutcome =>
        ({ succeeded: 0, failed: [], aborted: false, ...over });

    it('reports a clean run', () => {
        expect(summarize(outcome({ succeeded: 3 }), format)).toBe('Finished 3.');
    });

    it('reports a stopped run', () => {
        expect(summarize(outcome({ succeeded: 1, aborted: true }), format)).toBe('Stopped after 1.');
    });

    it('names the failures', () => {
        const result = summarize(outcome({
            succeeded: 1,
            failed: [{ label: 'one', reason: 'x' }, { label: 'two', reason: 'y' }]
        }), format);

        expect(result).toBe('Finished 1. 2 failed: one, two');
    });

    it('caps the names and counts the rest', () => {
        const failed = ['a', 'b', 'c', 'd', 'e'].map(label => ({ label, reason: 'x' }));
        expect(summarize(outcome({ succeeded: 0, failed }), format))
            .toBe('Finished 0. 5 failed: a, b, c +2');
    });
});

describe('runBatch with service retries', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(Math, 'random').mockReturnValue(0.5);
    });
    afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

    function setup() {
        const profile = { id: 'p', name: 'Test', providerId: 'openai' as const, apiKey: 'test', baseUrl: 'https://example.com', model: 'test' };
        const settings = { ...cloneAiSettings(DEFAULT_AI_SETTINGS), enabled: true, profiles: [profile] };
        const service = new AiService(() => settings);
        const complete = jest.fn();
        jest.spyOn(service, 'providerFor').mockReturnValue({ kind: 'fake', complete });
        const onProgress = jest.fn();
        const controller = new AbortController();
        const pending = () => runBatch({
            items: items('a', 'b'), signal: controller.signal, describeError: describeAiError, onProgress,
            run: (value, signal, onRetry) => service.complete([{ role: 'user', content: value }], { signal, onRetry, bypassCache: true })
        });
        return { complete, onProgress, controller, pending };
    }

    it('reports a transient retry and keeps the recovered item out of the failure list', async () => {
        const { complete, onProgress, pending } = setup();
        complete.mockRejectedValueOnce(new AiError('server', '503')).mockResolvedValue({ text: 'answer' });
        const outcome = pending();
        await jest.advanceTimersByTimeAsync(0);
        expect(onProgress).toHaveBeenLastCalledWith({ done: 0, total: 2, current: 'a', retryAttempt: 1 });
        expect(complete).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1000);
        expect(await outcome).toEqual({ succeeded: 2, failed: [], aborted: false });
        expect(complete).toHaveBeenCalledTimes(3);
        // Advancing to the next item clears the previous item's retry status.
        expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
            { done: 0, total: 2, current: 'a' },
            { done: 0, total: 2, current: 'a', retryAttempt: 1 },
            { done: 1, total: 2, current: 'b' },
            { done: 2, total: 2, current: '' }
        ]);
    });

    it('gives each item its own service retry budget', async () => {
        const { complete, onProgress, pending } = setup();
        complete.mockRejectedValueOnce(new AiError('rate-limit', '429'))
            .mockRejectedValueOnce(new AiError('server', '503')).mockResolvedValueOnce({ text: 'a' })
            .mockRejectedValueOnce(new AiError('timeout', 'slow'))
            .mockRejectedValueOnce(new AiError('network', 'offline')).mockResolvedValueOnce({ text: 'b' });
        const outcome = pending();
        await jest.runAllTimersAsync();
        expect(await outcome).toEqual({ succeeded: 2, failed: [], aborted: false });
        expect(complete).toHaveBeenCalledTimes(6);
        expect(onProgress.mock.calls.map(([progress]) => progress).filter(progress => progress.retryAttempt))
            .toEqual([
                { done: 0, total: 2, current: 'a', retryAttempt: 1 },
                { done: 0, total: 2, current: 'a', retryAttempt: 2 },
                { done: 1, total: 2, current: 'b', retryAttempt: 1 },
                { done: 1, total: 2, current: 'b', retryAttempt: 2 }
            ]);
    });

    it('records only the final exhausted failure with its retry count and continues', async () => {
        const { complete, pending } = setup();
        complete.mockRejectedValueOnce(new AiError('server', '503'))
            .mockRejectedValueOnce(new AiError('server', '503'))
            .mockRejectedValueOnce(new AiError('server', '503')).mockResolvedValueOnce({ text: 'b' });
        const outcome = pending();
        await jest.runAllTimersAsync();
        const result = await outcome;
        expect(result).toMatchObject({ succeeded: 1, aborted: false });
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]).toEqual({ label: 'a', reason: expect.stringContaining('Retried 2') });
    });

    it('stops a backing-off item immediately without failure or starting the next item', async () => {
        const { complete, controller, pending } = setup();
        complete.mockRejectedValue(new AiError('server', '503'));
        const outcome = pending();
        await jest.advanceTimersByTimeAsync(0);
        controller.abort();
        expect(await outcome).toEqual({ succeeded: 0, failed: [], aborted: true });
        expect(jest.getTimerCount()).toBe(0);
        expect(complete).toHaveBeenCalledTimes(1);
    });
});
