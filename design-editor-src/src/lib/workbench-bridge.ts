// RPC client for the CodeCanvas workbench bridge. The host side lives in the fork at
// src/vs/workbench/contrib/codecanvasPreview/browser/designBridge.ts. When the editor
// runs standalone (vite dev server, no workbench parent) every call rejects cleanly.

export interface DesignProjectInfo {
    name: string;
    rootPath: string;
    framework: string;
    stack: string[];
    devCommand: string | null;
    devPort: number | null;
    editable: boolean;
    reason?: string;
    pages: { name: string; path: string }[];
}

export interface OpenChatPayload {
    prompt?: string;
    selectedElement?: {
        tagName?: string;
        domId?: string;
        oid?: string;
        text?: string;
        styles?: Record<string, string>;
    };
    source?: {
        fileName?: string;
        lineNumber?: number;
        columnNumber?: number;
    };
    app?: {
        rootPath: string;
        framework: string;
        url?: string;
    };
}

export interface CheckpointInfo {
    id: number;
    name: string;
    label: 'initial' | 'manual';
    createdAt: number;
    fileCount: number;
    isCurrent: boolean;
    isBase: boolean;
}

export interface CheckpointRestoreResult {
    restored: number;
    failed: number;
    total: number;
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

let nextId = 1;
let listening = false;
const pending = new Map<number, PendingRequest>();

export function isEmbeddedInWorkbench(): boolean {
    try {
        return window.parent !== window;
    } catch {
        return false;
    }
}

function ensureListener(): void {
    if (listening) return;
    listening = true;
    window.addEventListener('message', (event: MessageEvent) => {
        // Only trust the workbench host (our parent). The user's app preview is a nested child
        // iframe; without this it could forge a response for a guessed sequential id.
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || data.type !== 'codecanvas:bridge-response') return;
        const entry = pending.get(data.id);
        if (!entry) return;
        pending.delete(data.id);
        clearTimeout(entry.timer);
        if (data.ok) {
            entry.resolve(data.result);
        } else {
            entry.reject(new Error(data.error || 'Bridge request failed'));
        }
    });
}

export function callWorkbench<T = unknown>(
    method: string,
    params?: object,
    timeoutMs = 30_000,
): Promise<T> {
    if (!isEmbeddedInWorkbench()) {
        return Promise.reject(new Error('Not embedded in CodeCanvas workbench'));
    }
    ensureListener();
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Bridge request timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        window.parent.postMessage({ type: 'codecanvas:bridge-request', id, method, params }, '*');
    });
}

export interface FsChange {
    type: 'add' | 'change' | 'remove';
    path: string;
    rootPath: string;
}

type FsChangeListener = (changes: FsChange[]) => void;
const fsChangeListeners = new Set<FsChangeListener>();
type CheckpointChangeListener = () => void;
const checkpointChangeListeners = new Set<CheckpointChangeListener>();
let eventListening = false;

function ensureEventListener(): void {
    if (eventListening) return;
    eventListening = true;
    window.addEventListener('message', (event: MessageEvent) => {
        // Same trust boundary as bridge-response: only the host, never the nested preview.
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || data.type !== 'codecanvas:bridge-event') return;
        if (data.event === 'fs-change' && Array.isArray(data.changes)) {
            for (const listener of fsChangeListeners) {
                try {
                    listener(data.changes);
                } catch (err) {
                    console.error('[workbench-bridge] fs-change listener failed:', err);
                }
            }
        } else if (data.event === 'checkpoint-change') {
            for (const listener of checkpointChangeListeners) {
                try {
                    listener();
                } catch (err) {
                    console.error('[workbench-bridge] checkpoint-change listener failed:', err);
                }
            }
        }
    });
}

/** Subscribes to file changes pushed by the workbench. Returns an unsubscribe fn. */
export function onWorkbenchFsChange(listener: FsChangeListener): () => void {
    ensureEventListener();
    fsChangeListeners.add(listener);
    return () => fsChangeListeners.delete(listener);
}

/** Subscribes to checkpoint history changes pushed by the workbench (e.g. created via shortcut). */
export function onWorkbenchCheckpointChange(listener: CheckpointChangeListener): () => void {
    ensureEventListener();
    checkpointChangeListeners.add(listener);
    return () => checkpointChangeListeners.delete(listener);
}

export const workbench = {
    listProjects: () => callWorkbench<DesignProjectInfo[]>('project.list'),
    startDevServer: (rootPath: string) =>
        callWorkbench<{ port: number | null; alreadyRunning: boolean }>('project.startDev', { rootPath }, 60_000),
    waitForPort: (port: number, timeoutMs = 120_000) =>
        callWorkbench<{ ready: boolean }>('project.waitForPort', { port, timeoutMs }, timeoutMs + 10_000),
    readFile: (path: string, encoding: 'utf8' | 'base64' | 'auto' = 'auto') =>
        callWorkbench<{ content: string; encoding: 'utf8' | 'base64' }>('fs.readFile', { path, encoding }),
    writeFile: (path: string, content: string, encoding: 'utf8' | 'base64' = 'utf8') =>
        callWorkbench<{ ok: boolean }>('fs.writeFile', { path, content, encoding }),
    readDir: (path: string) =>
        callWorkbench<{ name: string; isDirectory: boolean }[]>('fs.readDir', { path }),
    exists: (path: string) => callWorkbench<boolean>('fs.exists', { path }),
    stat: (path: string) =>
        callWorkbench<{ type: 'file' | 'directory'; size: number; mtime: number; ctime: number }>('fs.stat', { path }),
    rename: (oldPath: string, newPath: string) =>
        callWorkbench<{ ok: boolean }>('fs.rename', { oldPath, newPath }),
    delete: (path: string, recursive = true) =>
        callWorkbench<{ ok: boolean }>('fs.delete', { path, recursive }),
    mkdir: (path: string) => callWorkbench<{ ok: boolean }>('fs.mkdir', { path }),
    copy: (sourcePath: string, targetPath: string, overwrite = true) =>
        callWorkbench<{ ok: boolean }>('fs.copy', { sourcePath, targetPath, overwrite }),
    watchFs: (rootPath: string) => callWorkbench<{ ok: boolean }>('fs.watch', { rootPath }),
    openWorkbenchChat: (payload: OpenChatPayload) =>
        callWorkbench<{ ok: boolean }>('workbench.chat.openWithContext', payload),
    // Session checkpoints (safety layer). The store lives natively in the workbench bridge; these
    // just drive it. The host snapshots html/css in memory, caps the history and keeps the initial.
    checkpoints: {
        isEnabled: () => callWorkbench<boolean>('checkpoint.isEnabled'),
        list: () => callWorkbench<CheckpointInfo[]>('checkpoint.list'),
        ensureInitial: () => callWorkbench<CheckpointInfo[]>('checkpoint.ensureInitial'),
        create: () => callWorkbench<CheckpointInfo>('checkpoint.create'),
        restore: (id: number) => callWorkbench<CheckpointRestoreResult>('checkpoint.restore', { id }),
        rollback: () => callWorkbench<CheckpointRestoreResult>('checkpoint.rollback'),
        delete: (id: number) =>
            callWorkbench<{ deleted: boolean; reason?: string; checkpoints: CheckpointInfo[] }>('checkpoint.delete', { id }),
    },
};
