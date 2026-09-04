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
