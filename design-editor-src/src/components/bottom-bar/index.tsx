'use client';

import { Hotkey } from '@/components/hotkey';
import { useEditorEngine } from '@/components/store/editor';
import { transKeys } from '@/i18n/keys';
import { EditorMode, InsertMode, type ImageContentData } from '@onlook/models';
import { HotkeyLabel } from '@onlook/ui/hotkey-label';
import { Icons } from '@onlook/ui/icons';
import { toast } from '@onlook/ui/sonner';
import { ToggleGroup, ToggleGroupItem } from '@onlook/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@onlook/ui/tooltip';
import { cn } from '@onlook/ui/utils';
import { getMimeType } from '@onlook/utility';
import { observer } from 'mobx-react-lite';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';

/** Reads a picked File into the ImageContentData the insert pipeline expects (data-URL content;
 *  saveAsset slices the base64 and writes it into /assets). */
async function fileToImageData(file: File): Promise<ImageContentData> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const mimeType = file.type || getMimeType(file.name);
    return {
        fileName: file.name,
        content: `data:${mimeType};base64,${btoa(binary)}`,
        mimeType,
        originPath: '',
    };
}

export const BottomBar = observer(() => {
    const t = useTranslations();
    const editorEngine = useEditorEngine();
    const imageInputRef = useRef<HTMLInputElement>(null);
    const videoInputRef = useRef<HTMLInputElement>(null);

    const editorMode = editorEngine.state.editorMode;
    const insertMode = editorEngine.state.insertMode;
    const shouldShow = editorMode === EditorMode.DESIGN || editorMode === EditorMode.PAN;

    const cursorTools = [
        {
            mode: EditorMode.DESIGN,
            icon: Icons.CursorArrow,
            hotkey: Hotkey.SELECT,
            label: t(transKeys.editor.toolbar.tools.select.name),
        },
        {
            mode: EditorMode.PAN,
            icon: Icons.Hand,
            hotkey: Hotkey.PAN,
            label: t(transKeys.editor.toolbar.tools.pan.name),
        },
    ];

    const armInsert = (mode: InsertMode) => {
        // Keep the editor mode as DESIGN; insertMode drives the draw (see gesture.tsx). Toggling the
        // same tool off returns to plain selection.
        editorEngine.state.editorMode = EditorMode.DESIGN;
        editorEngine.state.insertMode = insertMode === mode ? null : mode;
    };

    const activeFrame = () =>
        editorEngine.frames.selected[0] ?? editorEngine.frames.getAll()[0];

    const handleMediaPicked = async (
        e: React.ChangeEvent<HTMLInputElement>,
        kind: 'imagen' | 'video',
    ) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-picking the same file
        // Cancel (no file) or any failure must leave the editor in a clean state, never stuck armed.
        if (!file) {
            editorEngine.state.insertMode = null;
            return;
        }
        const frame = activeFrame();
        if (!frame) {
            toast.error(`No hay un frame activo para insertar el ${kind}.`);
            editorEngine.state.insertMode = null;
            return;
        }
        try {
            const imageData = await fileToImageData(file);
            await editorEngine.insert.insertMediaFile(frame, imageData);
        } catch (err) {
            console.error('insert media failed:', err);
            toast.error(`No se pudo insertar el ${kind}.`);
        } finally {
            editorEngine.state.insertMode = null;
        }
    };

    const insertTools = [
        {
            key: 'text',
            icon: Icons.Text,
            tooltip: 'Insertar texto',
            active: insertMode === InsertMode.INSERT_TEXT,
            onClick: () => armInsert(InsertMode.INSERT_TEXT),
        },
        {
            key: 'box',
            icon: Icons.Square,
            tooltip: 'Insertar caja',
            active: insertMode === InsertMode.INSERT_DIV,
            onClick: () => armInsert(InsertMode.INSERT_DIV),
        },
        {
            key: 'image',
            icon: Icons.Image,
            tooltip: 'Insertar imagen',
            active: false,
            onClick: () => imageInputRef.current?.click(),
        },
        {
            key: 'video',
            icon: Icons.Video,
            tooltip: 'Insertar video',
            active: false,
            onClick: () => videoInputRef.current?.click(),
        },
    ];

    // z-[3100] keeps the toolbar above react-moveable's control box (z-index:3000). The canvas isn't a
    // stacking context, so the moveable box otherwise paints over this bar and steals clicks (e.g.
    // switching to the hand tool kept selecting the image underneath).
    return (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-4 overflow-hidden z-[3100]">
            <AnimatePresence mode="wait">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: shouldShow ? 1 : 0, y: shouldShow ? 0 : 20 }}
                    className="flex items-center gap-1 border-[0.5px] border-border p-1 bg-background rounded-lg backdrop-blur drop-shadow-xl overflow-hidden"
                    transition={{ type: 'spring', bounce: 0.1, duration: 0.4, stiffness: 200, damping: 25 }}
                    style={{
                        pointerEvents: shouldShow ? 'auto' : 'none',
                        visibility: shouldShow ? 'visible' : 'hidden',
                    }}
                >
                    {/* Selection / pan. While an insert tool is armed neither looks active. */}
                    <ToggleGroup
                        type="single"
                        value={insertMode ? '' : editorMode}
                        onValueChange={(value) => {
                            if (value) {
                                editorEngine.state.editorMode = value as EditorMode;
                                editorEngine.state.insertMode = null;
                            }
                        }}
                        className="gap-0.5"
                    >
                        {cursorTools.map((item) => (
                            <Tooltip key={item.mode}>
                                <TooltipTrigger asChild>
                                    <ToggleGroupItem
                                        value={item.mode}
                                        variant="default"
                                        aria-label={item.hotkey.description}
                                        className={cn(
                                            'h-9 w-9 flex items-center justify-center rounded-md border border-transparent transition-all duration-150 ease-in-out',
                                            !insertMode && editorMode === item.mode
                                                ? 'bg-background-tertiary/50 text-foreground-primary hover:text-foreground-primary'
                                                : 'text-foreground-tertiary hover:text-foreground-hover hover:bg-background-tertiary/50',
                                        )}
                                    >
                                        <item.icon />
                                    </ToggleGroupItem>
                                </TooltipTrigger>
                                <TooltipContent sideOffset={5} hideArrow>
                                    <HotkeyLabel hotkey={item.hotkey} />
                                </TooltipContent>
                            </Tooltip>
                        ))}
                    </ToggleGroup>

                    <div className="w-px h-6 bg-border mx-0.5" />

                    {/* Insert: text / box (draw) and image / video (file picker -> /assets). */}
                    {insertTools.map((tool) => (
                        <Tooltip key={tool.key}>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    aria-label={tool.tooltip}
                                    // Blur after click so the button doesn't stay visually
                                    // highlighted (focus ring) once a native file dialog closes.
                                    onClick={(e) => {
                                        tool.onClick();
                                        e.currentTarget.blur();
                                    }}
                                    className={cn(
                                        'h-9 w-9 flex items-center justify-center rounded-md border border-transparent transition-all duration-150 ease-in-out',
                                        tool.active
                                            ? 'bg-background-tertiary/50 text-foreground-primary'
                                            : 'text-foreground-tertiary hover:text-foreground-hover hover:bg-background-tertiary/50',
                                    )}
                                >
                                    <tool.icon className="h-4 w-4" />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={5} hideArrow>
                                {tool.tooltip}
                            </TooltipContent>
                        </Tooltip>
                    ))}

                    <input
                        ref={imageInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => void handleMediaPicked(e, 'imagen')}
                        // Dismissing the dialog fires `cancel` (not `change`) in Chromium: clear any
                        // armed insert state so the toolbar never stays stuck after a cancel.
                        onCancel={() => { editorEngine.state.insertMode = null; }}
                    />
                    <input
                        ref={videoInputRef}
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={(e) => void handleMediaPicked(e, 'video')}
                        onCancel={() => { editorEngine.state.insertMode = null; }}
                    />
                </motion.div>
            </AnimatePresence>
        </div>
    );
});
