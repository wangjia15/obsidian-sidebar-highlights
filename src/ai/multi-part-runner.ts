import type { AiService, RetryEvent } from './ai-service';
import type { AiMessage, AiProfile, AiResult, AiUsage } from './types';

export interface MultiPartOptions {
    profile: AiProfile;
    signal: AbortSignal;
    bypassCache?: boolean;
    onRetry?: (event: RetryEvent) => void;
    /** Receives the complete combined output whenever it changes. */
    onText?: (text: string) => void;
    /**
     * Receives a reasoning model's thinking for the part being run. Reset per
     * part rather than accumulated: it is a progress indicator, not an answer,
     * and the previous part's reasoning is of no interest once it is done.
     */
    onReasoning?: (text: string) => void;
}

export interface MultiPartResult {
    combined: AiResult;
    /** Every provider result, merge pass included, for counting usage. */
    parts: AiResult[];
    /**
     * The results that make up the answer: every part when they were simply
     * joined, or just the merge pass when there was one. A caller that treats
     * parts individually (joinAnswerParts) must use these, not `parts`.
     */
    answers: AiResult[];
}

/**
 * Runs each document chunk in order and joins the answers in document order.
 *
 * With `merge`, a run of more than one part ends with one more request that
 * folds the partial answers into a single one. Joining is right for output that
 * follows the document (an outline, extracted passages); it is wrong for a
 * synthesis — a summary or a review of a long paper would otherwise arrive as
 * one per part, each ignorant of the others.
 */
export async function runAiMessageBatches(
    service: AiService,
    batches: AiMessage[][],
    options: MultiPartOptions & { merge?: (partTexts: string[]) => AiMessage[] }
): Promise<MultiPartResult> {
    const parts: AiResult[] = [];
    let completeText = '';

    const runOne = async (messages: AiMessage[], prefix: string): Promise<AiResult> => {
        let current = '';
        let reasoning = '';
        return service.canStream(options.profile)
            ? await service.stream(messages, {
                profile: options.profile,
                signal: options.signal,
                bypassCache: options.bypassCache,
                onRetry: options.onRetry,
                onDelta: chunk => {
                    current += chunk;
                    options.onText?.(`${prefix}${current}`);
                },
                onReasoning: chunk => {
                    reasoning += chunk;
                    options.onReasoning?.(reasoning);
                },
                onFallback: () => {
                    current = '';
                    reasoning = '';
                    options.onText?.(prefix);
                    options.onReasoning?.('');
                }
            })
            : await service.complete(messages, {
                profile: options.profile,
                signal: options.signal,
                bypassCache: options.bypassCache,
                onRetry: options.onRetry
            });
    };

    for (const messages of batches) {
        const prefix = completeText ? `${completeText}\n\n` : '';
        const result = await runOne(messages, prefix);
        parts.push(result);
        completeText = `${prefix}${result.text.trim()}`;
        options.onText?.(completeText);
    }

    if (options.merge && parts.length > 1) {
        // The partial answers stay on screen until the merged one starts
        // replacing them, so the wait for the last request is not a blank one.
        const merged = await runOne(options.merge(parts.map(part => part.text.trim())), '');
        parts.push(merged);
        options.onText?.(merged.text.trim());
        return {
            combined: { text: merged.text.trim(), model: merged.model, usage: sumUsage(parts) },
            parts,
            answers: [merged]
        };
    }

    return {
        combined: {
            text: completeText,
            model: parts.at(-1)?.model,
            usage: sumUsage(parts)
        },
        parts,
        answers: parts
    };
}

function sumUsage(results: AiResult[]): AiUsage | undefined {
    if (!results.some(result => result.usage)) return undefined;
    return results.reduce<AiUsage>((sum, result) => ({
        promptTokens: (sum.promptTokens ?? 0) + (result.usage?.promptTokens ?? 0),
        completionTokens: (sum.completionTokens ?? 0) + (result.usage?.completionTokens ?? 0)
    }), {});
}
