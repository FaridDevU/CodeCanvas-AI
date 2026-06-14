// Tracks which project of the workspace is open in Design. Set by the start flow
// (use-start-project) before the sandbox session connects the local provider.

export interface ActiveProjectPage {
    name: string;
    path: string;
}

export interface ActiveProjectInfo {
    rootPath: string;
    framework: string;
    // Pages detected by the workbench analyzer. For static HTML projects (no Next.js router) this
    // is how the Pages panel gets real entries, since there is nothing to scan in the sandbox.
    pages?: ActiveProjectPage[];
}

let activeProject: ActiveProjectInfo | null = null;

export function setActiveProject(info: ActiveProjectInfo | null): void {
    activeProject = info;
}

export function getActiveProject(): ActiveProjectInfo | null {
    return activeProject;
}

export function getActiveProjectPages(): ActiveProjectPage[] {
    return activeProject?.pages ?? [];
}

export function setActiveProjectRoot(rootPath: string | null): void {
    activeProject = rootPath
        ? { rootPath, framework: activeProject?.framework ?? 'unknown', pages: activeProject?.pages }
        : null;
}

export function getActiveProjectRoot(): string | null {
    return activeProject?.rootPath ?? null;
}
