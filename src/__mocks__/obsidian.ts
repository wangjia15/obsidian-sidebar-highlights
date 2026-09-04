/**
 * Minimal stand-in for the `obsidian` module under jest.
 *
 * Only the surface the AI layer touches is modelled. `requestUrl` is a jest
 * mock so tests can script provider responses — no test in this suite is
 * allowed to reach the network.
 */

export interface RequestUrlParam {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    throw?: boolean;
}

export interface RequestUrlResponse {
    status: number;
    text: string;
    json: unknown;
    headers: Record<string, string>;
}

export const requestUrl = jest.fn<Promise<RequestUrlResponse>, [RequestUrlParam]>();

/**
 * Bare class so `instanceof TFile` checks in the code under test behave; the
 * fields each test needs are assigned on the instance.
 */
export class TFile {
    path = '';
    basename = '';
}

/** i18n reads the locale off moment; English keeps the tests locale-independent. */
export const moment = {
    locale: () => 'en'
};

export class Notice {
    constructor(public message: string | DocumentFragment, public timeout?: number) {}
    hide(): void {}
}

export class Platform {
    static isMobile = false;
}
