import type { AiService } from './ai-service';
import type { AiMessage, AiProfile } from './types';
import { runAiMessageBatches } from './multi-part-runner';

const profile = { id: 'p', name: 'P', model: 'm' } as AiProfile;
const batches: AiMessage[][] = [
    [{ role: 'user', content: 'part one' }],
    [{ role: 'user', content: 'part two' }]
];

it('runs document parts sequentially and combines text and usage', async () => {
    const complete = jest.fn()
        .mockResolvedValueOnce({ text: 'first answer', model: 'm', usage: { promptTokens: 2, completionTokens: 3 } })
        .mockResolvedValueOnce({ text: 'second answer', model: 'm', usage: { promptTokens: 5, completionTokens: 7 } });
    const service = { canStream: () => false, complete } as unknown as AiService;
    const onText = jest.fn();
    const result = await runAiMessageBatches(service, batches, {
        profile,
        signal: new AbortController().signal,
        onText
    });

    expect(complete.mock.calls.map(call => call[0])).toEqual(batches);
    expect(result.combined).toEqual({
        text: 'first answer\n\nsecond answer',
        model: 'm',
        usage: { promptTokens: 7, completionTokens: 10 }
    });
    expect(result.parts).toHaveLength(2);
    expect(onText).toHaveBeenLastCalledWith(result.combined.text);
});

it('reports a reasoning model\'s thinking per part, and never as the answer', async () => {
    let callCount = 0;
    const stream = jest.fn(async (
        _messages: AiMessage[],
        options: { onDelta(text: string): void; onReasoning?(text: string): void }
    ) => {
        callCount++;
        options.onReasoning?.(callCount === 1 ? 'weighing ' : 'checking ');
        options.onReasoning?.('it');
        const text = callCount === 1 ? 'one' : 'two';
        options.onDelta(text);
        return { text };
    });
    const service = { canStream: () => true, stream } as unknown as AiService;
    const thoughts: string[] = [];
    const result = await runAiMessageBatches(service, batches, {
        profile,
        signal: new AbortController().signal,
        onReasoning: text => thoughts.push(text)
    });

    // Accumulated within a part, reset between them: it is a progress
    // indicator, and the finished part's thinking is of no further interest.
    expect(thoughts).toEqual(['weighing ', 'weighing it', 'checking ', 'checking it']);
    expect(result.combined.text).toBe('one\n\ntwo');
});

it('keeps completed parts visible while the next part streams', async () => {
    let callCount = 0;
    const stream: jest.Mock<Promise<{ text: string }>, [AiMessage[], { onDelta(text: string): void }]> = jest.fn(async (_messages, options) => {
        callCount++;
        const text = callCount === 1 ? 'one' : 'two';
        options.onDelta(text);
        return { text };
    });
    const service = { canStream: () => true, stream } as unknown as AiService;
    const seen: string[] = [];
    await runAiMessageBatches(service, batches, {
        profile,
        signal: new AbortController().signal,
        onText: text => seen.push(text)
    });
    expect(seen).toContain('one\n\ntwo');
});


function fakeService(): { service: AiService; sent: AiMessage[][] } {
    const sent: AiMessage[][] = [];
    const service = {
        canStream: () => false,
        complete: async (messages: AiMessage[]) => {
            sent.push(messages);
            return { text: `answer ${sent.length}`, usage: { promptTokens: 1, completionTokens: 1 } };
        }
    } as unknown as AiService;
    return { service, sent };
}

const batch = (text: string): AiMessage[] => [{ role: 'user', content: text }];

describe('runAiMessageBatches merging', () => {
    it('joins parts in order without a merge', async () => {
        const { service } = fakeService();
        const result = await runAiMessageBatches(service, [batch('a'), batch('b')], { profile, signal: new AbortController().signal });
        expect(result.combined.text).toBe('answer 1\n\nanswer 2');
        expect(result.answers).toHaveLength(2);
    });

    it('folds several parts into one with a final merge request', async () => {
        const { service, sent } = fakeService();
        const merge = jest.fn((texts: string[]) => batch(`merge: ${texts.join(' | ')}`));
        const result = await runAiMessageBatches(service, [batch('a'), batch('b')], {
            profile, signal: new AbortController().signal, merge
        });

        expect(merge).toHaveBeenCalledWith(['answer 1', 'answer 2']);
        expect(sent[2][0].content).toBe('merge: answer 1 | answer 2');
        expect(result.combined.text).toBe('answer 3');
        expect(result.answers.map(answer => answer.text)).toEqual(['answer 3']);
        // Every request counts towards usage, the merge included.
        expect(result.parts).toHaveLength(3);
        expect(result.combined.usage).toEqual({ promptTokens: 3, completionTokens: 3 });
    });

    it('skips the merge for a single part', async () => {
        const { service } = fakeService();
        const merge = jest.fn();
        const result = await runAiMessageBatches(service, [batch('a')], { profile, signal: new AbortController().signal, merge });
        expect(merge).not.toHaveBeenCalled();
        expect(result.combined.text).toBe('answer 1');
    });
});
