import { debugLog } from '@/lib/debug';
import type { IFrameView } from '@/app/project/[id]/_components/canvas/frame/view';
import { DefaultSettings, EditorAttributes } from '@onlook/constants';
import type {
    DomElement,
    DropElementProperties,
    ElementPosition,
    ImageContentData,
    RectDimensions,
} from '@onlook/models';
import { EditorMode, InsertMode } from '@onlook/models';
import {
    type ActionElement,
    type ActionLocation,
    type ActionTarget,
    type InsertElementAction,
    type RemoveElementAction,
    type UpdateStyleAction,
} from '@onlook/models/actions';
import { StyleChangeType } from '@onlook/models/style';
import { colors } from '@onlook/ui/tokens';
import { canHaveBackgroundImage, createDomId, createOid, isVideoFile, urlToRelativePath } from '@onlook/utility';
import type React from 'react';
import { toast } from '@onlook/ui/sonner';
import { getActiveProject } from '@/lib/design-session';
import { applyHtmlAttrEdit, assetSrcForPage, pageFileForPathname, saveAsset } from '@/lib/html-writeback';
import type { EditorEngine } from '../engine';
import type { FrameData } from '../frames';
import { getRelativeMousePositionToFrameView } from '../overlay/utils';

export class InsertManager {
    isDrawing = false;
    private drawOrigin: ElementPosition | undefined;
    // Cascades successive toolbar inserts so multiple media don't stack on the exact same pixel.
    private mediaInsertCount = 0;

    constructor(private editorEngine: EditorEngine) { }

    getDefaultProperties(mode: InsertMode): DropElementProperties {
        switch (mode) {
            case InsertMode.INSERT_TEXT:
                return {
                    tagName: 'p',
                    styles: {
                        fontSize: '20px',
                        lineHeight: '24px',
                        color: '#000000',
                    },
                    textContent: null,
                };
            case InsertMode.INSERT_DIV:
                return {
                    tagName: 'div',
                    styles: {
                        width: '100px',
                        height: '100px',
                        backgroundColor: colors.blue[100],
                    },
                    textContent: null,
                };
            default:
                throw new Error(`No element properties defined for mode: ${mode}`);
        }
    }

    start(e: React.MouseEvent<HTMLDivElement>) {
        this.isDrawing = true;
        this.drawOrigin = {
            x: e.clientX,
            y: e.clientY,
        };
        this.updateInsertRect(this.drawOrigin);
    }

    draw(e: React.MouseEvent<HTMLDivElement>) {
        if (!this.isDrawing || !this.drawOrigin) {
            return;
        }
        const currentPos = {
            x: e.clientX,
            y: e.clientY,
        };
        this.updateInsertRect(currentPos);
    }

    async end(e: React.MouseEvent<HTMLDivElement>, frameView: IFrameView | null) {
        if (!this.isDrawing || !this.drawOrigin) {
            return null;
        }

        this.isDrawing = false;
        this.editorEngine.overlay.state.updateInsertRect(null);

        if (!frameView) {
            console.error('frameView not found');
            return;
        }
        const currentPos = { x: e.clientX, y: e.clientY };
        const newRect = this.getDrawRect(currentPos);

        const origin = getRelativeMousePositionToFrameView(e, frameView);
        await this.insertElement(frameView, newRect, origin);
        this.drawOrigin = undefined;
        this.editorEngine.state.editorMode = EditorMode.DESIGN;
        // The insert tool is one-shot: clear it so the next click selects again.
        this.editorEngine.state.insertMode = null;
    }

    /**
     * Inserts a media file chosen from a file picker (the Insert Image/Video toolbar buttons) into
     * the center of the frame. Reuses the same write-back path as a drag&drop: the file is saved to
     * /assets and an <img>/<video> is written to the source HTML. Image vs video is decided by mime.
     */
    async insertMediaFile(frame: FrameData, imageData: ImageContentData) {
        if (!frame.view) {
            console.error('No frame view found');
            return;
        }
        // Cascade each successive insert by a small diagonal step (wrapping) so repeated toolbar
        // inserts don't all land on the exact same left/top and stack invisibly.
        const step = (this.mediaInsertCount++ % 8) * 24;
        const cx = Math.round(frame.frame.dimension.width / 2) + step;
        const cy = Math.round(frame.frame.dimension.height / 2) + step;
        let location = await frame.view.getInsertLocation(cx, cy);
        if (!location) {
            // Fallback: append to <body> (applyHtmlInsert resolves a null targetOid to body).
            location = { type: 'append', targetDomId: '', targetOid: null };
        }
        await this.insertImageElement(frame, location, imageData, { x: cx, y: cy });
        this.editorEngine.state.insertMode = null;
    }

    private updateInsertRect(pos: ElementPosition) {
        const rect = this.getDrawRect(pos);
        const overlayContainer = document.getElementById(EditorAttributes.OVERLAY_CONTAINER_ID);
        if (!overlayContainer) {
            console.error('Overlay container not found');
            return;
        }
        const containerRect = overlayContainer.getBoundingClientRect();
        this.editorEngine.overlay.state.updateInsertRect({
            ...rect,
            top: rect.top - containerRect.top,
            left: rect.left - containerRect.left,
        });
    }

    private getDrawRect(currentPos: ElementPosition): RectDimensions {
        if (!this.drawOrigin) {
            return {
                top: currentPos.y,
                left: currentPos.x,
                width: 0,
                height: 0,
            };
        }
        const { x, y } = currentPos;
        let startX = this.drawOrigin.x;
        let startY = this.drawOrigin.y;
        let width = x - startX;
        let height = y - startY;

        if (width < 0) {
            startX = x;
            width = Math.abs(width);
        }

        if (height < 0) {
            startY = y;
            height = Math.abs(height);
        }

        return {
            top: startY,
            left: startX,
            width,
            height,
        };
    }

    async insertElement(frameView: IFrameView, newRect: RectDimensions, origin: ElementPosition) {
        const insertAction = await this.createInsertAction(frameView, newRect, origin);
        if (!insertAction) {
            console.error('Failed to create insert action');
            return;
        }
        await this.editorEngine.action.run(insertAction);
    }

    async createInsertAction(
        frameView: IFrameView,
        newRect: RectDimensions,
        origin: ElementPosition,
    ): Promise<InsertElementAction | undefined> {
        const location = await frameView.getInsertLocation(origin.x, origin.y);
        if (!location) {
            console.error('Insert position not found');
            return;
        }

        const frameData = this.editorEngine.frames.get(frameView.id);
        if (!frameData) {
            console.error('Frame data not found');
            return;
        }
        const branchId = frameData.frame.branchId;

        const mode = this.editorEngine.state.insertMode;
        const isText = mode === InsertMode.INSERT_TEXT;
        const domId = createDomId();
        const oid = createOid();
        const width = Math.max(Math.round(newRect.width), 30);
        const height = Math.max(Math.round(newRect.height), 30);
        const styles: Record<string, string> = isText
            ? { width: `${width}px`, height: `${height}px` }
            : { width: `${width}px`, height: `${height}px`, backgroundColor: colors.blue[100] };

        // Static HTML: insert absolute and anchored to <body> at the draw point so the element
        // actually appears where the user drew it (a flow insert lands at the end of <body>, off
        // screen and, for empty text, invisible). Same model as inserted media; freely movable after.
        let effectiveLocation = location;
        if (this.isHtmlProject()) {
            styles.position = 'absolute';
            styles.left = `${Math.max(0, Math.round(origin.x))}px`;
            styles.top = `${Math.max(0, Math.round(origin.y))}px`;
            effectiveLocation = { type: 'append', targetDomId: '', targetOid: null };
        }

        // Empty <p> renders as nothing, so give inserted text visible placeholder content. If inline
        // editing engages the user types over it; otherwise it stays visible and editable.
        const textContent = isText ? 'Texto' : null;

        const actionElement: ActionElement = {
            domId,
            oid,
            branchId,
            tagName: isText ? 'p' : 'div',
            attributes: {
                [EditorAttributes.DATA_ONLOOK_DOM_ID]: domId,
                [EditorAttributes.DATA_ONLOOK_INSERTED]: 'true',
                [EditorAttributes.DATA_ONLOOK_ID]: oid,
            },
            children: [],
            textContent,
            styles,
        };

        const targets: Array<ActionTarget> = [
            {
                frameId: frameView.id,
                branchId,
                domId,
                oid: null,
            },
        ];

        return {
            type: 'insert-element',
            targets: targets,
            location: effectiveLocation,
            element: actionElement,
            editText: isText,
            pasteParams: null,
            codeBlock: null,
        };
    }

    async insertDroppedImage(
        frame: FrameData,
        dropPosition: { x: number; y: number },
        imageData: ImageContentData,
        altKey: boolean = false,
    ) {
        if (!frame.view) {
            console.error('No frame view found');
            return;
        }

        const location = await frame.view.getInsertLocation(dropPosition.x, dropPosition.y);
        debugLog('[CC-DROP] insertDroppedImage getInsertLocation ->', location, { dropPosition });

        if (!location) {
            console.error('[CC-DROP] Failed to get insert location for drop -> aborting (no image inserted)');
            return;
        }

        const targetElement = await frame.view.getElementAtLoc(
            dropPosition.x,
            dropPosition.y,
            true,
        );
        debugLog('[CC-DROP] insertDroppedImage getElementAtLoc ->', targetElement?.tagName, targetElement?.domId);

        if (!targetElement) {
            console.error('[CC-DROP] Failed to get element at drop position -> aborting (no image inserted)');
            return;
        }

        // Swapping the src of an existing <img> only makes sense for images. A video
        // dropped on an <img> is inserted as a new <video> element instead.
        const isVideo = isVideoFile(imageData.mimeType || imageData.fileName);
        if (!isVideo && targetElement.tagName.toLowerCase() === 'img') {
            await this.updateImageSource(frame, targetElement, imageData);
            return;
        }

        if (!isVideo && altKey && canHaveBackgroundImage(targetElement.tagName)) {
            const actionElement = await frame.view.getActionElement(targetElement.domId);
            if (actionElement) {
                await this.updateElementBackgroundAction(frame, actionElement, imageData, targetElement);
                return;
            }
        }
        await this.insertImageElement(frame, location, imageData, dropPosition);
    }

    private isHtmlProject(): boolean {
        return getActiveProject()?.framework === 'html';
    }

    /** Page file (index.html, nav/index.html...) for a frame, from its logical URL. */
    private pageFileForFrame(frame: FrameData): string {
        let pathname = '/';
        try {
            if (frame.frame.url) pathname = new URL(frame.frame.url).pathname;
        } catch {
            /* keep default */
        }
        return pageFileForPathname(pathname);
    }

    private async updateImageSource(
        frame: FrameData,
        targetElement: DomElement,
        imageData: ImageContentData,
    ) {
        if (!frame.view) {
            console.error('No frame view found');
            return;
        }

        // Static HTML: copy the asset to /assets and rewrite the existing <img>'s src in the real
        // source (the JSX remove+insert path does not apply and would warn as unsupported).
        if (this.isHtmlProject()) {
            const assetRel = await saveAsset(imageData.fileName, imageData.content, imageData.originPath);
            if (!assetRel) {
                toast.warning('No se pudo leer el asset para guardarlo.');
                return;
            }
            const pageFile = this.pageFileForFrame(frame);
            const src = assetSrcForPage(assetRel, pageFile);
            const result = await applyHtmlAttrEdit(targetElement.oid, { src, alt: imageData.fileName }, pageFile);
            if (result.ok) {
                frame.view.reload();
            } else {
                toast.warning('No se pudo actualizar la imagen en el HTML.');
            }
            return;
        }

        const actionElement = await frame.view.getActionElement(targetElement.domId);
        if (!actionElement) {
            console.error('Failed to get action element for target');
            return;
        }

        const url = imageData.originPath.replace(
            new RegExp(`^${DefaultSettings.IMAGE_FOLDER}\/`),
            '',
        );

        const currentLocation = await frame.view.getActionLocation(targetElement.domId);
        if (!currentLocation) {
            console.error('Failed to get current element location');
            return;
        }

        const removeAction: RemoveElementAction = {
            type: 'remove-element',
            targets: [
                {
                    frameId: frame.frame.id,
                    branchId: frame.frame.branchId,
                    domId: actionElement.domId,
                    oid: actionElement.oid,
                },
            ],
            location: currentLocation,
            element: actionElement,
            editText: false,
            pasteParams: null,
            codeBlock: null,
        };

        // Create new image element with updated src
        const updatedImageElement: ActionElement = {
            ...actionElement,
            attributes: {
                ...actionElement.attributes,
                src: `/${url}`,
                alt: imageData.fileName,
            },
        };

        const insertAction: InsertElementAction = {
            type: 'insert-element',
            targets: [
                {
                    frameId: frame.frame.id,
                    branchId: frame.frame.branchId,
                    domId: actionElement.domId,
                    oid: actionElement.oid,
                },
            ],
            element: updatedImageElement,
            location: currentLocation,
            editText: false,
            pasteParams: null,
            codeBlock: null,
        };

        await this.editorEngine.action.run(removeAction);
        await this.editorEngine.action.run(insertAction);
    }

    async insertImageElement(
        frame: FrameData,
        location: ActionLocation,
        imageData: ImageContentData,
        position?: ElementPosition,
    ) {
        const domId = createDomId();
        const oid = createOid();
        const isVideo = isVideoFile(imageData.mimeType || imageData.fileName);

        // Static HTML: copy the dropped media (image OR video) into the project's /assets and
        // reference it page-relative. Falls back to reading originPath when content is empty. If the
        // asset cannot be saved we warn and abort instead of inserting a broken src.
        let src: string;
        const isHtml = this.isHtmlProject();
        if (isHtml) {
            const assetRel = await saveAsset(imageData.fileName, imageData.content, imageData.originPath);
            if (!assetRel) {
                toast.warning('No se pudo leer el asset para guardarlo.');
                return;
            }
            src = assetSrcForPage(assetRel, this.pageFileForFrame(frame));
        } else {
            const url = imageData.originPath.replace(
                new RegExp(`^${DefaultSettings.IMAGE_FOLDER}\/`),
                '',
            );
            src = `/${url}`;
        }

        const commonAttributes = {
            [EditorAttributes.DATA_ONLOOK_ID]: oid,
            [EditorAttributes.DATA_ONLOOK_DOM_ID]: domId,
            [EditorAttributes.DATA_ONLOOK_INSERTED]: 'true',
            src,
        };

        // For static HTML, drop media as position:absolute anchored to the page so it can be moved
        // freely afterwards (see MoveManager's absolute path). left/top come from the insertion point
        // (drop position or frame center). We also anchor the element to <body> so left/top are page
        // coordinates regardless of which element was under the cursor. Non-HTML keeps flow layout.
        const baseStyles: Record<string, string> = {
            width: DefaultSettings.IMAGE_DIMENSION.width,
            height: DefaultSettings.IMAGE_DIMENSION.height,
            // Keep the media sane when the user resizes the box with the Moveable handles.
            objectFit: 'cover',
        };
        let effectiveLocation = location;
        if (isHtml) {
            const left = Math.max(0, Math.round(position?.x ?? 0));
            const top = Math.max(0, Math.round(position?.y ?? 0));
            baseStyles.position = 'absolute';
            baseStyles.left = `${left}px`;
            baseStyles.top = `${top}px`;
            effectiveLocation = { type: 'append', targetDomId: '', targetOid: null };
        }

        // Videos become a real <video controls> element; images stay <img>. Treating a
        // video as an image would drop the controls and the correct media semantics.
        const mediaElement: ActionElement = isVideo
            ? {
                domId,
                oid,
                branchId: frame.frame.branchId,
                tagName: 'video',
                children: [],
                attributes: {
                    ...commonAttributes,
                    controls: '',
                },
                styles: { ...baseStyles },
                textContent: null,
            }
            : {
                domId,
                oid,
                branchId: frame.frame.branchId,
                tagName: 'img',
                children: [],
                attributes: {
                    ...commonAttributes,
                    alt: imageData.fileName,
                },
                styles: { ...baseStyles },
                textContent: null,
            };

        const action: InsertElementAction = {
            type: 'insert-element',
            targets: [{ frameId: frame.frame.id, branchId: frame.frame.branchId, domId, oid }],
            element: mediaElement,
            location: effectiveLocation,
            editText: false,
            pasteParams: null,
            codeBlock: null,
        };
        this.editorEngine.action.run(action);
    }

    async updateElementBackgroundAction(
        frame: FrameData,
        targetElement: ActionElement,
        imageData: ImageContentData,
        originalElement: DomElement,
    ) {
        // Static HTML: copy the asset to /assets and reference it page-relative; persists as an
        // inline background-image via the normal update-style write-back.
        let bgUrl: string;
        if (this.isHtmlProject()) {
            const assetRel = await saveAsset(imageData.fileName, imageData.content, imageData.originPath);
            if (!assetRel) {
                toast.warning('No se pudo leer el asset para guardarlo.');
                return;
            }
            bgUrl = assetSrcForPage(assetRel, this.pageFileForFrame(frame));
        } else {
            const url = imageData.originPath.replace(
                new RegExp(`^${DefaultSettings.IMAGE_FOLDER}\/`),
                '',
            );
            bgUrl = `/${url}`;
        }
        const originStyles = originalElement.styles?.computed;
        let original = {};
        if (originStyles?.backgroundImage) {
            const backgroundImageValue = originStyles.backgroundImage;
            if (backgroundImageValue) {
                original = {
                    backgroundImage: {
                        value: urlToRelativePath(backgroundImageValue),
                        type: StyleChangeType.Value,
                    },
                    backgroundSize: {
                        value: originStyles.backgroundSize,
                        type: StyleChangeType.Value,
                    },
                    backgroundPosition: {
                        value: originStyles.backgroundPosition,
                        type: StyleChangeType.Value,
                    },
                };
            }
        }

        const action: UpdateStyleAction = {
            type: 'update-style',
            targets: [
                {
                    change: {
                        updated: {
                            backgroundImage: {
                                value: `url('${bgUrl}')`,
                                type: StyleChangeType.Value,
                            },
                            backgroundSize: {
                                value: 'cover',
                                type: StyleChangeType.Value,
                            },
                            backgroundPosition: {
                                value: 'center',
                                type: StyleChangeType.Value,
                            },
                        },
                        original,
                    },

                    domId: targetElement.domId,
                    oid: targetElement.oid,
                    frameId: frame.frame.id,
                    branchId: frame.frame.branchId,
                },
            ],
        };
        this.editorEngine.action.run(action);
    }

    async insertDroppedElement(
        frame: FrameData,
        dropPosition: { x: number; y: number },
        properties: DropElementProperties,
    ) {
        if (!frame.view) {
            console.error('No frame view found');
            return;
        }

        const location = await frame.view.getInsertLocation(dropPosition.x, dropPosition.y);

        if (!location) {
            console.error('Failed to get insert location for drop');
            return;
        }

        const domId = createDomId();
        const oid = createOid();
        const element: ActionElement = {
            domId,
            oid,
            branchId: frame.frame.branchId,
            tagName: properties.tagName,
            styles: properties.styles,
            children: [],
            attributes: {
                [EditorAttributes.DATA_ONLOOK_ID]: oid,
                [EditorAttributes.DATA_ONLOOK_DOM_ID]: domId,
                [EditorAttributes.DATA_ONLOOK_INSERTED]: 'true',
            },
            textContent: properties.textContent || null,
        };

        const action: InsertElementAction = {
            type: 'insert-element',
            targets: [
                {
                    frameId: frame.frame.id,
                    branchId: frame.frame.branchId,
                    domId,
                    oid: null,
                },
            ],
            element,
            location,
            editText: properties.tagName === 'p',
            pasteParams: null,
            codeBlock: null,
        };

        this.editorEngine.action.run(action);
    }

    clear() {
        // Clear drawing state
        this.isDrawing = false;
    }
}
