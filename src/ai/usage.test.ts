import { addUsage, EMPTY_AI_USAGE, usageMonth, type AiUsageTotals } from './types';

describe('usageMonth', () => {
    it('formats as YYYY-MM with a padded month', () => {
        expect(usageMonth(new Date(2026, 0, 15))).toBe('2026-01');
        expect(usageMonth(new Date(2026, 11, 1))).toBe('2026-12');
    });
});

describe('addUsage', () => {
    const march: AiUsageTotals = { month: '2026-03', calls: 2, promptTokens: 100, completionTokens: 50 };

    it('adds to the running totals within the same month', () => {
        expect(addUsage(march, { promptTokens: 10, completionTokens: 5 }, '2026-03')).toEqual({
            month: '2026-03',
            calls: 3,
            promptTokens: 110,
            completionTokens: 55
        });
    });

    it('starts over in a new month', () => {
        expect(addUsage(march, { promptTokens: 10, completionTokens: 5 }, '2026-04')).toEqual({
            month: '2026-04',
            calls: 1,
            promptTokens: 10,
            completionTokens: 5
        });
    });

    it('counts a call whose provider reported no tokens', () => {
        // Ollama and LM Studio often omit usage; the call still happened.
        expect(addUsage(march, undefined, '2026-03')).toEqual({
            month: '2026-03',
            calls: 3,
            promptTokens: 100,
            completionTokens: 50
        });
    });

    it('tolerates a partially reported usage block', () => {
        expect(addUsage(march, { completionTokens: 7 }, '2026-03')).toEqual({
            month: '2026-03',
            calls: 3,
            promptTokens: 100,
            completionTokens: 57
        });
    });

    it('adopts the month on the first ever call', () => {
        expect(addUsage(EMPTY_AI_USAGE, { promptTokens: 4 }, '2026-05')).toEqual({
            month: '2026-05',
            calls: 1,
            promptTokens: 4,
            completionTokens: 0
        });
    });

    it('does not mutate the totals it was given', () => {
        const before = { ...march };
        addUsage(march, { promptTokens: 10 }, '2026-03');
        expect(march).toEqual(before);
    });
});
