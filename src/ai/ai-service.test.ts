import { AiService, createProfileForProvider, describeAiError, logSafe } from './ai-service';
import { PROVIDERS, isBuiltinProvider, isMissingRequiredKey, resolveProviderKind } from './registry';
import { AiError, DEFAULT_AI_SETTINGS, cloneAiSettings, type AiProfile, type AiSettings } from './types';
import { i18n } from '../i18n';
import { mockRequestUrl, requestAt, resetRequests, respondNever, respondWith as respond } from './test-support';

// Without this the translator has no dictionary loaded and echoes raw keys, so
// assertions on user-facing text would pass against the key rather than the
// sentence a user actually sees.
beforeAll(async () => {
    await i18n.init();
});

function profile(overrides: Partial<AiProfile> = {}): AiProfile {
    return {
        id: 'p1',
        name: 'Test',
        providerId: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o-mini',
        ...overrides
    };
}

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
    return { ...cloneAiSettings(DEFAULT_AI_SETTINGS), enabled: true, ...overrides };
}

describe('AiService readiness', () => {
    it('reports the master switch first, before any profile problem', () => {
        const service = new AiService(() => settings({ enabled: false, profiles: [] }));

        expect(service.checkReadiness()?.reasonKey).toBe('ai.readiness.disabled');
    });

    it('reports a missing profile', () => {
        const service = new AiService(() => settings({ profiles: [] }));

        expect(service.checkReadiness()?.reasonKey).toBe('ai.readiness.noProfile');
    });

    it.each([
        [{ baseUrl: '  ' }, 'ai.readiness.noBaseUrl'],
        [{ model: '' }, 'ai.readiness.noModel'],
        [{ apiKey: '' }, 'ai.readiness.noApiKey']
    ])('reports %o as %s', (overrides, reasonKey) => {
        const target = profile(overrides);
        const service = new AiService(() => settings({ profiles: [target], activeProfileId: target.id }));

        expect(service.checkReadiness()?.reasonKey).toBe(reasonKey);
    });

    it('accepts a keyless profile when the provider does not need one', () => {
        const target = profile({ providerId: 'ollama', apiKey: '', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' });
        const service = new AiService(() => settings({ profiles: [target], activeProfileId: target.id }));

        expect(service.checkReadiness()).toBeNull();
        expect(service.isReady()).toBe(true);
    });

    it('accepts a keyless custom endpoint, since a local one may need no key', () => {
        const target = profile({ providerId: 'custom', apiKey: '', baseUrl: 'http://localhost:8080/v1', model: 'local' });
        const service = new AiService(() => settings({ profiles: [target], activeProfileId: target.id }));

        expect(service.checkReadiness()).toBeNull();
    });

    it('refuses to send while the readiness check fails', async () => {
        resetRequests();
        const service = new AiService(() => settings({ enabled: false }));

        await expect(service.complete([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(AiError);
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });
});

describe('AiService profile selection', () => {
    it('falls back to the first profile when the active id is stale', () => {
        const a = profile({ id: 'a' });
        const b = profile({ id: 'b' });
        const service = new AiService(() => settings({ profiles: [a, b], activeProfileId: 'deleted' }));

        expect(service.getActiveProfile()?.id).toBe('a');
    });

    it('returns null when there are no profiles at all', () => {
        const service = new AiService(() => settings({ profiles: [] }));

        expect(service.getActiveProfile()).toBeNull();
    });

    it('reads settings live, so an edit takes effect without rebuilding the service', () => {
        const live = settings({ profiles: [profile({ id: 'a' })], activeProfileId: 'a' });
        const service = new AiService(() => live);

        expect(service.getActiveProfile()?.model).toBe('gpt-4o-mini');
        live.profiles[0].model = 'gpt-4o';
        expect(service.getActiveProfile()?.model).toBe('gpt-4o');
    });

    it('routes each provider kind to its own implementation', () => {
        const service = new AiService(() => settings());

        expect(service.providerFor(profile({ providerId: 'deepseek' })).kind).toBe('openai-compatible');
        expect(service.providerFor(profile({ providerId: 'anthropic' })).kind).toBe('anthropic');
        expect(service.providerFor(profile({ providerId: 'gemini' })).kind).toBe('gemini');
        expect(service.providerFor(profile({ providerId: 'custom', customKind: 'anthropic' })).kind).toBe('anthropic');
    });
});

describe('AiService requests', () => {
    beforeEach(() => {
        resetRequests();
    });

    it('sends a deliberately tiny request when testing a connection', async () => {
        respond(200, { model: 'gpt-4o-mini', choices: [{ message: { content: 'ok' } }] });
        const target = profile();
        const service = new AiService(() => settings({ profiles: [target], activeProfileId: target.id }));

        const model = await service.testConnection(target);

        const body = JSON.parse(requestAt(0).body ?? '{}') as Record<string, unknown>;
        expect(body.max_tokens).toBe(16);
        expect(model).toBe('gpt-4o-mini');
    });

    it('refuses to list models for a provider that cannot', async () => {
        const target = profile({ providerId: 'anthropic' });
        const service = new AiService(() => settings({ profiles: [target], activeProfileId: target.id }));

        await expect(service.listModels(target)).rejects.toBeInstanceOf(AiError);
        expect(mockRequestUrl).not.toHaveBeenCalled();
    });

    it('honours the configured timeout rather than a hardcoded one', async () => {
        jest.useFakeTimers();
        respondNever();
        const target = profile();
        const service = new AiService(() => settings({ profiles: [target], activeProfileId: target.id, requestTimeoutMs: 25 }));

        const pending = service.complete([{ role: 'user', content: 'hi' }]);
        const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
        jest.advanceTimersByTime(26);

        await assertion;
        jest.useRealTimers();
    });
});

describe('error presentation', () => {
    it('describes a known error kind without leaking the raw body', () => {
        const described = describeAiError(new AiError('auth', 'HTTP 401', { detail: 'Incorrect API key provided' }));

        expect(described).toContain('Incorrect API key provided');
        expect(described).not.toContain('HTTP 401');
    });

    it('describes an unrecognized throw without crashing', () => {
        expect(typeof describeAiError('boom')).toBe('string');
    });

    it('keeps a log line free of anything key-shaped', () => {
        const line = logSafe(new AiError('auth', 'rejected sk-abcd1234efgh5678'));

        expect(line).not.toContain('abcd1234efgh5678');
    });
});

describe('registry', () => {
    it('gives every builtin provider a usable default profile', () => {
        for (const id of Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]) {
            const created = createProfileForProvider(id, `id-${id}`);

            expect(created.baseUrl).toBe(PROVIDERS[id].defaultBaseUrl);
            expect(created.model).toBe(PROVIDERS[id].defaultModel);
            expect(created.apiKey).toBe('');
            expect(PROVIDERS[id].suggestedModels).toContain(PROVIDERS[id].defaultModel);
        }
    });

    it('leaves a custom profile blank for the user to fill in', () => {
        const created = createProfileForProvider('custom', 'id-custom');

        expect(created.baseUrl).toBe('');
        expect(created.customKind).toBe('openai-compatible');
    });

    it('resolves the wire format from the registry for builtin providers', () => {
        expect(resolveProviderKind(profile({ providerId: 'moonshot' }))).toBe('openai-compatible');
        expect(resolveProviderKind(profile({ providerId: 'gemini' }))).toBe('gemini');
    });

    it('defaults a custom profile with no stated format to OpenAI compatible', () => {
        expect(resolveProviderKind(profile({ providerId: 'custom', customKind: undefined }))).toBe('openai-compatible');
    });

    it('recognizes builtin ids and rejects anything else', () => {
        expect(isBuiltinProvider('deepseek')).toBe(true);
        expect(isBuiltinProvider('custom')).toBe(false);
        expect(isBuiltinProvider('toString')).toBe(false);
    });

    it('flags a missing key only where the provider requires one', () => {
        expect(isMissingRequiredKey(profile({ apiKey: '' }))).toBe(true);
        expect(isMissingRequiredKey(profile({ apiKey: '  ' }))).toBe(true);
        expect(isMissingRequiredKey(profile({ providerId: 'ollama', apiKey: '' }))).toBe(false);
        expect(isMissingRequiredKey(profile({ providerId: 'custom', apiKey: '' }))).toBe(false);
    });
});

describe('cloneAiSettings', () => {
    it('copies profiles deeply, so an edit cannot reach the defaults', () => {
        const copy = cloneAiSettings({ ...DEFAULT_AI_SETTINGS, profiles: [profile()] });
        copy.profiles[0].apiKey = 'changed';

        expect(DEFAULT_AI_SETTINGS.profiles).toHaveLength(0);
        expect(copy.profiles[0].apiKey).toBe('changed');
    });

    it('leaves the shipped defaults with AI switched off', () => {
        expect(DEFAULT_AI_SETTINGS.enabled).toBe(false);
        expect(DEFAULT_AI_SETTINGS.includeNoteContext).toBe(false);
        expect(DEFAULT_AI_SETTINGS.confirmBeforeSend).toBe(true);
    });
});
