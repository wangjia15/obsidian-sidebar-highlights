import { App, FuzzySuggestModal } from 'obsidian';
import { EXCALIDRAW_THEMES } from '../utils/excalidraw-theme';
import { t } from '../i18n';

/** Pick the theme an exported mindmap is redrawn in. */
export class MindmapThemeModal extends FuzzySuggestModal<string> {
    constructor(
        app: App,
        private readonly current: string,
        private readonly onChoose: (themeId: string) => void
    ) {
        super(app);
        this.setPlaceholder(t('modals.mindmapTheme.placeholder'));
    }

    getItems(): string[] {
        return Object.keys(EXCALIDRAW_THEMES);
    }

    getItemText(themeId: string): string {
        const name = t(`settings.export.excalidrawTheme.options.${themeId}`);
        return themeId === this.current ? `${name} ✓` : name;
    }

    onChooseItem(themeId: string): void {
        this.onChoose(themeId);
    }
}
