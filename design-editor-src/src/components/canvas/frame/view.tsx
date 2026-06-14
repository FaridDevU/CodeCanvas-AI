'use client';

import type { IframeHTMLAttributes } from 'react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { connect, WindowMessenger } from 'penpal';

import type { Frame } from '@onlook/models';
import type {
    PenpalChildMethods,
    PenpalParentMethods,
    PromisifiedPendpalChildMethods,
} from '@onlook/penpal';
import { PENPAL_PARENT_CHANNEL } from '@onlook/penpal';
import { WebPreview, WebPreviewBody } from '@onlook/ui/ai-elements';
import { cn } from '@onlook/ui/utils';

import { useEditorEngine } from '@/components/store/editor';
import { useInspectorProxy } from './use-inspector-proxy';
import { DeviceFrame, deviceFrameRadius, deviceFrameTypeFor } from './device-frame';

export type IFrameView = HTMLIFrameElement & {
    setZoomLevel: (level: number) => void;
    supportsOpenDevTools: () => boolean;
    reload: () => void;
    isLoading: () => boolean;
} & PromisifiedPendpalChildMethods;

// Creates a proxy that provides safe fallback methods for any property access
const createSafeFallbackMethods = (): PromisifiedPendpalChildMethods => {
    return new Proxy({} as PromisifiedPendpalChildMethods, {
        get(_target, prop: string | symbol) {
            if (typeof prop === 'symbol') return undefined;

            return async (..._args: any[]) => {
                const method = String(prop);
                if (
                    method.startsWith('get') ||
                    method.includes('capture') ||
                    method.includes('build')
                ) {
                    return null;
                }
                if (method.includes('Count')) {
                    return 0;
                }
                if (method.includes('Editable') || method.includes('supports')) {
                    return false;
                }
                return undefined;
            };
        },
    });
};

// Human-facing connection stage, surfaced in the frame badge without needing the webview DevTools.
export type FrameConnectionDiagnostic = { connected: boolean; label: string };

interface FrameViewProps extends IframeHTMLAttributes<HTMLIFrameElement> {
    frame: Frame;
    reloadIframe: () => void;
    onConnectionFailed: () => void;
    onConnectionSuccess: () => void;
    onDiagnostic?: (diagnostic: FrameConnectionDiagnostic) => void;
    penpalTimeoutMs?: number;
    isInDragSelection?: boolean;
}

export const FrameComponent = observer(
    forwardRef<IFrameView, FrameViewProps>(
        (
            {
                frame,
                reloadIframe,
                onConnectionFailed,
                onConnectionSuccess,
                onDiagnostic,
                penpalTimeoutMs = 5000,
                isInDragSelection = false,
                ...restProps
            },
            ref,
        ) => {
            const { popover, ...props } = restProps;
            const editorEngine = useEditorEngine();
            const iframeRef = useRef<HTMLIFrameElement>(null);
            const zoomLevel = useRef(1);
            // Each real iframe load starts a fresh penpal attempt; stale attempts (from a previous
            // src) are ignored by comparing against the current id.
            const connectionAttemptRef = useRef(0);
            const timeoutIdRef = useRef<number | null>(null);
            const connectionRef = useRef<ReturnType<typeof connect> | null>(null);
            const [penpalChild, setPenpalChild] = useState<PenpalChildMethods | null>(null);
            const isSelected = editorEngine.frames.isSelected(frame.id);
            const isActiveBranch = editorEngine.branches.activeBranch.id === frame.branchId;
            const proxy = useInspectorProxy(frame.url);

            const reportStage = (label: string, connected = false) => {
                onDiagnostic?.({ connected, label });
            };
            const deviceFrameType = useMemo(
                () => deviceFrameTypeFor(frame.dimension.width, frame.dimension.height),
                [frame.dimension.width, frame.dimension.height],
            );
            // Frames can be hidden globally; when off the preview renders plainly at the same
            // logical size (no zoom/selection change).
            const showFrame = editorEngine.state.framesVisible ? deviceFrameType : null;

            // Tears down any in-flight connection/timeout. Called before a new attempt and on
            // unmount so stale penpal connections (e.g. from a previous iframe src) never linger.
            const teardownConnection = () => {
                if (connectionRef.current) {
                    connectionRef.current.destroy();
                    connectionRef.current = null;
                }
                if (timeoutIdRef.current !== null) {
                    clearTimeout(timeoutIdRef.current);
                    timeoutIdRef.current = null;
                }
            };

            const setupPenpalConnection = () => {
                try {
                    if (!iframeRef.current?.contentWindow) {
                        console.error(`${PENPAL_PARENT_CHANNEL} (${frame.id}) - No iframe found`);
                        onConnectionFailed();
                        reportStage('Editor no conectado - solo vista');
                        return;
                    }

                    // Every (re)load is a brand-new attempt: drop the previous connection/timeout
                    // and bump the id so any stale promise that resolves later is ignored.
                    teardownConnection();
                    const attemptId = ++connectionAttemptRef.current;
                    setPenpalChild(null);
                    console.log(
                        `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Connecting to preload child (attempt ${attemptId}, timeout ${penpalTimeoutMs}ms)`,
                    );
                    reportStage('Conectando editor visual...');

                    const messenger = new WindowMessenger({
                        remoteWindow: iframeRef.current.contentWindow,
                        allowedOrigins: ['*'],
                    });

                    const connection = connect({
                        messenger,
                        methods: {
                            getFrameId: () => frame.id,
                            getBranchId: () => frame.branchId,
                            onWindowMutated: () => {
                                editorEngine.frameEvent.handleWindowMutated();
                            },
                            onWindowResized: () => {
                                editorEngine.frameEvent.handleWindowResized();
                            },
                            onDomProcessed: (data: {
                                layerMap: Record<string, any>;
                                rootNode: any;
                            }) => {
                                editorEngine.frameEvent.handleDomProcessed(frame.id, data);
                            },
                        } satisfies PenpalParentMethods,
                    });

                    connectionRef.current = connection;

                    // Timeout that rejects the race; its id is stored so it can be cleared on
                    // success/failure (it used to leak and fire after a successful connection).
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutIdRef.current = window.setTimeout(() => {
                            reject(
                                new Error(`Penpal connection timeout after ${penpalTimeoutMs}ms`),
                            );
                        }, penpalTimeoutMs);
                    });

                    const isStale = () => attemptId !== connectionAttemptRef.current;

                    // Race the connection promise against the timeout
                    Promise.race([connection.promise, timeoutPromise])
                        .then((child) => {
                            if (isStale()) return;
                            if (timeoutIdRef.current !== null) {
                                clearTimeout(timeoutIdRef.current);
                                timeoutIdRef.current = null;
                            }
                            if (!child) {
                                console.error(
                                    `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Connection failed: child is null`,
                                );
                                onConnectionFailed();
                                reportStage('Editor no conecto - solo vista');
                                return;
                            }

                            console.log(
                                `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Penpal connection set`,
                            );

                            const remote = child as unknown as PenpalChildMethods;
                            setPenpalChild(remote);
                            remote.setFrameId(frame.id);
                            remote.setBranchId(frame.branchId);
                            remote.handleBodyReady();
                            remote.processDom();

                            // Notify parent of successful connection
                            onConnectionSuccess();
                            reportStage('Editor conectado', true);
                        })
                        .catch((error) => {
                            if (isStale()) return;
                            if (timeoutIdRef.current !== null) {
                                clearTimeout(timeoutIdRef.current);
                                timeoutIdRef.current = null;
                            }
                            console.error(
                                `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Failed to setup penpal connection:`,
                                error,
                            );
                            onConnectionFailed();
                            reportStage('Editor no conecto (timeout) - solo vista');
                        });
                } catch (error) {
                    console.error(`${PENPAL_PARENT_CHANNEL} (${frame.id}) - Setup failed:`, error);
                    onConnectionFailed();
                    reportStage('Editor no conecto - solo vista');
                }
            };

            const promisifyMethod = <T extends (...args: any[]) => any>(
                method: T | undefined,
            ): ((...args: Parameters<T>) => Promise<ReturnType<T>>) => {
                return async (...args: Parameters<T>) => {
                    try {
                        if (!method) throw new Error('Method not initialized');
                        return method(...args);
                    } catch (error) {
                        console.error(
                            `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Method failed:`,
                            error,
                        );
                    }
                };
            };

            const remoteMethods = useMemo((): PromisifiedPendpalChildMethods => {
                if (!penpalChild) {
                    return createSafeFallbackMethods();
                }

                return {
                    processDom: promisifyMethod(penpalChild?.processDom),
                    getElementAtLoc: promisifyMethod(penpalChild?.getElementAtLoc),
                    getElementByDomId: promisifyMethod(penpalChild?.getElementByDomId),
                    setFrameId: promisifyMethod(penpalChild?.setFrameId),
                    setBranchId: promisifyMethod(penpalChild?.setBranchId),
                    getElementIndex: promisifyMethod(penpalChild?.getElementIndex),
                    getComputedStyleByDomId: promisifyMethod(penpalChild?.getComputedStyleByDomId),
                    updateElementInstance: promisifyMethod(penpalChild?.updateElementInstance),
                    getFirstOnlookElement: promisifyMethod(penpalChild?.getFirstOnlookElement),
                    setElementType: promisifyMethod(penpalChild?.setElementType),
                    getElementType: promisifyMethod(penpalChild?.getElementType),
                    getParentElement: promisifyMethod(penpalChild?.getParentElement),
                    getChildrenCount: promisifyMethod(penpalChild?.getChildrenCount),
                    getOffsetParent: promisifyMethod(penpalChild?.getOffsetParent),
                    getActionLocation: promisifyMethod(penpalChild?.getActionLocation),
                    getActionElement: promisifyMethod(penpalChild?.getActionElement),
                    getInsertLocation: promisifyMethod(penpalChild?.getInsertLocation),
                    getRemoveAction: promisifyMethod(penpalChild?.getRemoveAction),
                    getTheme: promisifyMethod(penpalChild?.getTheme),
                    setTheme: promisifyMethod(penpalChild?.setTheme),
                    startDrag: promisifyMethod(penpalChild?.startDrag),
                    drag: promisifyMethod(penpalChild?.drag),
                    dragAbsolute: promisifyMethod(penpalChild?.dragAbsolute),
                    endDragAbsolute: promisifyMethod(penpalChild?.endDragAbsolute),
                    endDrag: promisifyMethod(penpalChild?.endDrag),
                    endAllDrag: promisifyMethod(penpalChild?.endAllDrag),
                    startEditingText: promisifyMethod(penpalChild?.startEditingText),
                    editText: promisifyMethod(penpalChild?.editText),
                    stopEditingText: promisifyMethod(penpalChild?.stopEditingText),
                    updateStyle: promisifyMethod(penpalChild?.updateStyle),
                    insertElement: promisifyMethod(penpalChild?.insertElement),
                    removeElement: promisifyMethod(penpalChild?.removeElement),
                    moveElement: promisifyMethod(penpalChild?.moveElement),
                    groupElements: promisifyMethod(penpalChild?.groupElements),
                    ungroupElements: promisifyMethod(penpalChild?.ungroupElements),
                    insertImage: promisifyMethod(penpalChild?.insertImage),
                    removeImage: promisifyMethod(penpalChild?.removeImage),
                    isChildTextEditable: promisifyMethod(penpalChild?.isChildTextEditable),
                    handleBodyReady: promisifyMethod(penpalChild?.handleBodyReady),
                    captureScreenshot: promisifyMethod(penpalChild?.captureScreenshot),
                    buildLayerTree: promisifyMethod(penpalChild?.buildLayerTree),
                };
            }, [penpalChild]);

            useImperativeHandle(ref, (): IFrameView => {
                const iframe = iframeRef.current;
                if (!iframe) {
                    console.error(`${PENPAL_PARENT_CHANNEL} (${frame.id}) - Iframe - Not found`);
                    // Return safe fallback with no-op methods and safe defaults
                    const fallbackElement = document.createElement('iframe');
                    const safeFallback: IFrameView = Object.assign(fallbackElement, {
                        // Custom sync methods with safe no-op implementations
                        supportsOpenDevTools: () => false,
                        setZoomLevel: () => { },
                        reload: () => { },
                        isLoading: () => false,
                        // Reuse the safe fallback methods from remoteMethods
                        ...remoteMethods,
                    });
                    return safeFallback;
                }

                // Register the iframe with the editor engine
                editorEngine.frames.registerView(frame, iframe as IFrameView);

                const syncMethods = {
                    supportsOpenDevTools: () =>
                        !!iframe.contentWindow && 'openDevTools' in iframe.contentWindow,
                    setZoomLevel: (level: number) => {
                        zoomLevel.current = level;
                        iframe.style.transform = `scale(${level})`;
                        iframe.style.transformOrigin = 'top left';
                    },
                    reload: () => reloadIframe(),
                    isLoading: () => iframe.contentDocument?.readyState !== 'complete',
                };

                if (!penpalChild) {
                    console.warn(
                        `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Failed to setup penpal connection: iframeRemote is null`,
                    );
                    return Object.assign(iframe, syncMethods, remoteMethods) as IFrameView;
                }

                return Object.assign(iframe, {
                    ...syncMethods,
                    ...remoteMethods,
                });
            }, [penpalChild, frame, iframeRef]);

            useEffect(() => {
                return () => {
                    // Invalidate any in-flight attempt and tear it down on unmount.
                    connectionAttemptRef.current++;
                    teardownConnection();
                    setPenpalChild(null);
                };
            }, []);

            // Reflect proxy build state in the badge before the iframe even loads.
            useEffect(() => {
                if (proxy.status === 'building') {
                    reportStage('Construyendo editor visual...');
                } else if (proxy.status === 'failed') {
                    reportStage(`Proxy fallo (${proxy.error}) - solo vista`);
                }
                // 'ready' -> wait for the iframe load -> setupPenpalConnection reports next stages.
            }, [proxy.status]);

            // Diagnostics posted by the injected scripts inside the iframe, so the connection state
            // is visible without opening the webview DevTools. Correlated to THIS iframe by source.
            useEffect(() => {
                const onMessage = (e: MessageEvent) => {
                    if (e.source !== iframeRef.current?.contentWindow) return;
                    const type = (e.data && typeof e.data === 'object') ? e.data.type : undefined;
                    switch (type) {
                        case 'codecanvas:preload-bootstrap':
                            reportStage('Pagina cargada, iniciando preload...');
                            break;
                        case 'codecanvas:preload-module-executed':
                            reportStage('Preload ejecutado, conectando...');
                            break;
                        case 'codecanvas:preload-error':
                            reportStage(`Error en la pagina: ${String(e.data.detail ?? '').slice(0, 80)}`);
                            break;
                    }
                };
                window.addEventListener('message', onMessage);
                return () => window.removeEventListener('message', onMessage);
            }, []);

            return (
                <WebPreview className="relative isolate !rounded-none !border-0 !bg-transparent">
                    {showFrame && <DeviceFrame type={showFrame} />}
                    <WebPreviewBody
                        ref={iframeRef}
                        id={frame.id}
                        className={cn(
                            'relative z-[1] outline outline-2 backdrop-blur-sm transition',
                            isActiveBranch && 'outline-teal-400/60',
                            isActiveBranch && !isSelected && 'outline-dashed',
                            !isActiveBranch && isInDragSelection && 'outline-teal-500/50',
                        )}
                        src={proxy.status === 'ready' ? proxy.src : proxy.status === 'failed' ? proxy.src : 'about:blank'}
                        sandbox="allow-modals allow-forms allow-same-origin allow-scripts allow-popups allow-downloads"
                        allow="geolocation; microphone; camera; midi; encrypted-media"
                        style={{
                            width: frame.dimension.width,
                            height: frame.dimension.height,
                            borderRadius: showFrame ? deviceFrameRadius(showFrame) : undefined,
                        }}
                        onLoad={() => {
                            // Only connect penpal when the iframe actually loaded the PROXIED blob
                            // (which contains the preload child). Never connect against the raw
                            // page or about:blank - that was the source of the permanent
                            // "view-only" state.
                            if (proxy.status === 'ready') {
                                setupPenpalConnection();
                            } else if (proxy.status === 'failed') {
                                reportStage(`Proxy fallo (${proxy.error}) - solo vista`);
                            }
                        }}
                        {...props}
                    />
                </WebPreview>
            );
        },
    ),
);
