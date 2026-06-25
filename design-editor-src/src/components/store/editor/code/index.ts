import { type Action, type CodeDiffRequest, type FileToRequests } from '@onlook/models';
import type { StyleChange } from '@onlook/models/style';
import { StyleChangeType } from '@onlook/models/style';
import { toast } from '@onlook/ui/sonner';
import { assertNever } from '@onlook/utility';
import { makeAutoObservable } from 'mobx';

import { type EditorEngine } from '@/components/store/editor/engine';
import { getActiveProject } from '@/lib/design-session';
import { debugLog } from '@/lib/debug';
import { applyHtmlGroup, applyHtmlInsert, applyHtmlMove, applyHtmlRemove, applyHtmlStyleEdit, applyHtmlTextEdit, applyHtmlUngroup, pageFileForPathname } from '@/lib/html-writeback';
import {
    getEditTextRequests,
    getGroupRequests,
    getInsertImageRequests,
    getInsertRequests,
    getMoveRequests,
    getRemoveImageRequests,
    getRemoveRequests,
    getStyleRequests,
    getUngroupRequests,
    getWriteCodeRequests,
    processGroupedRequests,
} from './requests';

export class CodeManager {
    private htmlWriteQueue: Promise<void> = Promise.resolve();

    constructor(private editorEngine: EditorEngine) {
        makeAutoObservable(this, {
            htmlWriteQueue: false,
        });
    }

    private isHtmlProject(): boolean {
        return getActiveProject()?.framework === 'html';
    }

    /** Resolves the source HTML file for the page shown in a given frame. */
    private pageFileForFrame(frameId: string): string {
        const frame = this.editorEngine.frames.get(frameId)?.frame;
        let pathname = '/';
        try {
            if (frame?.url) pathname = new URL(frame.url).pathname;
        } catch {
            /* keep default */
        }
        return pageFileForPathname(pathname);
    }

    // Throttle the "not saved yet" notice so a burst of unsupported actions doesn't spam toasts.
    private lastUnsupportedNotice = 0;

    private notifyNotSaved(message: string) {
        const now = Date.now();
        if (now - this.lastUnsupportedNotice < 4000) return;
        this.lastUnsupportedNotice = now;
        toast.warning(message);
    }

    /**
     * Static-HTML persistence. Reflects edits into the real .html source (Code panel updates too),
     * replacing the JSX/oid pipeline which cannot work without build-time Onlook ids. The DOM change
     * was already applied by the ActionManager, so the canvas still updates visually; here we persist
     * the supported ops and warn (non-blocking) for the ones that don't write to HTML yet.
     */
    private async writeHtml(action: Action): Promise<void> {
        // Static HTML writes are read-modify-write patches against the same source files. Moveable
        // drag/resize persists asynchronously, while insert-text/box/media can fire immediately after
        // the mouse is released. Without this queue, two actions can both read the old HTML and the
        // later write appears to "reset" the earlier move. Keep the full HTML write path serialized.
        const run = this.htmlWriteQueue.catch(() => undefined).then(async () => {
            await this.writeHtmlDispatch(action);
        });
        this.htmlWriteQueue = run;
        await run;
    }

    private async writeHtmlDispatch(action: Action): Promise<void> {
        switch (action.type) {
            case 'update-style': {
                for (const target of action.targets) {
                    const pageFile = this.pageFileForFrame(target.frameId);
                    const styleUpdates: Record<string, { value: string; remove?: boolean }> = {};
                    for (const [prop, change] of Object.entries(target.change.updated as Record<string, StyleChange>)) {
                        styleUpdates[prop] = {
                            value: change.value,
                            remove: change.type === StyleChangeType.Remove,
                        };
                    }
                    await applyHtmlStyleEdit(target.oid, styleUpdates, pageFile);
                }
                break;
            }
            case 'edit-text': {
                for (const target of action.targets) {
                    const pageFile = this.pageFileForFrame(target.frameId);
                    const result = await applyHtmlTextEdit(target.oid, action.newContent, pageFile);
                    if (!result.ok && result.reason === 'has-children') {
                        this.notifyNotSaved('Text not saved: the element has inner content (icon, span...).');
                    }
                }
                break;
            }
            // Image/video/element drops: write the new element into the source HTML, then reload
            // the frame so it appears (Onlook's live DOM insert is disabled). Fallback to a warning
            // if the write fails.
            case 'insert-element': {
                const target = action.targets[0];
                if (!target) break;
                const pageFile = this.pageFileForFrame(target.frameId);
                const el = action.element;
                const result = await applyHtmlInsert(
                    {
                        tagName: el.tagName,
                        attributes: el.attributes,
                        styles: el.styles,
                        textContent: el.textContent,
                    },
                    action.location,
                    pageFile,
                );
                debugLog('[CC-INSERT] insert-element', { tag: el.tagName, ok: result.ok, location: action.location });
                if (result.ok) {
                    this.reloadFrame(target.frameId);
                } else {
                    this.notifyNotSaved('Could not save the element to the HTML.');
                }
                break;
            }
            // Remove / move: persist to the source and reload so the canvas matches.
            case 'remove-element': {
                const target = action.targets[0];
                if (!target) break;
                const pageFile = this.pageFileForFrame(target.frameId);
                const result = await applyHtmlRemove(target.oid, pageFile);
                if (result.ok) this.reloadFrame(target.frameId);
                else this.notifyNotSaved('Could not delete the element from the HTML.');
                break;
            }
            case 'move-element': {
                const target = action.targets[0];
                if (!target) break;
                const pageFile = this.pageFileForFrame(target.frameId);
                const result = await applyHtmlMove(target.oid, action.location, pageFile);
                if (result.ok) {
                    if (result.changed !== false) this.reloadFrame(target.frameId);
                } else {
                    this.notifyNotSaved('Could not move the element in the HTML.');
                }
                break;
            }
            // Wrap the selected siblings in a new container, persisted to the source. undo() reverses
            // this with an ungroup-elements carrying the same container oid (stamped as data-cc-id).
            case 'group-elements': {
                const pageFile = this.pageFileForFrame(action.parent.frameId);
                const result = await applyHtmlGroup(
                    action.container,
                    action.children.map((c) => c.oid),
                    pageFile,
                );
                if (result.ok) this.reloadFrame(action.parent.frameId);
                else this.notifyNotSaved('Could not group the elements in the HTML.');
                break;
            }
            case 'ungroup-elements': {
                const pageFile = this.pageFileForFrame(action.parent.frameId);
                const result = await applyHtmlUngroup(action.container.oid, pageFile);
                if (result.ok) this.reloadFrame(action.parent.frameId);
                else this.notifyNotSaved('Could not ungroup the element in the HTML.');
                break;
            }
            // Note: media drop/swap/background use insert-element / update-style (both handled), not
            // 'insert-image'/'remove-image' (those only exist as undo/redo inverses and are never
            // dispatched), so they are intentionally NOT persisted here.
            default:
                console.log('[html-writeback] action not persisted for static HTML:', action.type);
        }
    }

    /** Reloads a frame's iframe so a structural HTML change becomes visible. */
    private reloadFrame(frameId: string) {
        try {
            this.editorEngine.frames.get(frameId)?.view?.reload();
        } catch (err) {
            console.warn('[html-writeback] failed to reload frame', frameId, err);
        }
    }

    async write(action: Action) {
        try {
            if (this.isHtmlProject()) {
                await this.writeHtml(action);
                return;
            }
            // TODO: This is a hack to write code, we should refactor this
            if (action.type === 'write-code' && action.diffs[0]) {
                // Write-code actions don't have branch context, use active editor
                await this.editorEngine.fileSystem.writeFile(
                    action.diffs[0].path,
                    action.diffs[0].generated,
                );
            } else {
                const requests = await this.collectRequests(action);
                await this.writeRequest(requests);
            }
        } catch (error) {
            console.error('Error writing requests:', error);
            toast.error('Error writing requests', {
                description: error instanceof Error ? error.message : 'Unknown error',
            });
            this.editorEngine.branches.activeError.addCodeApplicationError(error instanceof Error ? error.message : 'Unknown error', action);
        }
    }

    async writeRequest(requests: CodeDiffRequest[]) {
        const groupedRequests = await this.groupRequestByFile(requests);
        const codeDiffs = await processGroupedRequests(groupedRequests);
        for (const diff of codeDiffs) {
            const fileGroup = groupedRequests.get(diff.path);
            if (!fileGroup) {
                throw new Error(`No request group found for file: ${diff.path}`);
            }

            const firstRequest = Array.from(fileGroup.oidToRequest.values())[0];
            if (!firstRequest) {
                throw new Error(`No requests found in group for file: ${diff.path}`);
            }

            const branchData = this.editorEngine.branches.getBranchDataById(firstRequest.branchId);
            if (!branchData) {
                throw new Error(`Branch not found for ID: ${firstRequest.branchId}`);
            }

            await branchData.codeEditor.writeFile(diff.path, diff.generated);
        }
    }

    private async collectRequests(action: Action): Promise<CodeDiffRequest[]> {
        switch (action.type) {
            case 'update-style':
                return await getStyleRequests(action);
            case 'insert-element':
                return await getInsertRequests(action);
            case 'move-element':
                return await getMoveRequests(action);
            case 'remove-element':
                return await getRemoveRequests(action);
            case 'edit-text':
                return await getEditTextRequests(action);
            case 'group-elements':
                return await getGroupRequests(action);
            case 'ungroup-elements':
                return await getUngroupRequests(action);
            case 'insert-image':
                return getInsertImageRequests(action);
            case 'remove-image':
                return getRemoveImageRequests(action);
            case 'write-code':
                return await getWriteCodeRequests(action);
            default:
                assertNever(action);
        }
    }

    async groupRequestByFile(requests: CodeDiffRequest[]): Promise<FileToRequests> {
        const requestByFile: FileToRequests = new Map();

        for (const request of requests) {
            const branchData = this.editorEngine.branches.getBranchDataById(request.branchId);
            const codeEditor = branchData?.codeEditor || this.editorEngine.fileSystem;

            const metadata = await codeEditor.getJsxElementMetadata(request.oid);
            if (!metadata) {
                throw new Error(`Metadata not found for oid: ${request.oid}`);
            }
            const fileContent = await codeEditor.readFile(metadata.path);
            if (fileContent instanceof Uint8Array) {
                throw new Error(`File is binary: ${metadata.path}`);
            }
            const path = metadata.path;

            let groupedRequest = requestByFile.get(path);
            if (!groupedRequest) {
                groupedRequest = { oidToRequest: new Map(), content: fileContent };
            }
            groupedRequest.oidToRequest.set(request.oid, request);
            requestByFile.set(path, groupedRequest);
        }
        return requestByFile;
    }

    clear() { }
}
