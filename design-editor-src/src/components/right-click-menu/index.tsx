import { Hotkey } from '@/components/hotkey';
import { IDE } from '@/components/ide';
import { useEditorEngine } from '@/components/store/editor';
import { DEFAULT_IDE, type DomElement } from '@onlook/models';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@onlook/ui/context-menu';
import { Icons } from '@onlook/ui/icons';
import { Kbd } from '@onlook/ui/kbd';
import { cn } from '@onlook/ui/utils';
import { observer } from 'mobx-react-lite';
import { isWorkbenchChatAvailable, sendToWorkbenchChat } from '@/lib/workbench-chat';
import { getActiveProject } from '@/lib/design-session';

interface RightClickMenuProps {
    children: React.ReactNode;
}

// Tags whose text content can be edited in place (and persisted via applyHtmlTextEdit). "Edit text"
// is only offered for these; never for <img>/<video>/containers.
const TEXT_TAGS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'a', 'strong', 'b', 'em', 'i', 'mark', 'code',
    'small', 'blockquote', 'pre', 'time', 'sub', 'sup', 'del', 'ins', 'u', 'abbr', 'cite', 'q',
    'label', 'li', 'td', 'th', 'figcaption', 'button', 'caption', 'dt', 'dd',
]);

interface MenuItem {
    label: string;
    action: () => void;
    hotkey?: Hotkey;
    children?: MenuItem[];
    icon: React.ReactNode;
    disabled?: boolean;
    destructive?: boolean;
}

export const RightClickMenu = observer(({ children }: RightClickMenuProps) => {
    const editorEngine = useEditorEngine();
    const ide = IDE.fromType(DEFAULT_IDE);
    const chatAvailable = isWorkbenchChatAvailable();

    // Hands the current selection/app context to the native workbench chat (Copilot).
    // There is no chat inside Design; this only opens the real one with context.
    const askCopilotItem: MenuItem = {
        label: 'Preguntar a Copilot',
        action: () => void sendToWorkbenchChat(editorEngine),
        icon: <Icons.Sparkles className="mr-2 h-4 w-4" />,
    };

    const TOOL_ITEMS: MenuItem[] = [];

    const GROUP_ITEMS: MenuItem[] = [
        {
            label: 'Group',
            icon: <Icons.Box className="mr-2 h-4 w-4" />,
            action: () => editorEngine.group.groupSelectedElements(),
            disabled: !editorEngine.group.canGroupElements(),
            hotkey: Hotkey.GROUP,
        },
        {
            label: 'Ungroup',
            action: () => editorEngine.group.ungroupSelectedElement(),
            disabled: !editorEngine.group.canUngroupElement(),
            icon: <Icons.Group className="mr-2 h-4 w-4" />,
            hotkey: Hotkey.UNGROUP,
        },
    ];

    const EDITING_ITEMS: MenuItem[] = [
        {
            label: 'Edit text',
            action: () => editorEngine.text.editSelectedElement(),
            icon: <Icons.Pencil className="mr-2 h-4 w-4" />,
            hotkey: Hotkey.ENTER,
        },
        {
            label: 'Copy',
            action: () => editorEngine.copy.copy(),
            icon: <Icons.Clipboard className="mr-2 h-4 w-4" />,
            hotkey: Hotkey.COPY,
        },
        {
            label: 'Paste',
            action: () => editorEngine.copy.paste(),
            icon: <Icons.ClipboardCopy className="mr-2 h-4 w-4" />,
            hotkey: Hotkey.PASTE,
        },
        {
            label: 'Cut',
            action: () => editorEngine.copy.cut(),
            icon: <Icons.Scissors className="mr-2 h-4 w-4" />,
            hotkey: Hotkey.CUT,
        },
        {
            label: 'Duplicate',
            action: () => editorEngine.copy.duplicate(),
            icon: <Icons.Copy className="mr-2 h-4 w-4" />,
            hotkey: Hotkey.DUPLICATE,
        },
        {
            label: 'Delete',
            action: () => editorEngine.elements.delete(),
            icon: <Icons.Trash className="mr-2 h-4 w-4" />,
            hotkey: Hotkey.DELETE,
            destructive: true,
        },
    ];

    const WINDOW_ITEMS: MenuItem[] = [
        {
            label: 'Duplicate',
            action: () => editorEngine.frames.duplicateSelected(),
            icon: <Icons.Copy className="mr-2 h-4 w-4" />,
            hotkey: Hotkey.DUPLICATE,
            disabled: !editorEngine.frames.canDuplicate(),
        },
        {
            label: 'Delete',
            action: () => editorEngine.frames.deleteSelected(),
            icon: <Icons.Trash className="mr-2 h-4 w-4" />,
            hotkey: Hotkey.DELETE,
            destructive: true,
            disabled: !editorEngine.frames.canDelete(),
        },
    ];

    // Static HTML only persists a subset of ops, so we don't surface actions that wouldn't work.
    // Supported today: update-style, edit-text (text tags only), remove-element, plus Copilot.
    // Not yet: group/ungroup, copy/paste/cut, duplicate, and oid->source navigation (no JSX map).
    const isHtml = getActiveProject()?.framework === 'html';

    const getHtmlMenuItems = (element: DomElement | undefined): MenuItem[][] => {
        const tag = (element?.tagName || '').toLowerCase();
        const isText = TEXT_TAGS.has(tag);

        const primary: MenuItem[] = chatAvailable ? [askCopilotItem] : [];

        const editing: MenuItem[] = [];
        // Original flow elements (hero/card/div/text) are NOT freely movable until the user opts them
        // in. This converts the selected one to absolute editing (left/top/width/height pinned in
        // place) so Moveable can take over — without corrupting the rest of the layout.
        if (editorEngine.elements.selectedCanConvertToEditable) {
            editing.push({
                label: 'Convert to free editing',
                action: () => void editorEngine.elements.convertSelectedToEditable(),
                icon: <Icons.Box className="mr-2 h-4 w-4" />,
            });
        }
        if (editorEngine.elements.selectedCanRevertToStatic) {
            editing.push({
                label: 'Return to static',
                action: () => void editorEngine.elements.convertSelectedToStatic(),
                icon: <Icons.Box className="mr-2 h-4 w-4" />,
            });
        }
        if (editorEngine.elements.selectedCanReorder) {
            editing.push({
                label: 'Bring to front',
                action: () => void editorEngine.elements.bringSelectedToFront(),
                icon: <Icons.ArrowUp className="mr-2 h-4 w-4" />,
            });
            editing.push({
                label: 'Send to back',
                action: () => void editorEngine.elements.sendSelectedToBack(),
                icon: <Icons.ArrowDown className="mr-2 h-4 w-4" />,
            });
        }
        // Group several same-parent siblings into a container, or ungroup a container (a div) back
        // into its parent. Both persist to the HTML and undo atomically.
        if (editorEngine.group.canGroupElements()) {
            editing.push({
                label: 'Group',
                action: () => void editorEngine.group.groupSelectedElements(),
                icon: <Icons.Group className="mr-2 h-4 w-4" />,
                hotkey: Hotkey.GROUP,
            });
        }
        if (editorEngine.group.canUngroupElement() && tag === 'div') {
            editing.push({
                label: 'Ungroup',
                action: () => void editorEngine.group.ungroupSelectedElement(),
                icon: <Icons.Group className="mr-2 h-4 w-4" />,
                hotkey: Hotkey.UNGROUP,
            });
        }
        if (isText) {
            editing.push({
                label: 'Editar texto',
                action: () => editorEngine.text.editSelectedElement(),
                icon: <Icons.Pencil className="mr-2 h-4 w-4" />,
                hotkey: Hotkey.ENTER,
            });
        }
        editing.push({
            label: 'Eliminar',
            action: () => editorEngine.elements.delete(),
            icon: <Icons.Trash className="mr-2 h-4 w-4" />,
            hotkey: Hotkey.DELETE,
            destructive: true,
        });

        return primary.length ? [primary, editing] : [editing];
    };

    const getMenuItems = (): MenuItem[][] => {
        if (!editorEngine.elements.selected.length) {
            return chatAvailable ? [[askCopilotItem], WINDOW_ITEMS] : [WINDOW_ITEMS];
        }

        const element: DomElement | undefined = editorEngine.elements.selected[0];

        if (isHtml) {
            return getHtmlMenuItems(element);
        }

        const instance = element?.instanceId || null;
        const root = element?.oid || null;

        const updatedToolItems = [
            chatAvailable && askCopilotItem,
            instance !== null && {
                label: 'View instance code',
                action: () => instance && editorEngine.ide.openCodeBlock(instance),
                icon: <Icons.ComponentInstance className="mr-2 h-4 w-4" />,
            },
            {
                label: `View ${instance ? 'component' : 'element'} in ${ide.displayName}`,
                disabled: !root,
                action: () => root && editorEngine.ide.openCodeBlock(root),
                icon: instance ? (
                    <Icons.Component className="mr-2 h-4 w-4" />
                ) : (
                    <Icons.ExternalLink className="mr-2 h-4 w-4" />
                ),
            },
            ...TOOL_ITEMS,
        ].filter((item): item is MenuItem => !!item);

        return [updatedToolItems, GROUP_ITEMS, EDITING_ITEMS];
    };

    const menuItems: MenuItem[][] = getMenuItems();

    return (
        <ContextMenu onOpenChange={(open) => { editorEngine.state.rightClickMenuOpen = open; }}>
            <ContextMenuTrigger>{children}</ContextMenuTrigger>
            {/* z-[10000] keeps the menu above the Moveable control box/handles (react-moveable uses
                z-index:3000). The menu portals to body but the canvas container isn't a stacking
                context, so Moveable's 3000 would otherwise paint over the menu's default z-50. */}
            <ContextMenuContent className="z-[10000] w-64 bg-background/95 backdrop-blur-lg">
                {menuItems.map((group, groupIndex) => (
                    <div key={groupIndex}>
                        {group.map((item) => (
                            <ContextMenuItem
                                key={item.label}
                                onClick={item.action}
                                disabled={item.disabled}
                                className="cursor-pointer"
                            >
                                <span
                                    className={cn(
                                        'flex w-full items-center gap-1',
                                        item.destructive && 'text-red',
                                    )}
                                >
                                    <span>{item.icon}</span>
                                    <span>{item.label}</span>
                                    <span className="ml-auto">
                                        {item.hotkey && <Kbd>{item.hotkey.readableCommand}</Kbd>}
                                    </span>
                                </span>
                            </ContextMenuItem>
                        ))}
                        {groupIndex < menuItems.length - 1 && <ContextMenuSeparator />}
                    </div>
                ))}
            </ContextMenuContent>
        </ContextMenu>
    );
});
