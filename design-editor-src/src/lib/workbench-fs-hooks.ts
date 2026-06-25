// Workbench-backed replacements for Onlook's @onlook/file-system hooks (useDirectory / useFile).
//
// Onlook read images from an in-browser CodeFileSystem that was seeded from the cloud sandbox. That
// sync is gone in the local port, so that filesystem is empty and the Images panel showed nothing.
// These hooks read the REAL project files through the workbench bridge (the same channel
// html-writeback already uses), so the existing Onlook Images UI works unchanged on local disk.

import { useEffect, useState } from 'react';
import { getActiveProjectRoot } from '@/lib/design-session';
import { onWorkbenchFsChange, workbench } from '@/lib/workbench-bridge';

export interface WorkbenchDirEntry {
    name: string;
    path: string; // project-root-relative, leading slash (e.g. "/assets/logo.png")
    isDirectory: boolean;
}

/** Joins root + project-relative path the same way html-writeback does (strips a leading ./ or /). */
function abs(rootPath: string, relPath: string): string {
    const clean = relPath.replace(/\\/g, '/').replace(/^\.?\//, '');
    const root = rootPath.replace(/\\/g, '/');
    return clean ? `${root}/${clean}` : root;
}

function childPath(folder: string, name: string): string {
    const base = folder.replace(/\/+$/, '');
    return base === '' || base === '/' ? `/${name}` : `${base}/${name}`;
}

/** base64 -> Uint8Array (browser atob). */
function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Lists a project folder over the workbench bridge. Re-fetches on workbench file changes (and
 * exposes `refetch` for immediate refresh after an upload/delete/rename). `folder` is project-root
 * relative ("/" for the root).
 */
export function useWorkbenchDirectory(folder: string) {
    const [entries, setEntries] = useState<WorkbenchDirEntry[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const root = getActiveProjectRoot();

    useEffect(() => {
        let cancelled = false;

        async function load() {
            if (!root) {
                setEntries([]);
                setLoading(false);
                return;
            }
            setLoading(true);
            try {
                const list = await workbench.readDir(abs(root, folder));
                if (cancelled) return;
                setEntries(
                    list.map((e) => ({
                        name: e.name,
                        isDirectory: e.isDirectory,
                        path: childPath(folder, e.name),
                    })),
                );
                setError(null);
            } catch (err) {
                if (!cancelled) {
                    setEntries([]);
                    setError(err as Error);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        void load();
        // Make sure the workbench pushes change events for this project, then refresh on them.
        if (root) void workbench.watchFs(root).catch(() => undefined);
        const unsub = onWorkbenchFsChange(() => void load());
        return () => {
            cancelled = true;
            unsub();
        };
    }, [root, folder, reloadKey]);

    const refetch = () => setReloadKey((k) => k + 1);
    return { entries, loading, error, refetch };
}

/**
 * Reads one project file over the workbench bridge for preview/thumbnails. SVGs come back as text;
 * everything else as bytes (so the existing blob-URL logic in image-item renders it).
 */
export function useWorkbenchFile(path: string) {
    const [content, setContent] = useState<Uint8Array | string | null>(null);
    const [loading, setLoading] = useState(true);
    const root = getActiveProjectRoot();

    useEffect(() => {
        let cancelled = false;

        async function load() {
            if (!root || !path) {
                setContent(null);
                setLoading(false);
                return;
            }
            setLoading(true);
            try {
                const isSvg = path.toLowerCase().endsWith('.svg');
                const res = await workbench.readFile(abs(root, path), isSvg ? 'utf8' : 'base64');
                if (cancelled) return;
                setContent(isSvg ? res.content : base64ToBytes(res.content));
            } catch {
                if (!cancelled) setContent(null);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        void load();
        return () => {
            cancelled = true;
        };
    }, [root, path]);

    return { content, loading };
}

/** Uploads media files into `folder` (project-relative) via the workbench bridge, base64-encoded. */
export async function uploadFilesToWorkbench(folder: string, files: File[]): Promise<void> {
    const root = getActiveProjectRoot();
    if (!root) throw new Error('No active project');
    // Ensure the destination exists (no-op if already there).
    try {
        await workbench.mkdir(abs(root, folder));
    } catch {
        /* may already exist */
    }
    for (const file of files) {
        const destRel = childPath(folder, file.name);
        // Never overwrite an existing asset silently: fail with a clear message instead.
        if (await workbench.exists(abs(root, destRel))) {
            throw new Error(`A file named "${file.name}" already exists at this destination. Rename it or delete the previous one before uploading.`);
        }
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        const base64 = btoa(bin);
        await workbench.writeFile(abs(root, destRel), base64, 'base64');
    }
}

export async function renameWorkbenchFile(oldPath: string, newPath: string): Promise<void> {
    const root = getActiveProjectRoot();
    if (!root) throw new Error('No active project');
    // Never clobber an existing file on rename: fail clearly so the user picks another name.
    if (await workbench.exists(abs(root, newPath))) {
        throw new Error(`A file already exists at "${newPath}". Choose another name.`);
    }
    await workbench.rename(abs(root, oldPath), abs(root, newPath));
}

export async function deleteWorkbenchFile(path: string): Promise<void> {
    const root = getActiveProjectRoot();
    if (!root) throw new Error('No active project');
    await workbench.delete(abs(root, path));
}
