import { buildExcalidrawMindmapFile, buildMindmapScene, buildMindmapTree, readThemeChoice } from './excalidraw-mindmap';
import { EXCALIDRAW_THEMES, resolveTheme } from './excalidraw-theme';

const tree = () => buildMindmapTree([{
    title: 'Note', headings: [{ heading: 'H', level: 1, line: 0 }],
    highlights: [{ text: 'hello', line: 1, color: '#ffec99', comments: ['c'] }]
}])!;

describe('resolveTheme', () => {
    it('falls back to classic for an unknown theme', () => {
        expect(resolveTheme({ theme: 'nope' }).id).toBe('classic');
    });
    it('lets font and background override the theme', () => {
        const theme = resolveTheme({ theme: 'dark', fontFamily: 3, background: '#112233' });
        expect(theme.fontFamily).toBe(3);
        expect(theme.background).toBe('#112233');
    });
    it('ignores an invalid font or colour', () => {
        const theme = resolveTheme({ theme: 'dark', fontFamily: 99, background: 'red' });
        expect(theme.fontFamily).toBe(EXCALIDRAW_THEMES.dark.fontFamily);
        expect(theme.background).toBe(EXCALIDRAW_THEMES.dark.background);
    });
});

describe('scene theme', () => {
    it('defaults to the classic look', () => {
        const scene = buildMindmapScene(tree(), { updated: 1 });
        expect(scene.appState.viewBackgroundColor).toBe('#ffffff');
        expect(scene.elements.filter(e => e.type === 'text').every(e => e.fontFamily === 2)).toBe(true);
        expect(scene.elements.every(e => e.roughness === undefined || e.roughness === 1)).toBe(true);
    });

    it('applies background, font and roughness everywhere', () => {
        const scene = buildMindmapScene(tree(), { updated: 1, theme: { theme: 'sketch', background: '#101010' } });
        expect(scene.appState.viewBackgroundColor).toBe('#101010');
        expect(scene.elements.filter(e => e.type === 'text').every(e => e.fontFamily === 5)).toBe(true);
        expect(scene.elements.every(e => e.roughness === 2)).toBe(true);
    });

    it('uses light ink on structural nodes in a dark theme but keeps highlight contrast', () => {
        const scene = buildMindmapScene(tree(), { updated: 1, theme: { theme: 'dark' } });
        const ink = (label: string) => scene.elements.find(e => e.type === 'text' && e.originalText === label)!.strokeColor;
        expect(ink('Note')).toBe('#e6e6f0');
        expect(ink('hello')).not.toBe('#e6e6f0');
    });

    it('keeps the highlight fill whatever the theme', () => {
        const scene = buildMindmapScene(tree(), { updated: 1, theme: { theme: 'blueprint' } });
        expect(scene.elements.some(e => e.type === 'rectangle' && e.backgroundColor === '#ffec99')).toBe(true);
    });
});

describe('theme recorded in the file', () => {
    const notes = [{ title: 'Note', headings: [], highlights: [{ text: 'hi', line: 1, color: '#a78bfa' }] }];

    it('writes the theme, font and background into the frontmatter', () => {
        const md = buildExcalidrawMindmapFile(notes, { theme: { theme: 'dark', fontFamily: 3, background: '#112233' } })!;
        expect(md).toContain('sidebar-highlights-theme: "dark"');
        expect(md).toContain('sidebar-highlights-font: 3');
        expect(md).toContain('sidebar-highlights-background: "#112233"');
    });

    it('reads it back', () => {
        expect(readThemeChoice({ 'sidebar-highlights-theme': 'dark', 'sidebar-highlights-font': 3, 'sidebar-highlights-background': '#112233' }))
            .toEqual({ theme: 'dark', fontFamily: 3, background: '#112233', pinned: false });
        expect(readThemeChoice({ 'sidebar-highlights-theme': 'paper' })).toEqual({ theme: 'paper', fontFamily: null, background: null, pinned: false });
        expect(readThemeChoice({})).toBeNull();
    });

    it('redraws the same notes in another theme, keeping each highlight its own colour', () => {
        const fills = (theme: string) => {
            const md = buildExcalidrawMindmapFile(notes, { theme: { theme } })!;
            return md.includes('"backgroundColor": "#a78bfa"');
        };
        expect(fills('classic')).toBe(true);
        expect(fills('dark')).toBe(true);
        expect(fills('blueprint')).toBe(true);
    });
});

describe('pinned theme', () => {
    it('is recorded only when asked for, and read back', () => {
        const notes = [{ title: 'N', headings: [], highlights: [{ text: 'hi', line: 1 }] }];
        expect(buildExcalidrawMindmapFile(notes, { theme: { theme: 'dark' } })).not.toContain('theme-pinned');
        const md = buildExcalidrawMindmapFile(notes, { theme: { theme: 'dark', pinned: true } })!;
        expect(md).toContain('sidebar-highlights-theme-pinned: true');
        expect(readThemeChoice({ 'sidebar-highlights-theme': 'dark', 'sidebar-highlights-theme-pinned': true })?.pinned).toBe(true);
        expect(readThemeChoice({ 'sidebar-highlights-theme': 'dark' })?.pinned).toBe(false);
    });
});
