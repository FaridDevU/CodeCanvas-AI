import {
    type BranchTabValue,
    type BrandTabValue,
    ChatType,
    EditorMode,
    InsertMode,
    type LeftPanelTabValue
} from '@onlook/models';
import { debounce } from 'lodash';
import { makeAutoObservable } from 'mobx';

const FRAMES_VISIBLE_KEY = 'codecanvas.design.framesVisible';

function loadFramesVisible(): boolean {
    try {
        return localStorage.getItem(FRAMES_VISIBLE_KEY) !== 'false';
    } catch {
        return true;
    }
}

export class StateManager {
    private _canvasScrolling = false;
    hotkeysOpen = false;
    publishOpen = false;
    leftPanelLocked = false;
    canvasPanning = false;
    isDragSelecting = false;
    // True while a right-click context menu is open, so the Moveable layer can hide its handles
    // (which otherwise paint over the menu and could intercept clicks meant for it).
    rightClickMenuOpen = false;

    // Whether the cosmetic device frames are drawn around the preview. Persisted locally so the
    // designer's preference survives reloads. Toggling never changes the logical viewport size.
    framesVisible = loadFramesVisible();

    editorMode: EditorMode = EditorMode.DESIGN;
    insertMode: InsertMode | null = null;
    leftPanelTab: LeftPanelTabValue | null = null;
    brandTab: BrandTabValue | null = null;
    branchTab: BranchTabValue | null = null;
    manageBranchId: string | null = null;

    chatMode: ChatType = ChatType.EDIT;

    constructor() {
        makeAutoObservable(this);
    }

    toggleFramesVisible() {
        this.framesVisible = !this.framesVisible;
        try {
            localStorage.setItem(FRAMES_VISIBLE_KEY, String(this.framesVisible));
        } catch {
            /* ignore: persistence is best-effort */
        }
    }

    set canvasScrolling(value: boolean) {
        this._canvasScrolling = value;
        this.resetCanvasScrolling();
    }

    get shouldHideOverlay() {
        return this._canvasScrolling || this.canvasPanning
    }

    private resetCanvasScrolling() {
        this.resetCanvasScrollingDebounced();
    }

    private resetCanvasScrollingDebounced = debounce(() => {
        this.canvasScrolling = false;
    }, 150);

    clear() {
        this.hotkeysOpen = false;
        this.publishOpen = false;
        this.branchTab = null;
        this.manageBranchId = null;
        this.resetCanvasScrollingDebounced.cancel();
    }
}
