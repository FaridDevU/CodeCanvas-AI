// Local sync engine between the BridgeProvider (the real project on disk, through the
// CodeCanvas workbench) and the in-browser CodeFileSystem (ZenFS) that backs the visual
// editor. Replaces Onlook's cloud sync engine, keeping its public surface:
//   CodeProviderSync.getInstance(provider, fs, id, { exclude }) / start() / release()
//
// Flow:
//  - Initial pull: disk -> CodeFileSystem. JSX files get instrumented (data-oid +
//    preload script in the layout) by CodeFileSystem.writeFile; when instrumentation
//    changes the content, the result is pushed back to disk so the dev server serves
//    elements the canvas can map back to code.
//  - fs watcher: editor writes (style/move/insert actions) -> disk.
//  - provider watcher: disk edits (e.g. in the Code editor) -> CodeFileSystem,
//    re-instrumenting new elements.
// Echo loops are avoided with per-path suppression windows plus content-hash checks.

import type { Provider, WatchEvent } from '@onlook/code-provider';
import type { CodeFileSystem } from '@onlook/file-system';

const SUPPRESS_WINDOW_MS = 2500;
const NON_JSX_BATCH_SIZE = 8;

export function hashContent(content: string | Uint8Array): string {
    if (typeof content !== 'string') {
        return `bin:${content.length}`;
    }
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        hash = (hash << 5) - hash + content.charCodeAt(i);
        hash |= 0;
    }
    return String(hash >>> 0);
}

interface SyncOptions {
    exclude?: readonly string[];
}

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.?\//, '');
}

export class CodeProviderSync {
    private static instances = new Map<string, CodeProviderSync>();

    private refCount = 0;
    private started = false;
    private fsUnwatch: (() => void) | null = null;
    private providerWatcherStop: (() => Promise<void>) | null = null;
    private readonly suppressedFsPaths = new Map<string, number>();
    private readonly suppressedProviderPaths = new Map<string, number>();
    private readonly excludes: string[];

    private constructor(
        private readonly provider: Provider,
        private readonly fs: CodeFileSystem,
        private readonly id: string,
        options: SyncOptions,
    ) {
        this.excludes = (options.exclude ?? []).map(normalizePath);
    }

    static getInstance(
        provider: Provider,
        fs: CodeFileSystem,
        id: string,
        options: SyncOptions = {},
    ): CodeProviderSync {
        let instance = CodeProviderSync.instances.get(id);
        if (!instance) {
            instance = new CodeProviderSync(provider, fs, id, options);
            CodeProviderSync.instances.set(id, instance);
        }
        instance.refCount++;
        return instance;
    }

    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;

        await (this.fs as any).initialize?.();
        await this.initialPull();
        this.watchFs();
        await this.watchProvider();
    }

    release(): void {
        this.refCount--;
        if (this.refCount > 0) {
            return;
        }
        this.fsUnwatch?.();
        this.fsUnwatch = null;
        void this.providerWatcherStop?.();
        this.providerWatcherStop = null;
        this.started = false;
        CodeProviderSync.instances.delete(this.id);
    }

    // Kept for API compatibility with the previous stub.
    stop(): void {
        this.release();
    }

    dispose(): void {
        this.release();
    }

    // --- Initial pull (disk -> editor fs, with oid write-back to disk) ---

    private async initialPull(): Promise<void> {
        const startTime = Date.now();
        const files: string[] = [];
        await this.collectProviderFiles('', files);

        const jsxFiles = files.filter((f) => this.isJsxFile(f));
        const otherFiles = files.filter((f) => !this.isJsxFile(f));

        // Non-JSX files in parallel batches; they need no AST processing.
        for (let i = 0; i < otherFiles.length; i += NON_JSX_BATCH_SIZE) {
            const batch = otherFiles.slice(i, i + NON_JSX_BATCH_SIZE);
            await Promise.all(batch.map((path) => this.pullFile(path, false)));
        }

        // JSX files sequentially: CodeFileSystem serializes index/metadata updates.
        for (const path of jsxFiles) {
            await this.pullFile(path, true);
        }

        console.log(
            `[CodeProviderSync] Initial sync: ${files.length} files (${jsxFiles.length} JSX) in ${Date.now() - startTime}ms`,
        );
    }

    private async collectProviderFiles(dir: string, out: string[]): Promise<void> {
        let entries;
        try {
            entries = (await this.provider.listFiles({ args: { path: dir } })).files;
        } catch {
            return;
        }
        for (const entry of entries) {
            const rel = dir ? `${dir}/${entry.name}` : entry.name;
            if (this.isExcluded(rel)) {
                continue;
            }
            if (entry.type === 'directory') {
                await this.collectProviderFiles(rel, out);
            } else {
                out.push(rel);
            }
        }
    }

    private async pullFile(path: string, pushInstrumented: boolean): Promise<void> {
        try {
            const { file } = await this.provider.readFile({ args: { path } });
            if (file.content == null) {
                return;
            }

            const existing = await this.fs.readFile(path).catch(() => null);
            if (
                existing !== null &&
                typeof existing === typeof file.content &&
                hashContent(existing as any) === hashContent(file.content)
            ) {
                return;
            }

            this.suppress(this.suppressedFsPaths, path);
            await this.fs.writeFile(path, file.content);

            if (pushInstrumented && typeof file.content === 'string') {
                const processed = await this.fs.readFile(path);
                if (typeof processed === 'string' && processed !== file.content) {
                    this.suppress(this.suppressedProviderPaths, path);
                    await this.provider.writeFile({
                        args: { path, content: processed, overwrite: true },
                    });
                }
            }
        } catch (err) {
            console.warn(`[CodeProviderSync] Failed to pull ${path}:`, err);
        }
    }

    // --- Editor fs -> disk ---

    private watchFs(): void {
        this.fsUnwatch = this.fs.watchDirectory('/', (event) => {
            void this.onFsEvent(event.type, event.path);
        });
    }

    private async onFsEvent(type: 'create' | 'update' | 'delete', rawPath: string): Promise<void> {
        const path = normalizePath(rawPath);
        if (this.isExcluded(path) || this.isSuppressed(this.suppressedFsPaths, path)) {
            return;
        }

        try {
            if (type === 'delete') {
                this.suppress(this.suppressedProviderPaths, path);
                await this.provider.deleteFiles({ args: { path } });
                return;
            }
            const content = await this.fs.readFile(path).catch(() => null);
            if (content == null) {
                return;
            }
            this.suppress(this.suppressedProviderPaths, path);
            await this.provider.writeFile({ args: { path, content, overwrite: true } });
        } catch (err) {
            console.warn(`[CodeProviderSync] Failed to push ${path}:`, err);
        }
    }

    // --- Disk -> editor fs ---

    private async watchProvider(): Promise<void> {
        try {
            const { watcher } = await this.provider.watchFiles({
                args: { path: '', recursive: true, excludes: [...this.excludes] },
                onFileChange: async (event) => this.onProviderEvent(event),
            });
            this.providerWatcherStop = () => watcher.stop();
        } catch (err) {
            console.warn('[CodeProviderSync] Failed to watch provider files:', err);
        }
    }

    private async onProviderEvent(event: WatchEvent): Promise<void> {
        for (const rawPath of event.paths) {
            const path = normalizePath(rawPath);
            if (this.isExcluded(path) || this.isSuppressed(this.suppressedProviderPaths, path)) {
                continue;
            }

            try {
                if (event.type === 'remove') {
                    this.suppress(this.suppressedFsPaths, path);
                    await this.fs.deleteFile(path).catch(() => undefined);
                    continue;
                }

                const { file } = await this.provider.readFile({ args: { path } });
                if (file.content == null) {
                    continue;
                }
                const current = await this.fs.readFile(path).catch(() => null);
                if (
                    current !== null &&
                    typeof current === typeof file.content &&
                    hashContent(current as any) === hashContent(file.content)
                ) {
                    continue;
                }

                this.suppress(this.suppressedFsPaths, path);
                await this.fs.writeFile(path, file.content);

                // New elements typed in the Code editor get oids on the fly.
                if (this.isJsxFile(path) && typeof file.content === 'string') {
                    const processed = await this.fs.readFile(path);
                    if (typeof processed === 'string' && processed !== file.content) {
                        this.suppress(this.suppressedProviderPaths, path);
                        await this.provider.writeFile({
                            args: { path, content: processed, overwrite: true },
                        });
                    }
                }
            } catch {
                // Directories and transient files surface here; nothing to sync.
            }
        }
    }

    // --- Helpers ---

    private isJsxFile(path: string): boolean {
        return /\.(jsx?|tsx?)$/i.test(path);
    }

    private isExcluded(path: string): boolean {
        const normalized = normalizePath(path);
        const segments = normalized.split('/');
        return this.excludes.some((excluded) => {
            if (excluded.includes('/')) {
                return normalized === excluded || normalized.startsWith(`${excluded}/`);
            }
            return segments.includes(excluded);
        });
    }

    private suppress(map: Map<string, number>, path: string): void {
        map.set(normalizePath(path), Date.now());
    }

    private isSuppressed(map: Map<string, number>, path: string): boolean {
        const normalized = normalizePath(path);
        const timestamp = map.get(normalized);
        if (timestamp === undefined) {
            return false;
        }
        if (Date.now() - timestamp > SUPPRESS_WINDOW_MS) {
            map.delete(normalized);
            return false;
        }
        return true;
    }
}
