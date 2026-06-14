import { useEditorEngine } from '@/components/store/editor';
import type { ClickRectState } from '@/components/store/editor/overlay/state';
import { EditorAttributes } from '@onlook/constants';
import { EditorMode } from '@onlook/models';
import { cn } from '@onlook/ui/utils';
import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import { OverlayButtons } from './elements/buttons';
import { MeasurementOverlay } from './elements/measurement';
import { ClickRect } from './elements/rect/click';
import { HoverRect } from './elements/rect/hover';
import { InsertRect } from './elements/rect/insert';
import { SnapGuidelines } from './elements/snap-guidelines';
import { TextEditor } from './elements/text';

export const Overlay = observer(() => {
    const editorEngine = useEditorEngine();
    const overlayState = editorEngine.overlay.state;
    const isSingleSelection = editorEngine.elements.selected.length === 1;
    const isTextEditing = editorEngine.text.isEditing;

    // When the Moveable layer owns the selection it draws its OWN box + handles, so suppress the legacy
    // click-rect outline for that element (no two overlapping handle systems). Must mirror
    // MoveableSelectionLayer's gate EXACTLY, including the IDENTITY MATCH: use the click rect whose id
    // is the selected element's domId (not clickRects[0], which can be a leftover/other element during
    // an async refresh). A non-media, non-Design absolute element (or a corrupted hero/card) keeps its
    // normal outline.
    const selectedEl = editorEngine.elements.selected[0];
    const singleRect = selectedEl ? overlayState.clickRects.find((r) => r.id === selectedEl.domId) : undefined;
    const singleRectPosition = singleRect?.styles?.computed?.position;
    const singleTag = selectedEl?.tagName?.toLowerCase();
    const isMovableMedia = singleTag === 'img' || singleTag === 'video';
    const moveableOwnsSelection =
        isSingleSelection &&
        !!singleRect &&
        (isMovableMedia || editorEngine.elements.selectedIsDesignCreated) &&
        (singleRectPosition === 'absolute' || singleRectPosition === 'fixed') &&
        editorEngine.state.editorMode === EditorMode.DESIGN &&
        !isTextEditing;

    const clickRectsElements = useMemo(
        () =>
            overlayState.clickRects.map((rectState: ClickRectState) => (
                <ClickRect
                    key={rectState.id}
                    width={rectState.width}
                    height={rectState.height}
                    top={rectState.top}
                    left={rectState.left}
                    isComponent={rectState.isComponent}
                    styles={rectState.styles}
                    shouldShowResizeHandles={isSingleSelection}
                />
            )),
        [overlayState.clickRects, isSingleSelection],
    );

    return (
        <div
            id={EditorAttributes.OVERLAY_CONTAINER_ID}
            className={cn(
                'absolute top-0 left-0 h-0 w-0 pointer-events-none',
                editorEngine.state.shouldHideOverlay ? 'opacity-0' : 'opacity-100 transition-opacity duration-150',
                editorEngine.state.editorMode === EditorMode.PREVIEW && 'hidden',
            )}
        >
            {!isTextEditing && overlayState.hoverRect && (
                <HoverRect
                    rect={overlayState.hoverRect.rect}
                    isComponent={overlayState.hoverRect.isComponent}
                />
            )}
            {overlayState.insertRect && (
                <InsertRect rect={overlayState.insertRect} />
            )}
            {!isTextEditing && !moveableOwnsSelection && clickRectsElements}
            {isTextEditing && overlayState.textEditor && (
                <TextEditor />
            )}
            {overlayState.measurement && (
                <MeasurementOverlay
                    fromRect={overlayState.measurement.fromRect}
                    toRect={overlayState.measurement.toRect}
                />
            )}
            {overlayState.clickRects.length > 0 && (
                <OverlayButtons />
            )}
            <SnapGuidelines />
        </div>
    );
});
