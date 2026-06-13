// Toggles the cosmetic device frames around every preview on/off. The logical viewport size
// is unchanged; only the decorative bezel is shown or hidden. The preference is persisted
// locally by the state manager.

import { useEditorEngine } from '@/components/store/editor';
import { Icons } from '@onlook/ui/icons';
import { observer } from 'mobx-react-lite';
import { HoverOnlyTooltip } from '../hover-tooltip';
import { ToolbarButton } from '../toolbar-button';

export const FramesToggleGroup = observer(() => {
    const editorEngine = useEditorEngine();
    const framesVisible = editorEngine.state.framesVisible;

    return (
        <HoverOnlyTooltip
            content={framesVisible ? 'Hide device frames' : 'Show device frames'}
            side="bottom"
            sideOffset={10}
        >
            <ToolbarButton
                className={`w-9 ${framesVisible ? 'bg-background-tertiary/30 hover:bg-background-tertiary/40 text-foreground-primary' : 'hover:bg-background-tertiary/40 text-foreground-onlook'}`}
                onClick={() => editorEngine.state.toggleFramesVisible()}
            >
                {framesVisible ? (
                    <Icons.Frame className="h-4 w-4" />
                ) : (
                    <Icons.Square className="h-4 w-4" />
                )}
            </ToolbarButton>
        </HoverOnlyTooltip>
    );
});
