/**
 * Look of an exported mind map: font, canvas background, line roughness and the
 * colours of the structural nodes (root, headings, plain comments).
 *
 * A highlight's own colour still fills its node whatever the theme, so the map
 * keeps the colour coding the sidebar shows; the theme decides everything
 * around it.
 */

export type NodeKindName = 'root' | 'note' | 'heading' | 'highlight' | 'comment';

export interface NodePalette {
    background: string;
    stroke: string;
}

export interface ExcalidrawTheme {
    id: string;
    /** Excalidraw fontFamily id used when the user has not picked a font. */
    fontFamily: number;
    background: string;
    roughness: 0 | 1 | 2;
    /** Colour of text on structural nodes; highlights pick their own for contrast with their fill. */
    textColor?: string;
    /** Connector colour; defaults to the child node's outline. */
    arrow?: string;
    palette: Record<NodeKindName, NodePalette>;
}

/** Excalidraw's built-in font families worth offering. */
export const EXCALIDRAW_FONTS: Record<number, { name: string; /** Average latin glyph width relative to font size. */ width: number }> = {
    1: { name: 'Virgil', width: 0.55 },
    2: { name: 'Helvetica', width: 0.55 },
    3: { name: 'Cascadia (mono)', width: 0.62 },
    5: { name: 'Excalifont', width: 0.55 },
    6: { name: 'Nunito', width: 0.55 },
    8: { name: 'Comic Shanns', width: 0.6 }
};

const light = (root: NodePalette, heading: NodePalette, highlight: NodePalette, comment: NodePalette) =>
    ({ root, note: root, heading, highlight, comment });

export const EXCALIDRAW_THEMES: Record<string, ExcalidrawTheme> = {
    classic: {
        id: 'classic', fontFamily: 2, background: '#ffffff', roughness: 1,
        palette: light(
            { background: '#a5d8ff', stroke: '#1971c2' },
            { background: '#e9ecef', stroke: '#495057' },
            { background: '#ffec99', stroke: '#1e1e1e' },
            { background: '#f8f9fa', stroke: '#868e96' }
        )
    },
    sketch: {
        id: 'sketch', fontFamily: 5, background: '#fffdf7', roughness: 2,
        palette: light(
            { background: '#a5d8ff', stroke: '#1971c2' },
            { background: '#e9ecef', stroke: '#495057' },
            { background: '#ffec99', stroke: '#1e1e1e' },
            { background: '#f8f9fa', stroke: '#868e96' }
        )
    },
    paper: {
        id: 'paper', fontFamily: 6, background: '#f6f1e7', roughness: 0,
        textColor: '#3b3226',
        palette: light(
            { background: '#e8d9b5', stroke: '#8c6d3f' },
            { background: '#efe6d2', stroke: '#7a6a4f' },
            { background: '#f5e6a8', stroke: '#6b5b3a' },
            { background: '#fbf7ee', stroke: '#a39880' }
        )
    },
    clean: {
        id: 'clean', fontFamily: 2, background: '#ffffff', roughness: 0,
        textColor: '#1e1e1e',
        palette: light(
            { background: '#f1f3f5', stroke: '#1e1e1e' },
            { background: '#ffffff', stroke: '#495057' },
            { background: '#fff3bf', stroke: '#868e96' },
            { background: '#ffffff', stroke: '#adb5bd' }
        )
    },
    dark: {
        id: 'dark', fontFamily: 2, background: '#1e1e2e', roughness: 0,
        textColor: '#e6e6f0', arrow: '#7f849c',
        palette: light(
            { background: '#2f4b7c', stroke: '#8ab4f8' },
            { background: '#313244', stroke: '#9399b2' },
            { background: '#4a4528', stroke: '#c9b458' },
            { background: '#262637', stroke: '#6c7086' }
        )
    },
    blueprint: {
        id: 'blueprint', fontFamily: 3, background: '#0b3d6b', roughness: 0,
        textColor: '#e8f4ff', arrow: '#9ccaf0',
        palette: light(
            { background: '#1c5d99', stroke: '#cfe8ff' },
            { background: '#14507f', stroke: '#9ccaf0' },
            { background: '#1a5a94', stroke: '#9ccaf0' },
            { background: '#0f4777', stroke: '#7fb3e0' }
        )
    }
};

export const DEFAULT_THEME_ID = 'classic';

export interface ThemeChoice {
    theme?: string;
    /** Excalidraw fontFamily id; overrides the theme's font. */
    fontFamily?: number | null;
    /** Hex canvas colour; overrides the theme's background. */
    background?: string | null;
    /** Set when the user switched this map's theme by hand, so a refresh keeps it instead of following the settings. */
    pinned?: boolean;
}

export function resolveTheme(choice: ThemeChoice = {}): ExcalidrawTheme {
    const base = EXCALIDRAW_THEMES[choice.theme ?? ''] ?? EXCALIDRAW_THEMES[DEFAULT_THEME_ID];
    const fontFamily = choice.fontFamily && EXCALIDRAW_FONTS[choice.fontFamily] ? choice.fontFamily : base.fontFamily;
    const background = choice.background && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(choice.background.trim())
        ? choice.background.trim()
        : base.background;
    return { ...base, fontFamily, background };
}
