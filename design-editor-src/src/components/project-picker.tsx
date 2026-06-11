'use client';

// Project selection screen shown when the workspace contains more than one runnable
// app. Each card boots its dev/static server through the workbench bridge and shows
// a live scaled-down preview so the user can pick which project to open in Design.

import { useEffect, useState } from 'react';
import { Icons } from '@onlook/ui/icons';
import { workbench, type DesignProjectInfo } from '@/lib/workbench-bridge';

const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 800;
const MAX_AUTO_PREVIEWS = 6;

interface PreviewState {
    status: 'starting' | 'ready' | 'failed';
    port: number | null;
}

interface ProjectPickerProps {
    apps: DesignProjectInfo[];
    onChoose: (app: DesignProjectInfo, port: number | null) => void;
}

export const ProjectPicker = ({ apps, onChoose }: ProjectPickerProps) => {
    const [previews, setPreviews] = useState<Record<string, PreviewState>>({});

    useEffect(() => {
        let cancelled = false;

        const setPreview = (rootPath: string, state: PreviewState) => {
            if (!cancelled) {
                setPreviews((prev) => ({ ...prev, [rootPath]: state }));
            }
        };

        for (const app of apps.slice(0, MAX_AUTO_PREVIEWS)) {
            setPreview(app.rootPath, { status: 'starting', port: null });
            (async () => {
                try {
                    const { port } = await workbench.startDevServer(app.rootPath);
                    const devPort = port ?? app.devPort;
                    if (!devPort) {
                        throw new Error('No port');
                    }
                    const { ready } = await workbench.waitForPort(devPort, 120_000);
                    if (!ready) {
                        throw new Error('Timeout');
                    }
                    setPreview(app.rootPath, { status: 'ready', port: devPort });
                } catch (err) {
                    console.warn(`[ProjectPicker] Preview failed for ${app.name}:`, err);
                    setPreview(app.rootPath, { status: 'failed', port: null });
                }
            })();
        }

        return () => {
            cancelled = true;
        };
    }, [apps]);

    return (
        <div className="h-screen w-screen overflow-auto bg-background text-foreground flex flex-col items-center py-12 px-8">
            <h1 className="text-2xl font-medium mb-1">Elige un proyecto</h1>
            <p className="text-sm text-muted-foreground mb-8">
                Se detectaron {apps.length} proyectos en la carpeta abierta. Elige cual abrir en Design.
            </p>

            <div className="grid gap-6 w-full max-w-5xl" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                {apps.map((app) => {
                    const preview = previews[app.rootPath];
                    return (
                        <div
                            key={app.rootPath}
                            className="rounded-lg border border-border bg-card overflow-hidden flex flex-col hover:border-teal-500/60 transition-colors"
                        >
                            <div className="relative w-full overflow-hidden bg-black/30" style={{ aspectRatio: '16 / 10' }}>
                                {preview?.status === 'ready' && preview.port ? (
                                    <iframe
                                        src={`http://localhost:${preview.port}/`}
                                        title={app.name}
                                        className="absolute top-0 left-0 origin-top-left pointer-events-none border-0"
                                        style={{
                                            width: PREVIEW_WIDTH,
                                            height: PREVIEW_HEIGHT,
                                            // Scale the full-size page down into the card.
                                            transform: `scale(${320 / PREVIEW_WIDTH})`,
                                        }}
                                        sandbox="allow-same-origin allow-scripts"
                                    />
                                ) : (
                                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                                        {preview?.status === 'failed' ? (
                                            <>
                                                <Icons.ExclamationTriangle className="h-6 w-6" />
                                                <span className="text-xs">No se pudo iniciar el preview</span>
                                            </>
                                        ) : (
                                            <>
                                                <Icons.LoadingSpinner className="h-6 w-6 animate-spin" />
                                                <span className="text-xs">Iniciando servidor...</span>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>

                            <div className="p-4 flex flex-col gap-2">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium truncate">{app.name}</span>
                                    <span className="text-[10px] uppercase tracking-wide rounded bg-teal-500/15 text-teal-400 px-1.5 py-0.5">
                                        {app.framework}
                                    </span>
                                </div>
                                {app.stack.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                        {app.stack.slice(0, 5).map((tech) => (
                                            <span key={tech} className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                                                {tech}
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <button
                                    onClick={() => onChoose(app, preview?.port ?? null)}
                                    className="mt-2 rounded-md bg-teal-600 hover:bg-teal-500 text-white text-sm py-1.5 transition-colors disabled:opacity-50"
                                    disabled={preview?.status === 'failed'}
                                >
                                    Abrir en Design
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
