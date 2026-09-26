import { minimalEdit } from './text-edit';

/** Applies an edit the way an editor would, so every case checks round-tripping. */
function apply(before: string, after: string): string {
    const edit = minimalEdit(before, after);
    if (!edit) return before;
    return before.slice(0, edit.from) + edit.text + before.slice(edit.to);
}

describe('minimalEdit', () => {
    it('returns null when nothing changed', () => {
        expect(minimalEdit('same', 'same')).toBeNull();
    });

    it('narrows to the changed word', () => {
        expect(minimalEdit('the quick brown fox', 'the quick red fox'))
            .toEqual({ from: 10, to: 15, text: 'red' });
    });

    it('narrows an insertion to a zero-width range', () => {
        expect(minimalEdit('ac', 'abc')).toEqual({ from: 1, to: 1, text: 'b' });
    });

    it('narrows a deletion to empty text', () => {
        expect(minimalEdit('abc', 'ac')).toEqual({ from: 1, to: 2, text: '' });
    });

    it('handles an append', () => {
        expect(minimalEdit('body', 'body\n\n## Summary\n\ntext\n'))
            .toEqual({ from: 4, to: 4, text: '\n\n## Summary\n\ntext\n' });
    });

    it('handles a replacement of the whole text', () => {
        expect(minimalEdit('abc', 'xyz')).toEqual({ from: 0, to: 3, text: 'xyz' });
    });

    it('handles becoming empty', () => {
        expect(minimalEdit('abc', '')).toEqual({ from: 0, to: 3, text: '' });
    });

    it('handles starting from empty', () => {
        expect(minimalEdit('', 'abc')).toEqual({ from: 0, to: 0, text: 'abc' });
    });

    const roundTrips = (before: string, after: string) => {
        expect(apply(before, after)).toBe(after);
    };

    it('round-trips a section rewrite', () => {
        roundTrips('Body.\n\n## Summary\n\nold\n', 'Body.\n\n## Summary\n\nnew answer\n');
    });

    it('round-trips scattered highlight markers as one span', () => {
        roundTrips('alpha beta. gamma delta.', '==alpha beta==. ==gamma delta==.');
    });

    it('round-trips a repeated string, where prefix and suffix could overlap', () => {
        roundTrips('aaaa', 'aaaaa');
        roundTrips('aaaaa', 'aaaa');
        roundTrips('aaa', 'aa');
    });

    it('never produces overlapping prefix and suffix claims', () => {
        const edit = minimalEdit('aaaa', 'aaaaa');
        expect(edit!.to).toBeGreaterThanOrEqual(edit!.from);
    });

    it('round-trips text with astral characters', () => {
        roundTrips('a 😀 b', 'a 😀 ==b==');
        roundTrips('😀😀', '😀🎉😀');
    });

    it('does not cut between the halves of a surrogate pair', () => {
        const edit = minimalEdit('😀x', '😀y');
        // The emoji occupies indices 0 and 1; a cut at 1 would be inside it.
        expect(edit!.from).not.toBe(1);
        expect(apply('😀x', '😀y')).toBe('😀y');
    });

    it('round-trips CJK text', () => {
        roundTrips('前面的话。重要的论断。后面的话。', '前面的话。==重要的论断==。后面的话。');
    });
});
