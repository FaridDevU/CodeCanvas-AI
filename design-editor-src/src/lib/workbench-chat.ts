// Bridges the Design editor to the real workbench chat (GitHub Copilot). There is no
// chat inside the iframe: a Design action builds context from the open app and the
// selected element and hands it to the native workbench chat via the bridge.

import type { EditorEngine } from '@/components/store/editor/engine';
import { getActiveProject } from './design-session';
import { isEmbeddedInWorkbench, workbench, type OpenChatPayload } from './workbench-bridge';

// Representative style props kept so the chat context stays short and readable.
const RELEVANT_STYLE_KEYS = [
    'color',
    'backgroundColor',
    'fontSize',
    'fontWeight',
    'width',
    'height',
    'display',
    'padding',
    'margin',
];

/** Whether the workbench chat can be reached (only true when embedded in CodeCanvas). */
export function isWorkbenchChatAvailable(): boolean {
    return isEmbeddedInWorkbench();
}

/**
 * Opens the native workbench chat with context about the open app and, when present,
 * the currently selected element (tag, styles and resolved source file/line).
 */
export async function sendToWorkbenchChat(
    editorEngine: EditorEngine,
    prompt?: string,
): Promise<void> {
    const payload: OpenChatPayload = {};

    const project = getActiveProject();
    const firstFrame = editorEngine.frames.getAll()[0];
    if (project) {
        payload.app = {
            rootPath: project.rootPath,
            framework: project.framework,
            url: firstFrame?.frame.url,
        };
    }

    const selected = editorEngine.elements.selected[0];
    if (selected) {
        const definedStyles = selected.styles?.defined ?? {};
        const styles: Record<string, string> = {};
        for (const key of RELEVANT_STYLE_KEYS) {
            if (definedStyles[key]) {
                styles[key] = definedStyles[key];
            }
        }

        payload.selectedElement = {
            tagName: selected.tagName,
            domId: selected.domId,
            oid: selected.oid ?? undefined,
            styles,
        };

        // Best-effort source resolution: map the element's oid back to its JSX location.
        if (selected.oid) {
            try {
                const branchData = editorEngine.branches.getBranchDataById(selected.branchId);
                const metadata = await branchData?.codeEditor.getJsxElementMetadata(selected.oid);
                if (metadata) {
                    payload.source = {
                        fileName: metadata.path,
                        lineNumber: metadata.startTag?.start?.line,
                        columnNumber: metadata.startTag?.start?.column,
                    };
                }
            } catch (err) {
                console.warn('[workbench-chat] Failed to resolve element source:', err);
            }
        }
    }

    if (prompt) {
        payload.prompt = prompt;
    }

    await workbench.openWorkbenchChat(payload);
}
