import type { EditorEngine } from '@/components/store/editor/engine';
import {
    deleteWorkbenchFile,
    renameWorkbenchFile,
    uploadFilesToWorkbench,
    useWorkbenchDirectory,
} from '@/lib/workbench-fs-hooks';
import type { CodeFileSystem } from '@onlook/file-system';
import { sanitizeFilename } from '@onlook/utility';
import { isImageFile, isVideoFile } from '@onlook/utility/src/file';
import path from 'path';
import { useMemo, useState } from 'react';

// Directories that are never useful to browse for media in a project tree.
const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.onlook', '.turbo', 'coverage']);

// `codeEditor` is kept in the signature for compatibility with the Onlook ImagesTab call site, but
// the local editor reads/writes the real project through the workbench bridge instead.
export const useImageOperations = (_projectId: string, _branchId: string, activeFolder: string, _codeEditor?: CodeFileSystem, editorEngine?: EditorEngine) => {
    const [isUploading, setIsUploading] = useState(false);

    const { entries, loading, error, refetch } = useWorkbenchDirectory(activeFolder);

    // Available subfolders (minus build/vendor noise).
    const folders = useMemo(() => {
        if (!entries) return [];
        return entries.filter((entry) => entry.isDirectory && !IGNORED_DIRS.has(entry.name));
    }, [entries]);

    // Media (images and videos) in the active folder.
    const images = useMemo(() => {
        if (!entries) return [];
        return entries.filter(
            (entry) => !entry.isDirectory && (isImageFile(entry.name) || isVideoFile(entry.name)),
        );
    }, [entries]);

    const handleUpload = async (files: FileList) => {
        if (!files.length) return;
        setIsUploading(true);
        try {
            const media = Array.from(files).filter((file) => {
                if (!isImageFile(file.name) && !isVideoFile(file.name)) {
                    console.warn(`Skipping non-media file: ${file.name}`);
                    return false;
                }
                return true;
            });
            if (media.length) {
                await uploadFilesToWorkbench(activeFolder, media);
                refetch();
            }
        } catch (error) {
            console.error('Failed to upload files:', error);
            throw error;
        } finally {
            setIsUploading(false);
        }
    };

    const handleRename = async (oldPath: string, newName: string) => {
        const directory = path.dirname(oldPath);
        const sanitizedName = sanitizeFilename(newName);
        const newPath = path.join(directory, sanitizedName).replace(/\\/g, '/');
        await renameWorkbenchFile(oldPath, newPath);
        refetch();
        setTimeout(() => editorEngine?.frames.reloadAllViews(), 300);
    };

    const handleDelete = async (filePath: string) => {
        await deleteWorkbenchFile(filePath);
        refetch();
    };

    return {
        folders,
        images,
        loading,
        error,
        isUploading,
        handleUpload,
        handleRename,
        handleDelete,
    };
};
