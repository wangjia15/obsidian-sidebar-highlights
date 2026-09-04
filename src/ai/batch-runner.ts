/**
 * Running one prompt over many highlights.
 *
 * Strictly serial, by design. Firing a collection of two hundred highlights at
 * a provider in parallel is the fastest way to a rate-limit ban, and it takes
 * the choice away from a user who cannot see it happening. One at a time is
 * slower, stoppable, and reports honestly.
 */

import type { AiResult } from './types';

export interface BatchItem<T> {
    /** What the summary calls this item when it fails. */
    label: string;
    value: T;
}

export interface BatchProgress {
    /** Items finished, successes and failures alike. */
    done: number;
    total: number;
    /** The item about to run, for the progress line. */
    current: string;
}

export interface BatchFailure {
    label: string;
    reason: string;
}

export interface BatchOutcome {
    succeeded: number;
    failed: BatchFailure[];
    /** True when the user stopped it partway. */
    aborted: boolean;
}

export interface BatchOptions<T> {
    items: BatchItem<T>[];
    signal: AbortSignal;
    /** Runs one item; rejecting counts as a failure, not the end of the run. */
    run: (value: T, signal: AbortSignal) => Promise<AiResult | void>;
    onProgress?: (progress: BatchProgress) => void;
    /** Turns a thrown value into something worth showing the user. */
    describeError: (error: unknown) => string;
    /** Milliseconds to wait between items, easing off the provider. */
    delayMs?: number;
}

/**
 * Works through the items one at a time.
 *
 * A failure is recorded and the run continues: one bad highlight out of fifty
 * should not cost the other forty-nine. An abort stops immediately — that one
 * the user asked for.
 */
export async function runBatch<T>(options: BatchOptions<T>): Promise<BatchOutcome> {
    const { items, signal, run, onProgress, describeError } = options;
    const failed: BatchFailure[] = [];
    let succeeded = 0;

    for (let index = 0; index < items.length; index++) {
        if (signal.aborted) {
            return { succeeded, failed, aborted: true };
        }

        const item = items[index];
        onProgress?.({ done: index, total: items.length, current: item.label });

        try {
            await run(item.value, signal);
            succeeded++;
        } catch (error) {
            if (signal.aborted) {
                return { succeeded, failed, aborted: true };
            }
            failed.push({ label: item.label, reason: describeError(error) });
        }

        if (options.delayMs && index < items.length - 1) {
            await pause(options.delayMs, signal);
        }
    }

    onProgress?.({ done: items.length, total: items.length, current: '' });
    return { succeeded, failed, aborted: false };
}

/** A delay that gives up as soon as the run is aborted. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const timer = window.setTimeout(finish, ms);
        function finish() {
            window.clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
        }
        signal.addEventListener('abort', finish, { once: true });
    });
}

/**
 * A one-line summary of what happened, with at most a few names.
 *
 * The full list of failures can be long, and a Notice that fills the screen is
 * read by nobody.
 */
export function summarize(
    outcome: BatchOutcome,
    format: (key: 'done' | 'stopped' | 'failures', values: Record<string, string | number>) => string,
    maxNames = 3
): string {
    const headline = format(outcome.aborted ? 'stopped' : 'done', { count: outcome.succeeded });
    if (outcome.failed.length === 0) return headline;

    const names = outcome.failed.slice(0, maxNames).map(failure => failure.label);
    const remainder = outcome.failed.length - names.length;
    const list = remainder > 0 ? `${names.join(', ')} +${remainder}` : names.join(', ');

    return `${headline} ${format('failures', { count: outcome.failed.length, names: list })}`;
}
