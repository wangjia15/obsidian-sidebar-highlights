import { requestUrl } from 'obsidian';

/**
 * Shared scaffolding for the provider tests.
 *
 * Under jest, `obsidian` resolves to `src/__mocks__/obsidian.ts`, but `tsc`
 * still typechecks these files against the real Obsidian declarations. Rather
 * than repeat a cast in every test file, the one reconciliation lives here:
 * `requestUrl` is re-typed to the narrow shape the AI layer actually calls,
 * and responses are built with only the fields the layer reads.
 */

export interface MockRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    throw?: boolean;
}

export interface MockResponse {
    status: number;
    text: string;
    json: unknown;
    headers: Record<string, string>;
}

export const mockRequestUrl = requestUrl as unknown as jest.MockedFunction<(param: MockRequest) => Promise<MockResponse>>;

export function resetRequests(): void {
    mockRequestUrl.mockReset();
}

/** Queues one scripted response. A string body is sent verbatim, so a test can supply malformed JSON. */
export function respondWith(status: number, body: unknown): void {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    mockRequestUrl.mockResolvedValueOnce({ status, text, json: undefined, headers: {} });
}

/** Queues a response that never arrives, for the abort and timeout paths. */
export function respondNever(): void {
    mockRequestUrl.mockImplementation(() => new Promise<MockResponse>(() => { /* never settles */ }));
}

export function requestAt(index: number): MockRequest {
    const call = mockRequestUrl.mock.calls[index];
    if (!call) throw new Error(`No request was made at index ${index}`);
    return call[0];
}

export function lastRequest(): MockRequest {
    return requestAt(mockRequestUrl.mock.calls.length - 1);
}

export function lastRequestBody(): Record<string, unknown> {
    return JSON.parse(lastRequest().body ?? '{}') as Record<string, unknown>;
}
