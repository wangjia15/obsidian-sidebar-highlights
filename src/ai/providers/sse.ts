/**
 * Server-sent event parsing, shared by every streaming provider.
 *
 * All three wire formats speak SSE, but they disagree about everything above
 * it: OpenAI ends with a `[DONE]` sentinel, Anthropic names its events and
 * Gemini just sends bare JSON objects. So this layer stops at the transport —
 * it hands back events, and each provider decides what they mean.
 *
 * Written as a stateful parser rather than a split on "\n\n" because chunks
 * arrive on network boundaries: a single event routinely spans two reads, and
 * a naive split silently drops the tail.
 */

export interface SseEvent {
    /** The `event:` field, when the provider names its events. */
    event?: string;
    /** Concatenated `data:` lines, newline-joined as the spec requires. */
    data: string;
}

export class SseParser {
    private buffer = '';

    /** Feeds one network chunk in and returns whatever events it completed. */
    push(chunk: string): SseEvent[] {
        // Normalize line endings first: a CRLF split across two chunks would
        // otherwise leave a stray CR at the head of the next field name.
        this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        const events: SseEvent[] = [];
        let boundary = this.buffer.indexOf('\n\n');

        while (boundary !== -1) {
            const block = this.buffer.slice(0, boundary);
            this.buffer = this.buffer.slice(boundary + 2);

            const event = parseBlock(block);
            if (event) events.push(event);

            boundary = this.buffer.indexOf('\n\n');
        }

        return events;
    }

    /**
     * Events left in the buffer when the stream ends.
     *
     * Some providers close without a trailing blank line, which would strand
     * the final — often the most interesting — event.
     */
    flush(): SseEvent[] {
        const remaining = this.buffer.trim();
        this.buffer = '';
        if (!remaining) return [];

        const event = parseBlock(remaining);
        return event ? [event] : [];
    }
}

function parseBlock(block: string): SseEvent | null {
    const dataLines: string[] = [];
    let name: string | undefined;

    for (const line of block.split('\n')) {
        // A line starting with ':' is a comment, used as a keep-alive.
        if (line === '' || line.startsWith(':')) continue;

        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        // Exactly one optional leading space is part of the framing, per spec.
        const rest = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

        if (field === 'data') dataLines.push(rest);
        else if (field === 'event') name = rest;
    }

    if (dataLines.length === 0) return null;
    return name === undefined ? { data: dataLines.join('\n') } : { event: name, data: dataLines.join('\n') };
}

/** OpenAI's end-of-stream sentinel, which is not JSON and must not be parsed. */
export function isDoneSentinel(data: string): boolean {
    return data.trim() === '[DONE]';
}

/**
 * Parses an event's payload, returning undefined rather than throwing.
 *
 * A malformed chunk mid-stream should cost the user that chunk, not the whole
 * answer they have been watching arrive.
 */
export function parseEventData(data: string): unknown {
    try {
        return JSON.parse(data);
    } catch {
        return undefined;
    }
}
