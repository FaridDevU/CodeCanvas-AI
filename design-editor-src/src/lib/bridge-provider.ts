// Local code provider backed by the CodeCanvas workbench bridge. This replaces
// Onlook's CodeSandbox provider: every file operation lands on the real project on
// disk (through the workbench IFileService) and file watching is pushed back from
// the workbench. Terminal/task/git surface as harmless no-ops; the dev server runs
// in the integrated terminal managed by the bridge itself.

import {
    Provider,
    ProviderBackgroundCommand,
    ProviderFileWatcher,
    ProviderTask,
    ProviderTerminal,
    type CopyFileOutput,
    type CopyFilesInput,
    type CreateDirectoryInput,
    type CreateDirectoryOutput,
    type CreateSessionInput,
    type CreateSessionOutput,
    type CreateTerminalInput,
    type CreateTerminalOutput,
    type DeleteFilesInput,
    type DeleteFilesOutput,
    type DownloadFilesInput,
    type DownloadFilesOutput,
    type GetTaskInput,
    type GetTaskOutput,
    type GitStatusInput,
    type GitStatusOutput,
    type InitializeInput,
    type InitializeOutput,
    type ListFilesInput,
    type ListFilesOutput,
    type ListProjectsInput,
    type ListProjectsOutput,
    type PauseProjectInput,
    type PauseProjectOutput,
    type ReadFileInput,
    type ReadFileOutput,
    type RenameFileInput,
    type RenameFileOutput,
    type SetupInput,
    type SetupOutput,
    type StatFileInput,
    type StatFileOutput,
    type StopProjectInput,
    type StopProjectOutput,
    type TerminalBackgroundCommandInput,
    type TerminalBackgroundCommandOutput,
    type TerminalCommandInput,
    type TerminalCommandOutput,
    type WatchEvent,
    type WatchFilesInput,
    type WatchFilesOutput,
    type WriteFileInput,
    type WriteFileOutput,
} from '@onlook/code-provider';
import { onWorkbenchFsChange, workbench, type FsChange } from './workbench-bridge';

function base64ToUint8(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function uint8ToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

export interface BridgeProviderOptions {
    /** Absolute path of the chosen app's root on disk. */
    rootPath: string;
}

export class BridgeProvider extends Provider {
    private readonly rootPath: string;

    constructor(options: BridgeProviderOptions) {
        super();
        this.rootPath = options.rootPath;
    }

    /** Project-relative path -> absolute path the workbench bridge accepts. */
    private abs(relPath: string): string {
        const clean = relPath.replace(/\\/g, '/').replace(/^\.?\//, '');
        if (!clean || clean === '.') {
            return this.rootPath;
        }
        return `${this.rootPath.replace(/\\/g, '/')}/${clean}`;
    }

    async initialize(_input: InitializeInput): Promise<InitializeOutput> {
        return {};
    }

    async writeFile(input: WriteFileInput): Promise<WriteFileOutput> {
        const { path, content } = input.args;
        if (typeof content === 'string') {
            await workbench.writeFile(this.abs(path), content, 'utf8');
        } else {
            await workbench.writeFile(this.abs(path), uint8ToBase64(content), 'base64');
        }
        return { success: true };
    }

    async readFile(input: ReadFileInput): Promise<ReadFileOutput> {
        const { path } = input.args;
        const result = await workbench.readFile(this.abs(path), 'auto');
        if (result.encoding === 'base64') {
            const bytes = base64ToUint8(result.content);
            return {
                file: {
                    path,
                    content: bytes,
                    type: 'binary',
                    toString: () => '',
                },
            };
        }
        return {
            file: {
                path,
                content: result.content,
                type: 'text',
                toString: () => result.content,
            },
        };
    }

    async statFile(input: StatFileInput): Promise<StatFileOutput> {
        const stat = await workbench.stat(this.abs(input.args.path));
        return {
            type: stat.type,
            size: stat.size,
            mtime: stat.mtime,
            ctime: stat.ctime,
        };
    }

    async renameFile(input: RenameFileInput): Promise<RenameFileOutput> {
        await workbench.rename(this.abs(input.args.oldPath), this.abs(input.args.newPath));
        return {};
    }

    async deleteFiles(input: DeleteFilesInput): Promise<DeleteFilesOutput> {
        await workbench.delete(this.abs(input.args.path), input.args.recursive !== false);
        return {};
    }

    async listFiles(input: ListFilesInput): Promise<ListFilesOutput> {
        const entries = await workbench.readDir(this.abs(input.args.path));
        return {
            files: entries.map((entry) => ({
                name: entry.name,
                type: entry.isDirectory ? ('directory' as const) : ('file' as const),
                isSymlink: false,
            })),
        };
    }

    async downloadFiles(_input: DownloadFilesInput): Promise<DownloadFilesOutput> {
        return { url: '' };
    }

    async copyFiles(input: CopyFilesInput): Promise<CopyFileOutput> {
        await workbench.copy(
            this.abs(input.args.sourcePath),
            this.abs(input.args.targetPath),
            input.args.overwrite !== false,
        );
        return {};
    }

    async createDirectory(input: CreateDirectoryInput): Promise<CreateDirectoryOutput> {
        await workbench.mkdir(this.abs(input.args.path));
        return {};
    }

    async watchFiles(input: WatchFilesInput): Promise<WatchFilesOutput> {
        const watcher = new BridgeFileWatcher(this.rootPath, input.args.excludes ?? []);
        if (input.onFileChange) {
            watcher.registerEventCallback(input.onFileChange);
        }
        await watcher.start(input);
        return { watcher };
    }

    async createTerminal(_input: CreateTerminalInput): Promise<CreateTerminalOutput> {
        return { terminal: new BridgeNoopTerminal() };
    }

    async getTask(_input: GetTaskInput): Promise<GetTaskOutput> {
        return { task: new BridgeNoopTask() };
    }

    async runCommand(_input: TerminalCommandInput): Promise<TerminalCommandOutput> {
        // Commands run in the workbench integrated terminal, not through the provider.
        return { output: '' };
    }

    async runBackgroundCommand(
        _input: TerminalBackgroundCommandInput,
    ): Promise<TerminalBackgroundCommandOutput> {
        return { command: new BridgeNoopCommand() };
    }

    async gitStatus(_input: GitStatusInput): Promise<GitStatusOutput> {
        return { changedFiles: [] };
    }

    async setup(_input: SetupInput): Promise<SetupOutput> {
        return {};
    }

    async createSession(_input: CreateSessionInput): Promise<CreateSessionOutput> {
        return {};
    }

    async reload(): Promise<boolean> {
        return true;
    }

    async reconnect(): Promise<void> {
        // Nothing to reconnect: the bridge lives in the same window.
    }

    async ping(): Promise<boolean> {
        return true;
    }

    async pauseProject(_input: PauseProjectInput): Promise<PauseProjectOutput> {
        return {};
    }

    async stopProject(_input: StopProjectInput): Promise<StopProjectOutput> {
        return {};
    }

    async listProjects(_input: ListProjectsInput): Promise<ListProjectsOutput> {
        return {};
    }

    async destroy(): Promise<void> {
        // Watchers unsubscribe themselves via their stop() handlers.
    }
}

class BridgeFileWatcher extends ProviderFileWatcher {
    private callback: ((event: WatchEvent) => Promise<void>) | null = null;
    private unsubscribe: (() => void) | null = null;

    constructor(
        private readonly rootPath: string,
        private readonly excludes: string[],
    ) {
        super();
    }

    async start(_input: WatchFilesInput): Promise<void> {
        await workbench.watchFs(this.rootPath);
        const normalizedRoot = this.rootPath.replace(/\\/g, '/').toLowerCase();
        this.unsubscribe = onWorkbenchFsChange((changes: FsChange[]) => {
            const relevant = changes.filter((change) => {
                if (change.rootPath.replace(/\\/g, '/').toLowerCase() !== normalizedRoot) {
                    return false;
                }
                const segments = change.path.split('/');
                return !this.excludes.some((excluded) =>
                    segments.includes(excluded.replace(/\/$/, '')),
                );
            });
            if (relevant.length === 0 || !this.callback) {
                return;
            }
            for (const type of ['add', 'change', 'remove'] as const) {
                const paths = relevant.filter((c) => c.type === type).map((c) => c.path);
                if (paths.length > 0) {
                    void this.callback({ type, paths });
                }
            }
        });
    }

    async stop(): Promise<void> {
        this.unsubscribe?.();
        this.unsubscribe = null;
    }

    registerEventCallback(callback: (event: WatchEvent) => Promise<void>): void {
        this.callback = callback;
    }
}

class BridgeNoopTerminal extends ProviderTerminal {
    get id(): string {
        return 'local-terminal';
    }
    get name(): string {
        return 'local';
    }
    open(): Promise<string> {
        return Promise.resolve('');
    }
    write(): Promise<void> {
        return Promise.resolve();
    }
    run(): Promise<void> {
        return Promise.resolve();
    }
    kill(): Promise<void> {
        return Promise.resolve();
    }
    onOutput(_callback: (data: string) => void): () => void {
        return () => { };
    }
}

class BridgeNoopTask extends ProviderTask {
    get id(): string {
        return 'dev';
    }
    get name(): string {
        return 'dev';
    }
    get command(): string {
        return '';
    }
    open(): Promise<string> {
        return Promise.resolve('');
    }
    run(): Promise<void> {
        return Promise.resolve();
    }
    restart(): Promise<void> {
        return Promise.resolve();
    }
    stop(): Promise<void> {
        return Promise.resolve();
    }
    onOutput(_callback: (data: string) => void): () => void {
        return () => { };
    }
}

class BridgeNoopCommand extends ProviderBackgroundCommand {
    get name(): string {
        return 'local';
    }
    get command(): string {
        return '';
    }
    open(): Promise<string> {
        return Promise.resolve('');
    }
    restart(): Promise<void> {
        return Promise.resolve();
    }
    kill(): Promise<void> {
        return Promise.resolve();
    }
    onOutput(_callback: (data: string) => void): () => void {
        return () => { };
    }
}
