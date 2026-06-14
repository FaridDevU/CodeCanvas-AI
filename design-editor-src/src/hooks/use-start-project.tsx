// Local replacement for Onlook's cloud `useStartProject` (which used tRPC/Supabase).
// When embedded in CodeCanvas it asks the workbench (via the bridge) for the analyzed
// apps of the open folder. With one runnable app it opens it directly; with several it
// reports `needsProjectChoice` so the UI can show the live-preview project picker.
// Choosing an app starts its dev/static server in the integrated terminal and seeds a
// canvas frame pointing at it. Standalone (vite dev) it reports ready with an empty canvas.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Frame } from '@onlook/models';
import { useEditorEngine } from '@/components/store/editor';
import { PreloadScriptState } from '@/components/store/editor/sandbox';
import { setActiveProject } from '@/lib/design-session';
import { isEmbeddedInWorkbench, workbench, type DesignProjectInfo } from '@/lib/workbench-bridge';

const PRELOAD_FALLBACK_TIMEOUT_MS = 20_000;

const DEFAULT_FRAME_DIMENSION = { width: 1280, height: 800 };

/** Apps Design can open: anything with a dev server, plus static HTML/CSS folders
 *  (the bridge serves those with a local static server). */
export function isOpenableApp(app: DesignProjectInfo): boolean {
    return app.framework === 'html' || !!(app.devCommand && app.devPort);
}

function frameIdFor(rootPath: string): string {
    return `frame-${rootPath.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

type StartStatus = 'loading' | 'pick' | 'starting' | 'ready';

export const useStartProject = () => {
    const editorEngine = useEditorEngine();
    const [status, setStatus] = useState<StartStatus>('loading');
    const [apps, setApps] = useState<DesignProjectInfo[]>([]);
    const [error, setError] = useState<string | null>(null);
    const startedRef = useRef(false);

    const chooseApp = useCallback(
        async (app: DesignProjectInfo, knownPort: number | null = null) => {
            setStatus('starting');
            try {
                const branch = editorEngine.branches.activeBranch;
                const sandbox = editorEngine.branches.getSandboxById(branch.id);

                // Connect the local code provider for the chosen project. This kicks off
                // the whole pipeline: sync to the editor fs, oid instrumentation, preload
                // script injection and the code index (write-back from the canvas).
                setActiveProject({ rootPath: app.rootPath, framework: app.framework, pages: app.pages });
                void sandbox?.session.start('local-sandbox').catch((err) => {
                    console.warn('[useStartProject] Local provider failed; canvas stays read-only:', err);
                });

                // Safety net: if the pipeline never reports the preload script (e.g. it
                // hangs), unblock the frame overlay so the page still renders.
                window.setTimeout(() => {
                    if (sandbox && sandbox.preloadScriptState !== PreloadScriptState.INJECTED) {
                        sandbox.preloadScriptState = PreloadScriptState.INJECTED;
                    }
                }, PRELOAD_FALLBACK_TIMEOUT_MS);

                let port = knownPort;
                if (!port) {
                    const result = await workbench.startDevServer(app.rootPath);
                    port = result.port ?? app.devPort;
                    if (port) {
                        // Don't silently mount a frame against a dead port: if the dev server
                        // never comes up (e.g. the integrated terminal failed to launch), surface
                        // a recoverable error instead of a blank canvas.
                        const { ready } = await workbench.waitForPort(port);
                        if (!ready) {
                            throw new Error(
                                `El servidor de "${app.name}" no respondió en el puerto ${port}. ` +
                                `Revisa la terminal integrada (el dev server) y reintenta.`,
                            );
                        }
                    }
                }
                if (!port) {
                    throw new Error(`No se pudo determinar el puerto de "${app.name}".`);
                }
                const frame: Frame = {
                    id: frameIdFor(app.rootPath),
                    branchId: branch.id,
                    canvasId: 'local-canvas',
                    position: { x: 0, y: 0 },
                    dimension: { ...DEFAULT_FRAME_DIMENSION },
                    url: `http://localhost:${port}/`,
                };
                editorEngine.frames.applyFrames([frame]);
                setStatus('ready');
            } catch (err) {
                console.error('[useStartProject] Failed to open app:', err);
                setError(err instanceof Error ? err.message : String(err));
            }
        },
        [editorEngine],
    );

    useEffect(() => {
        if (startedRef.current) return;
        startedRef.current = true;

        const start = async () => {
            if (!isEmbeddedInWorkbench()) {
                setStatus('ready');
                return;
            }

            const allApps = await workbench.listProjects();
            const openable = allApps.filter(isOpenableApp);

            if (openable.length === 0) {
                console.warn('[useStartProject] No runnable app found in the workspace');
                setStatus('ready');
                return;
            }
            if (openable.length === 1) {
                await chooseApp(openable[0]);
                return;
            }
            setApps(openable);
            setStatus('pick');
        };

        start().catch((err) => {
            console.error('[useStartProject] Failed to start project:', err);
            setError(err instanceof Error ? err.message : String(err));
        });
    }, [editorEngine, chooseApp]);

    return {
        isProjectReady: status === 'ready',
        needsProjectChoice: status === 'pick',
        apps,
        chooseApp,
        error,
    };
};
