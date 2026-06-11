import { useEditorEngine } from '@/components/store/editor';
import { EditorMode } from '@onlook/models';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { OverlayOpenCode } from './code';

export const OverlayButtons = observer(() => {
    const editorEngine = useEditorEngine();

    const selectedRect = editorEngine.overlay.state.clickRects[0] ?? null;
    const domId = editorEngine.elements.selected[0]?.domId;

    const isPreviewMode = editorEngine.state.editorMode === EditorMode.PREVIEW;
    const shouldHideButton = !selectedRect || isPreviewMode;

    const animationClass =
        'origin-center opacity-0 -translate-y-2 transition-all duration-200';

    useEffect(() => {
        if (domId) {
            requestAnimationFrame(() => {
                const element = document.querySelector(`[data-element-id="${domId}"]`);
                if (element) {
                    element.classList.remove('scale-[0.2]', 'opacity-0', '-translate-y-2');
                    element.classList.add('scale-100', 'opacity-100', 'translate-y-0');
                }
            });
        }
    }, [domId]);

    if (shouldHideButton) {
        return null;
    }

    const EDITOR_HEADER_HEIGHT = 86;
    const MARGIN = 8;
    const BUTTON_HEIGHT = 34;

    const containerStyle: React.CSSProperties = {
        position: 'fixed',
        top: Math.max(EDITOR_HEADER_HEIGHT + MARGIN, selectedRect.top - (BUTTON_HEIGHT + MARGIN)),
        left: selectedRect.left + selectedRect.width / 2,
        transform: 'translate(-50%, 0)',
        transformOrigin: 'center center',
        pointerEvents: 'auto',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    };

    return (
        <div
            style={containerStyle}
            onClick={(e) => e.stopPropagation()}
            className={animationClass}
            data-element-id={domId}
        >
            <OverlayOpenCode isInputting={false} />
        </div>
    );
});
