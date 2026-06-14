'use client';

import type { Frame, LayerNode } from '@onlook/models';
import { EditorMode } from '@onlook/models';
import { debounce } from 'lodash';
import { makeAutoObservable, reaction } from 'mobx';
import type { EditorEngine } from '../engine';

export class FrameEventManager {
    isCanvasOutOfView = false;
    private viewportReactionDisposer?: () => void;
    private modeReactionDisposer?: () => void;

    constructor(private editorEngine: EditorEngine) {
        makeAutoObservable(this);
    }

    init() {
        this.viewportReactionDisposer = reaction(
            () => ({
                position: this.editorEngine.canvas.position,
                scale: this.editorEngine.canvas.scale,
                frames: this.editorEngine.frames.getAll(),
            }),
            () => this.handleViewportCheck(),
            {
                fireImmediately: true,
            },
        );

        // Entering Preview should focus the active frame, not just hide the tools. Zoom-to-fit and
        // center it in the real visible area so the design isn't left scrolled off-screen.
        this.modeReactionDisposer = reaction(
            () => this.editorEngine.state.editorMode,
            (mode) => {
                if (mode === EditorMode.PREVIEW) {
                    this.recenterCanvas({ fit: true });
                }
            },
        );
    }

    private async undebouncedHandleWindowMutated() {
        try {
            await this.editorEngine.refreshLayers();
            await this.editorEngine.overlay.refresh();
            await this.validateAndCleanSelections();
        } catch (error) {
            console.error('Error handling window mutation:', error);
        }
    }

    handleWindowMutated = debounce(this.undebouncedHandleWindowMutated, 1000, {
        leading: true,
        trailing: true,
    });

    private isFrameInViewport(frame: Frame): boolean {
        const canvasPos = this.editorEngine.canvas.position;
        const canvasScale = this.editorEngine.canvas.scale;

        const screenX = canvasPos.x + frame.position.x * canvasScale;
        const screenY = canvasPos.y + frame.position.y * canvasScale;
        const screenWidth = frame.dimension.width * canvasScale;
        const screenHeight = frame.dimension.height * canvasScale;

        return !(
            screenX + screenWidth < 0 ||
            screenX > window.innerWidth ||
            screenY + screenHeight < 0 ||
            screenY > window.innerHeight
        );
    }

    private undebouncedViewportCheck = () => {
        if (typeof window === 'undefined') {
            this.isCanvasOutOfView = false;
            return;
        }

        const frames = this.editorEngine.frames.getAll();
        if (frames.length === 0) {
            this.isCanvasOutOfView = false;
            return;
        }

        const isAnyFrameInView = frames.some((frame) => this.isFrameInViewport(frame.frame));
        this.isCanvasOutOfView = !isAnyFrameInView;
    };

    handleViewportCheck = debounce(this.undebouncedViewportCheck, 500, {
        leading: true,
        trailing: true,
    });

    // The TopBar overlays the top of the window; the canvas sits behind it, so the real visible
    // area starts below it. Keep in sync with TopBar's `h-10`.
    private static readonly TOP_BAR_HEIGHT = 40;

    /**
     * Centers the active frame in the real visible canvas area (window minus the TopBar). With
     * `fit: true` it also zooms so the whole frame fits (never past 100%), used when entering
     * Preview; without it the current zoom is kept (used by the "out of view" recenter button).
     */
    recenterCanvas = (options?: { fit?: boolean }) => {
        const frames = this.editorEngine.frames.getAll();
        // Prefer the selected/active frame so Preview focuses what the user is editing; fall back
        // to the first frame on the canvas.
        const frame = this.editorEngine.frames.selected[0]?.frame ?? frames[0]?.frame;

        if (!frame) {
            this.editorEngine.canvas.position = this.editorEngine.canvas.getDefaultPanPosition();
            return;
        }

        const topInset = FrameEventManager.TOP_BAR_HEIGHT;
        const availWidth = window.innerWidth;
        const availHeight = window.innerHeight - topInset;

        let scale = this.editorEngine.canvas.scale;
        if (options?.fit) {
            const PADDING = 80; // breathing room around the frame
            const fitScale = Math.min(
                (availWidth - PADDING) / frame.dimension.width,
                (availHeight - PADDING) / frame.dimension.height,
            );
            scale = Math.max(0.1, Math.min(fitScale, 1)); // never zoom in past 100%
            this.editorEngine.canvas.scale = scale;
        }

        const frameCenterX = frame.position.x + frame.dimension.width / 2;
        const frameCenterY = frame.position.y + frame.dimension.height / 2;
        const viewCenterX = availWidth / 2;
        const viewCenterY = topInset + availHeight / 2;

        this.editorEngine.canvas.position = {
            x: viewCenterX - frameCenterX * scale,
            y: viewCenterY - frameCenterY * scale,
        };
    };

    async handleWindowResized(): Promise<void> {
        try {
            await this.editorEngine.overlay.refresh();
        } catch (error) {
            console.error('Error handling window resize:', error);
        }
    }

    async handleDomProcessed(frameId: string, data: { layerMap: Record<string, LayerNode>; rootNode: LayerNode }): Promise<void> {
        try {
            const layerMapConverted = new Map(Object.entries(data.layerMap));

            const frameData = this.editorEngine.frames.get(frameId);
            if (!frameData) {
                console.warn('Frame not found for DOM processing');
                return;
            }

            this.editorEngine.ast.setMapRoot(frameId, data.rootNode, layerMapConverted);
            await this.editorEngine.overlay.refresh();
        } catch (error) {
            console.error('Error handling DOM processed:', error);
        }
    }

    private async validateAndCleanSelections(): Promise<void> {
        const selectedElements = this.editorEngine.elements.selected;
        const stillValidElements = await Promise.all(
            selectedElements.map(async (el) => {
                const frameData = this.editorEngine.frames.get(el.frameId);
                if (!frameData?.view) {
                    console.error('No frame view found');
                    return null;
                }
                try {
                    const domEl = await frameData.view.getElementByDomId(el.domId, false);
                    return domEl ? el : null;
                } catch {
                    return null;
                }
            })
        );

        const validElements = stillValidElements.filter((el): el is typeof selectedElements[0] => el !== null);
        if (validElements.length !== selectedElements.length) {
            this.editorEngine.elements.click(validElements);
        }
    }

    clear() {
        this.viewportReactionDisposer?.();
        this.viewportReactionDisposer = undefined;
        this.modeReactionDisposer?.();
        this.modeReactionDisposer = undefined;
    }
} 