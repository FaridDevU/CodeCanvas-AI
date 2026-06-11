// Tracks which project of the workspace is open in Design. Set by the start flow
// (use-start-project) before the sandbox session connects the local provider.

export interface ActiveProjectInfo {
    rootPath: string;
    framework: string;
}

let activeProject: ActiveProjectInfo | null = null;

export function setActiveProject(info: ActiveProjectInfo | null): void {
    activeProject = info;
}

export function getActiveProject(): ActiveProjectInfo | null {
    return activeProject;
}

export function setActiveProjectRoot(rootPath: string | null): void {
    activeProject = rootPath ? { rootPath, framework: activeProject?.framework ?? 'unknown' } : null;
}

export function getActiveProjectRoot(): string | null {
    return activeProject?.rootPath ?? null;
}
