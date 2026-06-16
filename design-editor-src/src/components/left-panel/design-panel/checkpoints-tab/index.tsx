// Checkpoints tab: the safety-layer history for the Design session. The checkpoint store itself
// lives natively in the workbench bridge (in-memory snapshots of html/css, capped, initial kept);
// this tab only lists it and drives create/restore/rollback/delete over the `checkpoint.*` RPC.

import { useEditorEngine } from '@/components/store/editor';
import { onWorkbenchCheckpointChange, workbench, type CheckpointInfo } from '@/lib/workbench-bridge';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@onlook/ui/alert-dialog';
import { Button } from '@onlook/ui/button';
import { Icons } from '@onlook/ui/icons';
import { cn } from '@onlook/ui/utils';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type Confirm =
    | { kind: 'restore'; cp: CheckpointInfo }
    | { kind: 'revert' }
    | { kind: 'delete'; cp: CheckpointInfo }
    | null;

function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export const CheckpointsTab = () => {
    const editorEngine = useEditorEngine();
    const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<Confirm>(null);

    const refresh = useCallback(async () => {
        try {
            setCheckpoints(await workbench.checkpoints.list());
        } catch {
            /* not embedded in workbench (vite dev) */
        }
    }, []);

    useEffect(() => {
        // Seed the initial session checkpoint on open, then show the history.
        void workbench.checkpoints
            .ensureInitial()
            .then((list) => setCheckpoints(list))
            .catch(() => undefined);
        // Refresh when a checkpoint is created/restored elsewhere (e.g. the keyboard shortcut).
        return onWorkbenchCheckpointChange(() => void refresh());
    }, [refresh]);

    const handleCreate = useCallback(async () => {
        setBusy(true);
        try {
            const cp = await workbench.checkpoints.create();
            toast.success(`${cp.name} creado`, { description: `${cp.fileCount} archivos` });
            await refresh();
        } catch (err) {
            toast.error('No se pudo crear el checkpoint', {
                description: err instanceof Error ? err.message : String(err),
            });
        } finally {
            setBusy(false);
        }
    }, [refresh]);

    const runRestore = useCallback(
        async (action: () => Promise<{ restored: number; failed: number }>, label: string) => {
            setBusy(true);
            try {
                const { restored, failed } = await action();
                // Reload the canvas so it shows the restored files. The workbench file watcher does
                // NOT reload the frame, so without this the disk reverts but the canvas stays stale.
                editorEngine.frames.reloadAllViews();
                if (failed > 0) {
                    toast.warning(`${label}: ${restored} restaurados, ${failed} fallaron`);
                } else {
                    toast.success(label, { description: `${restored} archivos restaurados` });
                }
                await refresh();
            } catch (err) {
                toast.error('No se pudo restaurar', {
                    description: err instanceof Error ? err.message : String(err),
                });
            } finally {
                setBusy(false);
            }
        },
        [refresh, editorEngine],
    );

    const handleDelete = useCallback(
        async (cp: CheckpointInfo) => {
            setBusy(true);
            try {
                const res = await workbench.checkpoints.delete(cp.id);
                if (res.deleted) {
                    toast.success(`${cp.name} eliminado`);
                } else if (res.reason === 'base') {
                    toast.warning('No se puede eliminar el checkpoint inicial.');
                }
                await refresh();
            } catch (err) {
                toast.error('No se pudo eliminar', {
                    description: err instanceof Error ? err.message : String(err),
                });
            } finally {
                setBusy(false);
            }
        },
        [refresh],
    );

    const handleConfirm = useCallback(async () => {
        const c = confirm;
        setConfirm(null);
        if (!c) {
            return;
        }
        if (c.kind === 'restore') {
            await runRestore(() => workbench.checkpoints.restore(c.cp.id), `Restaurado "${c.cp.name}"`);
        } else if (c.kind === 'revert') {
            await runRestore(() => workbench.checkpoints.rollback(), 'Cambios revertidos');
        } else {
            await handleDelete(c.cp);
        }
    }, [confirm, runRestore, handleDelete]);

    // Newest first so the latest safe point is at the top.
    const ordered = [...checkpoints].reverse();

    return (
        <div className="flex flex-col h-full text-foreground">
            <div className="px-3 pt-3 pb-2">
                <div className="flex items-center gap-1.5">
                    <Icons.CounterClockwiseClock className="w-4 h-4" />
                    <span className="text-sm font-semibold">Checkpoints</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1 leading-snug">
                    Puntos seguros de esta sesión. Restaura cualquiera si algo sale mal.
                </p>
            </div>

            <div className="flex-1 overflow-y-auto px-2">
                {ordered.length === 0 ? (
                    <div className="text-xs text-muted-foreground text-center py-6">Aún no hay checkpoints.</div>
                ) : (
                    ordered.map((cp) => (
                        <div
                            key={cp.id}
                            className={cn(
                                'group flex items-center gap-2 px-2 py-1.5 rounded-md',
                                cp.isCurrent ? 'bg-accent' : 'hover:bg-accent/50',
                            )}
                        >
                            {cp.isCurrent ? (
                                <Icons.CheckCircled className="w-4 h-4 shrink-0 text-green-500" />
                            ) : (
                                <Icons.Circle className="w-4 h-4 shrink-0 text-muted-foreground" />
                            )}
                            <div className="flex-1 min-w-0 flex flex-col">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-xs font-medium">{cp.name}</span>
                                    <span
                                        className={cn(
                                            'text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full',
                                            cp.label === 'initial'
                                                ? 'bg-background-secondary text-foreground'
                                                : 'bg-accent text-muted-foreground',
                                        )}
                                    >
                                        {cp.label === 'initial' ? 'Inicial' : 'Manual'}
                                    </span>
                                    {cp.isCurrent && (
                                        <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-green-500 text-black">
                                            Actual
                                        </span>
                                    )}
                                </div>
                                <span className="text-[10px] text-muted-foreground">{formatTime(cp.createdAt)}</span>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                disabled={busy}
                                title="Restaurar este checkpoint"
                                className="h-6 w-6 opacity-0 group-hover:opacity-100"
                                onClick={() => setConfirm({ kind: 'restore', cp })}
                            >
                                <Icons.Reset className="w-3.5 h-3.5" />
                            </Button>
                            {/* The base (initial) checkpoint can't be deleted: it's the rollback anchor. */}
                            {cp.label !== 'initial' && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    disabled={busy}
                                    title="Eliminar este checkpoint"
                                    className="h-6 w-6 opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300"
                                    onClick={() => setConfirm({ kind: 'delete', cp })}
                                >
                                    <Icons.Trash className="w-3.5 h-3.5" />
                                </Button>
                            )}
                        </div>
                    ))
                )}
            </div>

            <div className="flex flex-col gap-1.5 p-2.5 border-t border-border">
                <Button
                    variant="default"
                    size="sm"
                    disabled={busy}
                    className="justify-between"
                    onClick={() => void handleCreate()}
                >
                    <span className="flex items-center">
                        <Icons.Plus className="w-3.5 h-3.5 mr-1.5" />
                        Crear checkpoint
                    </span>
                    <kbd className="text-[10px] font-mono opacity-70">Ctrl+Alt+P</kbd>
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || checkpoints.length === 0}
                    className="justify-between text-red-400 hover:text-red-300"
                    onClick={() => setConfirm({ kind: 'revert' })}
                >
                    <span className="flex items-center">
                        <Icons.Reset className="w-3.5 h-3.5 mr-1.5" />
                        Revertir al inicial
                    </span>
                    <kbd className="text-[10px] font-mono opacity-70">Ctrl+Alt+R</kbd>
                </Button>
            </div>

            <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {confirm?.kind === 'restore'
                                ? `Restaurar "${confirm.cp.name}"?`
                                : confirm?.kind === 'delete'
                                    ? `Eliminar "${confirm.cp.name}"?`
                                    : 'Revertir al checkpoint inicial?'}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirm?.kind === 'restore'
                                ? 'Se restaurarán los archivos editados al estado de este checkpoint. Los archivos nuevos no se borrarán.'
                                : confirm?.kind === 'delete'
                                    ? 'Se quita del historial. No cambia tus archivos; solo elimina este punto de restauración.'
                                    : 'Se restaurarán los archivos al checkpoint inicial de esta sesión. Los archivos nuevos no se borrarán. Esta acción no se puede deshacer.'}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleConfirm()}>
                            {confirm?.kind === 'restore' ? 'Restaurar' : confirm?.kind === 'delete' ? 'Eliminar' : 'Revertir'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};
