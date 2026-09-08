import type { AiService } from './ai-service';
import type { AiMessage, AiProfile, AiResult, AiUsage } from './types';

export interface MultiPartOptions {
    profile: AiProfile;
    signal: AbortSignal;
    bypassCache?: boolean;
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
    /** Individual provider results, used to count each request in usage totals. */
    parts: AiResult[];
}

/** Runs each document chunk in order and joins the answers in document order. */
export async function runAiMessageBatches(
    service: AiService,
    batches: AiMessage[][],
    options: MultiPartOptions
): Promise<MultiPartResult> {
    const parts: AiResult[] = [];
    let completeText = '';

    for (const messages of batches) {
        const prefix = completeText ? `${completeText}\n\n` : '';
        let current = '';
        let reasoning = '';
        const result = service.canStream(options.profile)
            ? await service.stream(messages, {
                profile: options.profile,
                signal: options.signal,
                bypassCache: options.bypassCache,
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
                bypassCache: options.bypassCache
            });

        parts.push(result);
        completeText = `${prefix}${result.text.trim()}`;
        options.onText?.(completeText);
    }

    return {
        combined: {
            text: completeText,
            model: parts.at(-1)?.model,
            usage: sumUsage(parts)
        },
        parts
    };
}

function sumUsage(results: AiResult[]): AiUsage | undefined {
    if (!results.some(result => result.usage)) return undefined;
    return results.reduce<AiUsage>((sum, result) => ({
        promptTokens: (sum.promptTokens ?? 0) + (result.usage?.promptTokens ?? 0),
        completionTokens: (sum.completionTokens ?? 0) + (result.usage?.completionTokens ?? 0)
    }), {});
}
