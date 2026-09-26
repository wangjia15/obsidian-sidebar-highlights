import { t } from '../i18n';

/** Completion counts always come first; a zero-mark run also offers a next step. */
export function extractionCompletionMessage(counts: { marked: number; already: number; missed: number }): string {
    const summary = t('ai.note.markedSummary', counts);
    return counts.marked === 0 ? summary + t('ai.note.markedNone') : summary;
}
