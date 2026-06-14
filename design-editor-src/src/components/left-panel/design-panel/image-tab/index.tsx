'use client';

import { observer } from 'mobx-react-lite';

import { Icons } from '@onlook/ui/icons';
import { toast } from '@onlook/ui/sonner';

import { useEditorEngine } from '@/components/store/editor';
import { BreadcrumbNavigation } from './breadcrumb-navigation';
import { FolderList } from './folder-list';
import { useAssetUsage } from './hooks/use-asset-usage';
import { useImageOperations } from './hooks/use-image-operations';
import { useNavigation } from './hooks/use-navigation';
import { ImageGrid } from './image-grid';
import { SearchUploadBar } from './search-upload-bar';

export const ImagesTab = observer(() => {
    const editorEngine = useEditorEngine();
    const projectId = editorEngine.projectId;
    const branchId = editorEngine.branches.activeBranch.id;

    // Navigation state and handlers. Start at the project root: a static HTML project has no
    // `public/` folder, so the user browses real folders (assets, images, ...) from the top.
    const {
        activeFolder,
        search,
        setSearch,
        breadcrumbSegments,
        navigateToFolder,
        handleFolderClick,
        filterImages,
    } = useNavigation('/');

    // Get the CodeEditorApi for the active branch
    const branchData = editorEngine.branches.getBranchDataById(
        editorEngine.branches.activeBranch.id,
    );

    // Image operations and data
    const {
        folders,
        images: allImages,
        loading,
        error,
        isUploading,
        handleUpload,
        handleRename,
        handleDelete,
    } = useImageOperations(projectId, branchId, activeFolder, branchData?.codeEditor, editorEngine);

    // Filter images based on search
    const images = filterImages(allImages);

    // Which assets are still referenced by the project's markup/source (project-wide, so it doesn't
    // depend on the folder being browsed). Keyed by project so it scans once per project rather than on
    // every folder navigation; reopening the tab re-scans. Read-only — never deletes anything.
    const { referencedNames, ready: usageReady } = useAssetUsage(projectId);
    const unusedCount = usageReady
        ? allImages.filter((i) => !referencedNames.has(i.name.toLowerCase())).length
        : 0;

    // Handler functions with error handling and feedback
    const handleRenameWithFeedback = async (oldPath: string, newName: string) => {
        try {
            await handleRename(oldPath, newName);
            toast.success('Image renamed successfully');
        } catch (error) {
            console.error('Failed to rename image:', error);
            toast.error(
                `Failed to rename image: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
            throw error;
        }
    };

    const handleDeleteWithFeedback = async (filePath: string) => {
        try {
            await handleDelete(filePath);
            toast.success('Image deleted successfully');
        } catch (error) {
            console.error('Failed to delete image:', error);
            toast.error(
                `Failed to delete image: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
            throw error;
        }
    };

    if (loading) {
        return (
            <div className="flex h-full w-full items-center justify-center gap-2">
                <Icons.LoadingSpinner className="h-4 w-4 animate-spin" />
                Loading images...
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex h-full w-full items-center justify-center text-sm text-red-500">
                Error: {error.message}
            </div>
        );
    }

    return (
        <div className="flex h-full w-full flex-col gap-3 p-3">
            {/* Make it explicit this is the project's file library, not "what's on the canvas". Deleting
                an image from the canvas does NOT remove the file here, and vice versa. */}
            <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-foreground-primary">Biblioteca de assets</span>
                <span className="text-[11px] leading-tight text-foreground-tertiary">
                    Archivos del proyecto. Eliminar del lienzo no borra el archivo; usa el menú para borrarlo aquí.
                </span>
                {usageReady && unusedCount > 0 && (
                    <span className="text-[11px] leading-tight text-amber-500">
                        {unusedCount} sin usar (no referenciados en el código). Revisa y bórralos con el menú si quieres.
                    </span>
                )}
            </div>

            <SearchUploadBar
                search={search}
                setSearch={setSearch}
                isUploading={isUploading}
                onUpload={handleUpload}
            />

            <BreadcrumbNavigation
                breadcrumbSegments={breadcrumbSegments}
                onNavigate={navigateToFolder}
            />

            <FolderList folders={folders} onFolderClick={handleFolderClick} />

            <ImageGrid
                images={images as any}
                projectId={projectId}
                branchId={branchId}
                search={search}
                referencedNames={referencedNames}
                usageReady={usageReady}
                onUpload={handleUpload}
                onRename={handleRenameWithFeedback}
                onDelete={handleDeleteWithFeedback}
            />
        </div>
    );
});
