import {
    buildExcalidrawMindmapFile,
    buildMindmapScene,
    buildMindmapTree,
    darken,
    measureText,
    mixWithWhite,
    readableTextColor,
    sanitizeFileName,
    wrapLabel,
    type ExcalidrawElement,
    type MindmapNoteInput
} from './excalidraw-mindmap';

const note = (overrides: Partial<MindmapNoteInput> = {}): MindmapNoteInput => ({
    title: 'Reading notes',
    headings: [],
    highlights: [],
    ...overrides
});

const labels = (node: { label: string; children: Array<{ label: string; children: unknown[] }> }): string[] =>
    node.children.map(child => child.label);

describe('buildMindmapTree', () => {
    it('makes the note title the root of a single-note export', () => {
        const tree = buildMindmapTree([note({
            highlights: [{ text: 'first', line: 1 }]
        })]);

        expect(tree?.kind).toBe('note');
        expect(tree?.label).toBe('Reading notes');
        expect(labels(tree!)).toEqual(['first']);
    });

    it('nests headings by level and hangs highlights off the heading above them', () => {
        const tree = buildMindmapTree([note({
            headings: [
                { heading: 'Chapter 1', level: 1, line: 0 },
                { heading: 'Section A', level: 2, line: 4 },
                { heading: 'Chapter 2', level: 1, line: 10 }
            ],
            highlights: [
                { text: 'under chapter 1', line: 2 },
                { text: 'under section A', line: 6 },
                { text: 'under chapter 2', line: 12 }
            ]
        })]);

        expect(labels(tree!)).toEqual(['Chapter 1', 'Chapter 2']);

        const chapterOne = tree!.children[0];
        expect(labels(chapterOne)).toEqual(['under chapter 1', 'Section A']);
        expect(labels(chapterOne.children[1])).toEqual(['under section A']);
        expect(labels(tree!.children[1])).toEqual(['under chapter 2']);
    });

    it('hangs highlights that precede every heading off the note itself', () => {
        const tree = buildMindmapTree([note({
            headings: [{ heading: 'Later', level: 1, line: 5 }],
            highlights: [{ text: 'intro quote', line: 1 }]
        })]);

        expect(labels(tree!)).toEqual(['intro quote', 'Later']);
    });

    it('retains headings that hold no highlights', () => {
        const tree = buildMindmapTree([note({
            headings: [
                { heading: 'Empty', level: 1, line: 0 },
                { heading: 'Used', level: 1, line: 5 }
            ],
            highlights: [{ text: 'kept', line: 6 }]
        })]);

        expect(labels(tree!)).toEqual(['Empty', 'Used']);
    });

    it('renders comments as children of their highlight', () => {
        const tree = buildMindmapTree([note({
            highlights: [{ text: 'quote', line: 1, comments: ['why it matters', 'follow up'] }]
        })]);

        expect(labels(tree!.children[0])).toEqual(['why it matters', 'follow up']);
    });

    it('leaves comments out when they are switched off', () => {
        const tree = buildMindmapTree([
            note({ highlights: [{ text: 'quote', line: 1, comments: ['note'] }] })
        ], { includeComments: false });

        expect(tree!.children[0].children).toEqual([]);
    });

    it('adds a shared root above several notes', () => {
        const tree = buildMindmapTree([
            note({ title: 'One', highlights: [{ text: 'a', line: 1 }] }),
            note({ title: 'Two', highlights: [{ text: 'b', line: 1 }] })
        ], { rootLabel: 'Highlights' });

        expect(tree?.kind).toBe('root');
        expect(tree?.label).toBe('Highlights');
        expect(labels(tree!)).toEqual(['One', 'Two']);
    });

    it('imports heading-only notes and returns null when nothing is left', () => {
        expect(buildMindmapTree([note({ headings: [{ heading: 'H', level: 1, line: 0 }] })])?.children[0].label).toBe('H');
        expect(buildMindmapTree([])).toBeNull();
    });

    it('collapses a multi-line highlight into a single label', () => {
        const tree = buildMindmapTree([note({
            highlights: [{ text: 'first line\n  second line', line: 1 }]
        })]);

        expect(tree!.children[0].label).toBe('first line second line');
    });

    it('carries the highlight colour onto the node and its comments', () => {
        const tree = buildMindmapTree([note({
            highlights: [{ text: 'quote', line: 1, color: '#ff6b6b', comments: ['note'] }]
        })]);

        expect(tree!.children[0].color).toBe('#ff6b6b');
        expect(tree!.children[0].children[0].color).toBe('#ff6b6b');
    });
});

describe('wrapLabel', () => {
    it('breaks latin text on spaces', () => {
        const lines = wrapLabel('the quick brown fox jumps', 60, 14, 10);
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.join(' ').replace(/\s+/g, ' ')).toBe('the quick brown fox jumps');
    });

    it('breaks full-width text between characters', () => {
        const lines = wrapLabel('这是一段很长的中文文本内容', 42, 14, 10);
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.join('')).toBe('这是一段很长的中文文本内容');
    });

    it('breaks a word that cannot fit on a line of its own', () => {
        const lines = wrapLabel('supercalifragilistic', 40, 14, 10);
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.join('')).toBe('supercalifragilistic');
    });

    it('truncates with an ellipsis past the line budget', () => {
        const lines = wrapLabel('one two three four five six seven eight nine ten', 40, 14, 2);
        expect(lines).toHaveLength(2);
        expect(lines[1].endsWith('…')).toBe(true);
    });

    it('always returns at least one line', () => {
        expect(wrapLabel('', 100, 14, 4)).toEqual(['']);
    });
});

describe('measureText', () => {
    it('counts full-width characters as wider than latin ones', () => {
        expect(measureText('中文', 14)).toBeGreaterThan(measureText('ab', 14));
    });
});

describe('colour helpers', () => {
    it('washes a colour toward white', () => {
        expect(mixWithWhite('#000000', 0.5)).toBe('#808080');
    });

    it('darkens a colour', () => {
        expect(darken('#ffffff', 0.5)).toBe('#808080');
    });

    it('expands shorthand hex', () => {
        expect(darken('#fff', 0)).toBe('#ffffff');
    });

    it('falls back rather than emitting an invalid colour', () => {
        expect(mixWithWhite('not a colour', 0.5)).toBe('#f8f9fa');
        expect(darken('not a colour', 0.5)).toBe('#1e1e1e');
    });
});

describe('readableTextColor', () => {
    it('tints the label with a deep shade of its own fill on light colours', () => {
        expect(readableTextColor('#ffd700')).toBe(darken('#ffd700', 0.82));
        expect(readableTextColor('#96ceb4')).toBe(darken('#96ceb4', 0.82));
    });

    it('goes white on a fill too dark to read dark ink on', () => {
        expect(readableTextColor('#1971c2')).toBe('#ffffff');
        expect(readableTextColor('#000000')).toBe('#ffffff');
    });

    it('falls back to near-black rather than emitting an invalid colour', () => {
        expect(readableTextColor('not a colour')).toBe('#1e1e1e');
    });
});

describe('buildMindmapScene', () => {
    const tree = buildMindmapTree([note({
        headings: [{ heading: 'Chapter 1', level: 1, line: 0 }],
        highlights: [{ text: 'a quote', line: 2, color: '#ffd700', comments: ['a comment'] }]
    })])!;

    const scene = buildMindmapScene(tree, { seed: 7 });
    const byType = (type: string) => scene.elements.filter(element => element.type === type);

    it('emits a container and a bound text element per node', () => {
        // note + heading + highlight + comment
        expect(byType('rectangle')).toHaveLength(4);
        expect(byType('text')).toHaveLength(4);
    });

    it('emits one arrow per parent/child edge', () => {
        expect(byType('arrow')).toHaveLength(3);
    });

    it('binds every text element to its container and back', () => {
        for (const text of byType('text')) {
            const container = byType('rectangle').find(rect => rect.id === text.containerId);
            expect(container).toBeDefined();
            const bound = container!.boundElements as Array<{ id: string; type: string }>;
            expect(bound.some(entry => entry.id === text.id && entry.type === 'text')).toBe(true);
        }
    });

    it('binds both ends of every arrow to elements in the scene', () => {
        const ids = new Set(scene.elements.map(element => element.id));
        for (const arrow of byType('arrow')) {
            const start = arrow.startBinding as { elementId: string };
            const end = arrow.endBinding as { elementId: string };
            expect(ids.has(start.elementId)).toBe(true);
            expect(ids.has(end.elementId)).toBe(true);
        }
    });

    it('fills the highlight node with the highlight colour and its comment with a lighter tint', () => {
        const rects = byType('rectangle');
        const texts = byType('text');
        const rectFor = (label: string) => {
            const text = texts.find(element => element.originalText === label);
            return rects.find(rect => rect.id === text?.containerId);
        };

        expect(rectFor('a quote')?.backgroundColor).toBe('#ffd700');
        expect(rectFor('a comment')?.backgroundColor).toBe(mixWithWhite('#ffd700', 0.72));
    });

    it('places each depth in its own column, growing to the right', () => {
        const rects = byType('rectangle');
        const texts = byType('text');
        const xFor = (label: string) => {
            const text = texts.find(element => element.originalText === label);
            return rects.find(rect => rect.id === text?.containerId)?.x as number;
        };

        expect(xFor('Reading notes')).toBeLessThan(xFor('Chapter 1'));
        expect(xFor('Chapter 1')).toBeLessThan(xFor('a quote'));
        expect(xFor('a quote')).toBeLessThan(xFor('a comment'));
    });

    it('never overlaps two sibling boxes', () => {
        const wide = buildMindmapTree([note({
            highlights: Array.from({ length: 6 }, (_, index) => ({ text: `quote ${index}`, line: index }))
        })])!;
        const rects = buildMindmapScene(wide, { seed: 1 }).elements
            .filter(element => element.type === 'rectangle')
            .map(element => ({ x: element.x as number, y: element.y as number, height: element.height as number }))
            .filter(box => box.x > 0)
            .sort((a, b) => a.y - b.y);

        for (let i = 1; i < rects.length; i++) {
            expect(rects[i].y).toBeGreaterThanOrEqual(rects[i - 1].y + rects[i - 1].height);
        }
    });

    // The Excalidraw plugin's Mindmap Builder script reads a drawing as a mind
    // map through customData: a root carries growthMode with no branch arrow
    // pointing at it, every other node carries its 0-based mindmapOrder, and
    // parent and child are joined by an arrow carrying isBranch.
    describe('Mindmap Builder compatibility', () => {
        const rects = byType('rectangle');
        const texts = byType('text');
        const arrows = byType('arrow');
        const rectFor = (label: string) => {
            const text = texts.find(element => element.originalText === label);
            return rects.find(rect => rect.id === text?.containerId)!;
        };

        it('marks the note node as the root and nothing else', () => {
            const roots = rects.filter(rect => (rect.customData as { growthMode?: string })?.growthMode);
            expect(roots).toHaveLength(1);
            expect(roots[0].id).toBe(rectFor('Reading notes').id);
            expect((roots[0].customData as { growthMode: string }).growthMode).toBe('Right-facing');
        });

        it('leaves the root with no branch arrow pointing at it', () => {
            const rootId = rectFor('Reading notes').id;
            expect(arrows.some(arrow => (arrow.endBinding as { elementId: string }).elementId === rootId)).toBe(false);
        });

        it('gives every non-root node its position among its siblings', () => {
            const rootId = rectFor('Reading notes').id;
            for (const rect of rects) {
                if (rect.id === rootId) continue;
                expect(typeof (rect.customData as { mindmapOrder?: number })?.mindmapOrder).toBe('number');
            }
            // The heading is an only child; so is the highlight beneath it.
            expect((rectFor('Chapter 1').customData as { mindmapOrder: number }).mindmapOrder).toBe(0);
            expect((rectFor('a quote').customData as { mindmapOrder: number }).mindmapOrder).toBe(0);
        });

        it('numbers siblings from zero, in order', () => {
            const siblings = buildMindmapTree([note({
                highlights: [
                    { text: 'first', line: 1 },
                    { text: 'second', line: 2 },
                    { text: 'third', line: 3 }
                ]
            })])!;
            const scene = buildMindmapScene(siblings, { seed: 2 });
            const sceneTexts = scene.elements.filter(element => element.type === 'text');
            const orderOf = (label: string) => {
                const text = sceneTexts.find(element => element.originalText === label);
                const rect = scene.elements.find(element => element.id === text?.containerId);
                return (rect?.customData as { mindmapOrder: number }).mindmapOrder;
            };

            expect([orderOf('first'), orderOf('second'), orderOf('third')]).toEqual([0, 1, 2]);
        });

        it('marks every connector as a branch, bound start-to-parent and end-to-child', () => {
            expect(arrows.length).toBeGreaterThan(0);
            for (const arrow of arrows) {
                expect((arrow.customData as { isBranch: boolean }).isBranch).toBe(true);
                expect(arrow.type).toBe('arrow');
            }

            const parentToChild = arrows.find(arrow =>
                (arrow.startBinding as { elementId: string }).elementId === rectFor('a quote').id
            );
            expect((parentToChild?.endBinding as { elementId: string }).elementId).toBe(rectFor('a comment').id);
        });

        it('lists each branch arrow on the elements at both of its ends', () => {
            for (const arrow of arrows) {
                for (const end of ['startBinding', 'endBinding'] as const) {
                    const node = rects.find(rect => rect.id === (arrow[end] as { elementId: string }).elementId)!;
                    const bound = node.boundElements as Array<{ id: string; type: string }>;
                    expect(bound.some(entry => entry.id === arrow.id && entry.type === 'arrow')).toBe(true);
                }
            }
        });

        it('takes a different growth direction when asked for one', () => {
            const radial = buildMindmapScene(tree, { seed: 7, growthMode: 'Radial' });
            const root = radial.elements.find(element =>
                (element.customData as { growthMode?: string })?.growthMode
            );
            expect((root?.customData as { growthMode: string }).growthMode).toBe('Radial');
        });
    });

    it('draws the same scene every time, down to the element ids', () => {
        // `updated` is the only value that moves on its own, and only because it
        // is a wall-clock stamp; everything else is derived from the tree.
        expect(JSON.stringify(buildMindmapScene(tree, { seed: 7, updated: 1 })))
            .toBe(JSON.stringify(buildMindmapScene(tree, { seed: 7, updated: 1 })));
    });
});

describe('buildExcalidrawMarkdown', () => {
    const content = buildExcalidrawMindmapFile([note({
        highlights: [{ text: 'a quote', line: 1, comments: ['a comment'] }]
    })], { seed: 3 })!;

    it('marks the file as an Excalidraw drawing', () => {
        expect(content.startsWith('---\n')).toBe(true);
        expect(content).toContain('excalidraw-plugin: parsed');
        expect(content).toContain('tags: [excalidraw]');
    });

    it('hides the scene JSON inside a native comment so reading view stays clean', () => {
        expect(content).toContain('\n%%\n## Drawing\n```json\n');
        expect(content.trimEnd().endsWith('```\n%%')).toBe(true);
    });

    // Eight characters exactly: the Excalidraw plugin reads this section back
    // with `\s\^(.{8})\n`, so a longer id silently fails to round-trip.
    it('lists every text element with an eight-character element id', () => {
        expect(content).toMatch(/^a quote \^[A-Za-z0-9]{8}$/m);
        expect(content).toMatch(/^a comment \^[A-Za-z0-9]{8}$/m);
    });

    it('embeds a scene that parses back as JSON', () => {
        const json = /```json\n([\s\S]*?)\n```/.exec(content)?.[1];
        expect(json).toBeDefined();
        const scene = JSON.parse(json!) as { type: string; elements: ExcalidrawElement[] };
        expect(scene.type).toBe('excalidraw');
        expect(scene.elements.length).toBeGreaterThan(0);
    });

    it('returns null when there is nothing to draw', () => {
        expect(buildExcalidrawMindmapFile([])).toBeNull();
    });

    // The Obsidian Excalidraw plugin writes `rawText` back into the Text
    // Elements section on every save. Without it the entry saves empty and the
    // label vanishes the next time the file loads.
    it('gives every text element a rawText', () => {
        const scene = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(content)![1]) as { elements: ExcalidrawElement[] };
        const texts = scene.elements.filter(element => element.type === 'text');

        expect(texts.length).toBeGreaterThan(0);
        for (const text of texts) {
            expect(text.rawText).toBe(text.originalText);
            expect(text.rawText).not.toBe('');
        }
    });

    it('records where the map came from, so it can be refreshed', () => {
        const withSources = buildExcalidrawMindmapFile([note({
            highlights: [{ text: 'a quote', line: 1 }]
        })], { sources: ['Reading/Notes: one.md'] })!;

        expect(withSources).toContain('sidebar-highlights-mindmap: true');
        expect(withSources).toContain('sidebar-highlights-sources:\n  - "Reading/Notes: one.md"');
    });

    it('marks a map with no recorded sources as ours all the same', () => {
        expect(content).toContain('sidebar-highlights-mindmap: true');
        expect(content).not.toContain('sidebar-highlights-sources:');
    });
});

describe('element ids across a refresh', () => {
    const build = (highlights: Array<{ text: string; line: number }>) => {
        const tree = buildMindmapTree([note({
            headings: [{ heading: 'Chapter 1', level: 1, line: 0 }],
            highlights
        })])!;
        const scene = buildMindmapScene(tree, { updated: 1 });
        const idOf = (label: string) => {
            const text = scene.elements.find(element => element.originalText === label);
            return { textId: text?.id, boxId: text?.containerId as string | undefined };
        };
        return { scene, idOf };
    };

    const before = build([{ text: 'first', line: 1 }, { text: 'second', line: 2 }]);

    it('keeps the same ids when the map is rebuilt unchanged', () => {
        const again = build([{ text: 'first', line: 1 }, { text: 'second', line: 2 }]);
        expect(again.idOf('first')).toEqual(before.idOf('first'));
        expect(again.idOf('second')).toEqual(before.idOf('second'));
    });

    it('keeps existing nodes stable when a highlight is added', () => {
        const after = build([
            { text: 'first', line: 1 },
            { text: 'inserted', line: 2 },
            { text: 'second', line: 3 }
        ]);

        expect(after.idOf('first')).toEqual(before.idOf('first'));
        expect(after.idOf('second')).toEqual(before.idOf('second'));
        expect(after.idOf('inserted').boxId).toBeDefined();
    });

    it('gives siblings that share a label ids of their own', () => {
        const { scene } = build([{ text: 'same', line: 1 }, { text: 'same', line: 2 }]);
        const boxes = scene.elements
            .filter(element => element.originalText === 'same')
            .map(element => element.containerId);

        expect(boxes).toHaveLength(2);
        expect(boxes[0]).not.toBe(boxes[1]);
    });

    it('never issues the same id to two elements', () => {
        const { scene } = build([
            { text: 'same', line: 1 },
            { text: 'same', line: 2 },
            { text: 'other', line: 3 }
        ]);
        const ids = scene.elements.map(element => element.id);

        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('links back to the note', () => {
    const scene = (path?: string) => buildMindmapScene(buildMindmapTree([note({
        path,
        headings: [{ heading: 'Chapter 1', level: 1, line: 5 }],
        highlights: [
            { text: 'before any heading', line: 1 },
            { text: 'a quote', line: 7, comments: ['a comment'] }
        ]
    })])!, { updated: 1 });

    const linkFor = (label: string, path?: string) => {
        const built = scene(path);
        const text = built.elements.find(element => element.originalText === label);
        return built.elements.find(element => element.id === text?.containerId)?.link;
    };

    it('links the note node to its note', () => {
        expect(linkFor('Reading notes', 'Books/Reading notes.md')).toBe('[[Books/Reading notes]]');
    });

    it('links a heading node to that heading', () => {
        expect(linkFor('Chapter 1', 'Books/Reading notes.md')).toBe('[[Books/Reading notes#Chapter 1]]');
    });

    it('links a highlight to the heading it sits under', () => {
        expect(linkFor('a quote', 'Books/Reading notes.md')).toBe('[[Books/Reading notes#Chapter 1]]');
    });

    it('links a highlight above every heading to the note itself', () => {
        expect(linkFor('before any heading', 'Books/Reading notes.md')).toBe('[[Books/Reading notes]]');
    });

    it('gives a comment the same link as the highlight it belongs to', () => {
        expect(linkFor('a comment', 'Books/Reading notes.md')).toBe('[[Books/Reading notes#Chapter 1]]');
    });

    it('leaves the link empty when no note path is known', () => {
        expect(linkFor('a quote')).toBeNull();
    });

    it('strips characters that would end the link or start an alias', () => {
        const built = buildMindmapScene(buildMindmapTree([note({
            path: 'Note.md',
            headings: [{ heading: 'A # B | C [d]', level: 1, line: 0 }],
            highlights: [{ text: 'a quote', line: 2 }]
        })])!, { updated: 1 });
        const text = built.elements.find(element => element.originalText === 'a quote');
        expect(built.elements.find(element => element.id === text?.containerId)?.link)
            .toBe('[[Note#A  B  C d]]');
    });
});

describe('sanitizeFileName', () => {
    it('strips characters Obsidian rejects in a file name', () => {
        expect(sanitizeFileName('a/b:c*d?e"f<g>h|i#j^k[l]m')).toBe('a-b-c-d-e-f-g-h-i-j-k-l-m');
    });

    it('falls back to a usable name when nothing is left', () => {
        expect(sanitizeFileName('  ///  ')).toBe('---');
        expect(sanitizeFileName('')).toBe('Highlights');
        expect(sanitizeFileName('   ')).toBe('Highlights');
    });
});


it('sizes comment containers for the entire long AI answer', () => {
    const answer = '这是很长的解释包含全部内容'.repeat(150);
    const tree = buildMindmapTree([note({ highlights: [{ text: 'quote', line: 1, comments: [answer] }] })])!;
    const scene = buildMindmapScene(tree);
    const text = scene.elements.find(element => element.type === 'text' && element.rawText === answer)!;
    const box = scene.elements.find(element => element.id === text.containerId)!;
    expect((text.text as string).replace(/\n/g, '')).toBe(answer);
    expect(box.height).toBeGreaterThan(Number(text.height));
    expect(box.width).toBeGreaterThan(Number(text.width));
    expect(text.y).toBeGreaterThanOrEqual(Number(box.y));
    expect(Number(text.y) + Number(text.height)).toBeLessThanOrEqual(Number(box.y) + Number(box.height));
});
