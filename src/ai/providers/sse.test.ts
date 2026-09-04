import { isDoneSentinel, parseEventData, SseParser } from './sse';

describe('SseParser', () => {
    it('reads a single event', () => {
        const parser = new SseParser();
        expect(parser.push('data: hello\n\n')).toEqual([{ data: 'hello' }]);
    });

    it('reads several events from one chunk', () => {
        const parser = new SseParser();
        expect(parser.push('data: a\n\ndata: b\n\n')).toEqual([{ data: 'a' }, { data: 'b' }]);
    });

    it('waits for an event split across chunks', () => {
        // The case a naive split on "\\n\\n" gets wrong: chunks arrive on
        // network boundaries, not event boundaries.
        const parser = new SseParser();
        expect(parser.push('data: hel')).toEqual([]);
        expect(parser.push('lo\n\n')).toEqual([{ data: 'hello' }]);
    });

    it('waits when the blank line itself is split', () => {
        const parser = new SseParser();
        expect(parser.push('data: hello\n')).toEqual([]);
        expect(parser.push('\n')).toEqual([{ data: 'hello' }]);
    });

    it('captures the event name when there is one', () => {
        const parser = new SseParser();
        expect(parser.push('event: content_block_delta\ndata: {"a":1}\n\n'))
            .toEqual([{ event: 'content_block_delta', data: '{"a":1}' }]);
    });

    it('joins multiple data lines with newlines, as the spec requires', () => {
        const parser = new SseParser();
        expect(parser.push('data: line one\ndata: line two\n\n'))
            .toEqual([{ data: 'line one\nline two' }]);
    });

    it('strips exactly one leading space from a field value', () => {
        const parser = new SseParser();
        expect(parser.push('data:  two spaces\n\n')).toEqual([{ data: ' two spaces' }]);
    });

    it('reads a field with no space after the colon', () => {
        const parser = new SseParser();
        expect(parser.push('data:tight\n\n')).toEqual([{ data: 'tight' }]);
    });

    it('ignores comment lines used as keep-alives', () => {
        const parser = new SseParser();
        expect(parser.push(': ping\n\n')).toEqual([]);
        expect(parser.push(': ping\ndata: real\n\n')).toEqual([{ data: 'real' }]);
    });

    it('ignores unknown fields', () => {
        const parser = new SseParser();
        expect(parser.push('id: 7\nretry: 100\ndata: kept\n\n')).toEqual([{ data: 'kept' }]);
    });

    it('normalizes CRLF framing', () => {
        const parser = new SseParser();
        expect(parser.push('data: hello\r\n\r\n')).toEqual([{ data: 'hello' }]);
    });

    it('handles a CRLF split down the middle', () => {
        const parser = new SseParser();
        expect(parser.push('data: hello\r')).toEqual([]);
        expect(parser.push('\n\r\n')).toEqual([{ data: 'hello' }]);
    });

    it('flushes a final event that has no trailing blank line', () => {
        const parser = new SseParser();
        expect(parser.push('data: last')).toEqual([]);
        expect(parser.flush()).toEqual([{ data: 'last' }]);
    });

    it('flushes nothing when the buffer holds only whitespace', () => {
        const parser = new SseParser();
        parser.push('data: done\n\n');
        expect(parser.flush()).toEqual([]);
    });

    it('empties the buffer on flush so a second call yields nothing', () => {
        const parser = new SseParser();
        parser.push('data: last');
        expect(parser.flush()).toEqual([{ data: 'last' }]);
        expect(parser.flush()).toEqual([]);
    });

    it('reassembles a realistic streamed answer', () => {
        const parser = new SseParser();
        const events = [
            ...parser.push('data: {"choices":[{"delta":{"content":"Hel'),
            ...parser.push('lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n'),
            ...parser.push('data: [DONE]\n\n')
        ];

        const text = events
            .filter(event => !isDoneSentinel(event.data))
            .map(event => {
                const json = parseEventData(event.data) as {
                    choices?: { delta?: { content?: string } }[];
                };
                return json.choices?.[0]?.delta?.content ?? '';
            })
            .join('');

        expect(text).toBe('Hello world');
    });
});

describe('isDoneSentinel', () => {
    it('recognizes the sentinel with and without padding', () => {
        expect(isDoneSentinel('[DONE]')).toBe(true);
        expect(isDoneSentinel(' [DONE] ')).toBe(true);
    });

    it('does not mistake ordinary payloads for it', () => {
        expect(isDoneSentinel('{"done":true}')).toBe(false);
        expect(isDoneSentinel('')).toBe(false);
    });
});

describe('parseEventData', () => {
    it('parses JSON payloads', () => {
        expect(parseEventData('{"a":1}')).toEqual({ a: 1 });
    });

    it('returns undefined for malformed payloads rather than throwing', () => {
        // One corrupt chunk should cost that chunk, not the whole answer the
        // user has been watching arrive.
        expect(parseEventData('{"a":')).toBeUndefined();
        expect(parseEventData('[DONE]')).toBeUndefined();
    });
});
