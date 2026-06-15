import { useEditorEngine } from '@/components/store/editor';
import { transKeys } from '@/i18n/keys';
import { getActiveProject } from '@/lib/design-session';
import { workbench } from '@/lib/workbench-bridge';
import { LeftPanelTabValue } from '@onlook/models';
import { Icons } from '@onlook/ui/icons';
import { cn } from '@onlook/ui/utils';
import { observer } from 'mobx-react-lite';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { BrandTab } from './brand-tab';
import { CheckpointsTab } from './checkpoints-tab';
import { HelpButton } from './help-button';
import { ImagesTab } from './image-tab';
import { LayersTab } from './layers-tab';
import { PagesTab } from './page-tab';
import { ZoomControls } from './zoom-controls';

interface PanelTab {
    value: LeftPanelTabValue;
    icon: React.ReactNode;
    label?: any;
    // Literal label used when the tab has no i18n key (e.g. the local-only Checkpoints tab).
    labelText?: string;
    disabled?: boolean;
}

const tabs: PanelTab[] =
    [
        {
            value: LeftPanelTabValue.LAYERS,
            icon: <Icons.Layers className="w-5 h-5" />,
            label: transKeys.editor.panels.layers.tabs.layers,
        },
        {
            value: LeftPanelTabValue.BRAND,
            icon: <Icons.Brand className="w-5 h-5" />,
            label: transKeys.editor.panels.layers.tabs.brand,
        },
        {
            value: LeftPanelTabValue.PAGES,
            icon: <Icons.File className="w-5 h-5" />,
            label: transKeys.editor.panels.layers.tabs.pages,
        },
        {
            value: LeftPanelTabValue.IMAGES,
            icon: <Icons.Image className="w-5 h-5" />,
            label: transKeys.editor.panels.layers.tabs.images,
        },
        // Branches tab removed: the local Design editor works on a single local project.
    ];

// Session checkpoints (safety layer) only apply to static HTML projects; shown as a real tab
// alongside the others, not a floating button.
const checkpointsTab: PanelTab = {
    value: LeftPanelTabValue.CHECKPOINTS,
    icon: <Icons.CounterClockwiseClock className="w-5 h-5" />,
    labelText: 'Checkpoints',
};

export const DesignPanel = observer(() => {
    const editorEngine = useEditorEngine();
    const t = useTranslations();
    const isLocked = editorEngine.state.leftPanelLocked;
    const selectedTab = editorEngine.state.leftPanelTab;
    const isHtml = getActiveProject()?.framework === 'html';
    const visibleTabs = isHtml ? [...tabs, checkpointsTab] : tabs;

    // Keyboard shortcuts while editing inside the canvas (iframe-focused, where the native
    // workbench keybinding can't reach). Ctrl+Alt+P = create, Ctrl+Alt+R = revert to initial.
    // The workbench registers the same shortcuts for when its chrome (not the iframe) has focus.
    useEffect(() => {
        if (!isHtml) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) {
                return;
            }
            if (e.code === 'KeyP') {
                e.preventDefault();
                void workbench.checkpoints
                    .create()
                    .then((cp) => toast.success(`${cp.name} creado`, { description: `${cp.fileCount} archivos` }))
                    .catch(() => undefined);
            } else if (e.code === 'KeyR') {
                e.preventDefault();
                if (window.confirm('¿Revertir al checkpoint inicial? Los archivos nuevos no se borrarán.')) {
                    void workbench.checkpoints
                        .rollback()
                        .then((r) => toast.success('Cambios revertidos', { description: `${r.restored} archivos restaurados` }))
                        .catch(() => undefined);
                }
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isHtml]);

    // Click-only, deterministic toggle. The old hover-to-open / hover-to-close behavior left the panel
    // hanging open (and "slow to close") because clicking an open tab merely unlocked it instead of
    // closing it. Now: click a tab to open (locked), click the same tab to close immediately, click a
    // different tab to switch instantly.
    const handleClick = (tab: LeftPanelTabValue) => {
        if (selectedTab === tab) {
            editorEngine.state.leftPanelTab = null;
            editorEngine.state.leftPanelLocked = false;
        } else {
            editorEngine.state.leftPanelTab = tab;
            editorEngine.state.leftPanelLocked = true;
        }
    };

    return (
        <div
            className="flex h-full overflow-auto"
        >
            {/* Left sidebar with tabs */}
            <div className="w-20 flex flex-col items-center py-0.5 gap-2 bg-background-primary/80 backdrop-blur-xl">
                {visibleTabs.map((tab) => (
                    <button
                        key={tab.value}
                        className={cn(
                            'w-16 h-16 rounded-xl flex flex-col items-center justify-center gap-1.5 p-2',
                            selectedTab === tab.value && isLocked
                                ? 'bg-accent text-foreground border-[0.5px] border-foreground/20 '
                                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                            tab.disabled && 'opacity-50 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground',
                        )}
                        disabled={tab.disabled}
                        onClick={() => !tab.disabled && handleClick(tab.value)}
                    >
                        {tab.icon}
                        <span className="text-xs leading-tight">{tab.labelText ?? t(tab.label)}</span>
                    </button>
                ))}

                <div className="mt-auto flex flex-col gap-0 items-center mb-4">
                    <ZoomControls />
                    <HelpButton />
                </div>
            </div>

            {/* Content panel */}
            {editorEngine.state.leftPanelTab && (
                <div className="flex-1 w-[280px] bg-background/95 rounded-xl">
                    <div className="border backdrop-blur-xl h-full shadow overflow-auto p-0 rounded-xl">
                        {selectedTab === LeftPanelTabValue.LAYERS && <LayersTab />}
                        {selectedTab === LeftPanelTabValue.BRAND && <BrandTab />}
                        {selectedTab === LeftPanelTabValue.PAGES && <PagesTab />}
                        {selectedTab === LeftPanelTabValue.IMAGES && <ImagesTab />}
                        {selectedTab === LeftPanelTabValue.CHECKPOINTS && <CheckpointsTab />}
                    </div>
                </div>
            )}
        </div>
    );
});
