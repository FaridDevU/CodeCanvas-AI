/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// RPC bridge between the Design editor iframe and the workbench. The iframe posts
// `codecanvas:bridge-request` messages; we validate the source window, dispatch the
// method against workbench services and reply with `codecanvas:bridge-response`.
// The client side lives in design-editor-src/src/lib/workbench-bridge.ts.

import { addDisposableListener } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { timeout, RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer, encodeBase64, decodeBase64 } from '../../../../base/common/buffer.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITerminalService, ITerminalGroupService, ITerminalInstance } from '../../terminal/browser/terminal.js';
import { DesignProjectAnalyzer, IGNORED_DIRS } from './designProjectAnalyzer.js';
import { TOGGLE_DESIGN_FULL_WINDOW_COMMAND_ID } from './designFullWindowMode.js';

// Save status surfaced to the Design canvas toolbar. Design writes straight to disk on every
// action, so the user sees this instead of a fake "Save" button.
export type DesignSaveState = 'idle' | 'saving' | 'saved' | 'error';

interface BridgeRequest {
	readonly type: 'codecanvas:bridge-request';
	readonly id: number;
	readonly method: string;
	readonly params?: Record<string, unknown>;
}

interface OpenSourcePayload {
	readonly fileName: string;
	readonly lineNumber?: number;
	readonly columnNumber?: number;
}

interface OpenChatPayload {
	readonly prompt?: string;
	readonly selectedElement?: {
		readonly tagName?: string;
		readonly domId?: string;
		readonly oid?: string;
		readonly text?: string;
		readonly styles?: Record<string, string>;
	};
	readonly source?: {
		readonly fileName?: string;
		readonly lineNumber?: number;
		readonly columnNumber?: number;
	};
	readonly app?: {
		readonly rootPath: string;
		readonly framework: string;
		readonly url?: string;
	};
}

export class DesignEditorBridge extends Disposable {

	private readonly analyzer: DesignProjectAnalyzer;
	// Dev terminals keyed by app root path so a second start reuses the existing one.
	private readonly devTerminals = new Map<string, ITerminalInstance>();
	// Ports assigned to static HTML apps (served with `npx serve`).
	private readonly staticPorts = new Map<string, number>();

	// --- Save status ---
	private readonly _onDidChangeSaveState = this._register(new Emitter<DesignSaveState>());
	readonly onDidChangeSaveState: Event<DesignSaveState> = this._onDidChangeSaveState.event;
	private _saveState: DesignSaveState = 'idle';
	private pendingWrites = 0;
	private readonly resetSavedScheduler: RunOnceScheduler;

	// fsPath -> expiry time for files Design itself just wrote. Their onDidFilesChange events are
	// suppressed so a Design edit doesn't echo back to the iframe as an external change (which would
	// reload/re-sync the very frame we just patched). Restores deliberately don't stamp: the preview
	// SHOULD reload to reflect a rollback.
	private readonly recentSelfWrites = new Map<string, number>();
	private static readonly SELF_WRITE_ECHO_MS = 1500;

	get saveState(): DesignSaveState { return this._saveState; }

	constructor(
		private readonly iframe: HTMLIFrameElement,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.analyzer = instantiationService.createInstance(DesignProjectAnalyzer);

		// After a quiet period the "Cambios guardados" pill fades back to idle so it isn't permanent.
		this.resetSavedScheduler = this._register(new RunOnceScheduler(() => {
			if (this._saveState === 'saved') {
				this.setSaveState('idle');
			}
		}, 2500));

		this._register(addDisposableListener(mainWindow, 'message', (e: MessageEvent) => {
			// Only accept messages coming from the Design iframe itself; the user's app
			// preview (untrusted code) must not be able to drive the workbench.
			if (e.source !== this.iframe.contentWindow) {
				return;
			}
			const data = e.data;
			if (!data || typeof data !== 'object') {
				return;
			}
			if (data.type === 'codecanvas:toggle-design-fullscreen') {
				this.commandService.executeCommand(TOGGLE_DESIGN_FULL_WINDOW_COMMAND_ID);
				return;
			}
			if (data.type === 'codecanvas:open-source') {
				this.openSourceFile(data.source);
				return;
			}
			if (data.type === 'codecanvas:bridge-request') {
				this.handleRequest(data as BridgeRequest);
			}
		}));
	}

	private async handleRequest(request: BridgeRequest): Promise<void> {
		try {
			const result = await this.dispatch(request.method, request.params ?? {});
			this.reply(request.id, result, undefined);
		} catch (err) {
			this.reply(request.id, undefined, err instanceof Error ? err.message : String(err));
		}
	}

	private reply(id: number, result: unknown, error: string | undefined): void {
		this.iframe.contentWindow?.postMessage(
			{ type: 'codecanvas:bridge-response', id, ok: !error, result, error },
			'*'
		);
	}

	private dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case 'project.list': return this.listProjects();
			case 'project.startDev': return this.startDev(String(params.rootPath ?? ''));
			case 'project.waitForPort': return this.waitForPort(Number(params.port), Number(params.timeoutMs ?? 60000));
			case 'fs.readFile': return this.readFile(String(params.path ?? ''), params.encoding === 'utf8' ? 'utf8' : params.encoding === 'base64' ? 'base64' : 'auto');
			case 'fs.writeFile': return this.writeFile(String(params.path ?? ''), String(params.content ?? ''), params.encoding === 'base64' ? 'base64' : 'utf8');
			case 'fs.readDir': return this.readDir(String(params.path ?? ''));
			case 'fs.exists': return this.exists(String(params.path ?? ''));
			case 'fs.stat': return this.statPath(String(params.path ?? ''));
			case 'fs.rename': return this.rename(String(params.oldPath ?? ''), String(params.newPath ?? ''));
			case 'fs.delete': return this.deletePath(String(params.path ?? ''), params.recursive !== false);
			case 'fs.mkdir': return this.mkdir(String(params.path ?? ''));
			case 'fs.copy': return this.copy(String(params.sourcePath ?? ''), String(params.targetPath ?? ''), params.overwrite !== false);
			case 'fs.watch': return this.watch(String(params.rootPath ?? ''));
			case 'workbench.chat.openWithContext': return this.openWorkbenchChat(params as unknown as OpenChatPayload);
			default: return Promise.reject(new Error(`Unknown bridge method: ${method}`));
		}
	}

	// --- Projects / terminal ---

	private async listProjects() {
		const analysis = await this.analyzer.analyze();
		return analysis.apps.map(app => ({
			name: app.name,
			rootPath: app.rootUri.fsPath,
			framework: app.framework,
			stack: app.stack,
			devCommand: app.devCommand,
			devPort: app.devPort,
			editable: app.editable,
			reason: app.reason,
			pages: app.pages,
		}));
	}

	private async startDev(rootPath: string): Promise<{ port: number | null; alreadyRunning: boolean }> {
		const analysis = await this.analyzer.analyze();
		const app = analysis.apps.find(a => a.rootUri.fsPath === rootPath);
		if (!app) {
			throw new Error(`No analyzed app at ${rootPath}`);
		}

		// Static HTML/CSS apps have no dev script; serve the folder with a local static server.
		if (app.framework === 'html' || !app.devCommand) {
			return this.startStaticServer(app.rootUri, app.name);
		}

		// Already serving (started outside Design or in a previous session)? Reuse it.
		if (app.devPort && await this.isPortReachable(app.devPort)) {
			return { port: app.devPort, alreadyRunning: true };
		}

		const existing = this.devTerminals.get(rootPath);
		if (existing) {
			this.terminalService.setActiveInstance(existing);
			await this.terminalGroupService.showPanel(false);
			return { port: app.devPort, alreadyRunning: true };
		}

		const command = await this.resolveDevInvocation(app.rootUri);
		if (!command) {
			throw new Error(`App "${app.name}" has no dev/start script`);
		}

		const instance = await this.terminalService.createTerminal({
			config: { name: `Design: ${app.name}`, cwd: app.rootUri },
		});
		this.devTerminals.set(rootPath, instance);
		this._register(instance.onDisposed(() => this.devTerminals.delete(rootPath)));

		this.terminalService.setActiveInstance(instance);
		await this.terminalGroupService.showPanel(false);
		await instance.sendText(command, true);

		return { port: app.devPort, alreadyRunning: false };
	}

	/** Serves a static HTML/CSS folder with `npx serve` on a free local port. */
	private async startStaticServer(rootUri: URI, name: string): Promise<{ port: number | null; alreadyRunning: boolean }> {
		const key = rootUri.fsPath;
		const assigned = this.staticPorts.get(key);
		if (assigned && await this.isPortReachable(assigned)) {
			return { port: assigned, alreadyRunning: true };
		}
		// Terminal exists but the port isn't reachable: the server is either still booting or it
		// crashed (the shell outlives the `serve` process). Re-issue serve in the existing terminal so
		// a crashed server recovers; if it's merely booting, the new `serve` errors on EADDRINUSE and
		// the original keeps the port. ponytail: re-run heuristic, add a liveness probe if it gets noisy.
		const existing = assigned ? this.devTerminals.get(key) : undefined;
		if (assigned && existing) {
			this.terminalService.setActiveInstance(existing);
			await this.terminalGroupService.showPanel(false);
			await existing.sendText(`npx --yes serve -n --cors -l ${assigned} .`, true);
			return { port: assigned, alreadyRunning: true };
		}

		const port = await this.findFreePort(5500, 5540);
		this.staticPorts.set(key, port);

		const instance = await this.terminalService.createTerminal({
			config: { name: `Design: ${name}`, cwd: rootUri },
		});
		this.devTerminals.set(key, instance);
		this._register(instance.onDisposed(() => this.devTerminals.delete(key)));

		this.terminalService.setActiveInstance(instance);
		await this.terminalGroupService.showPanel(false);
		// --cors sets `Access-Control-Allow-Origin: *` so the Design editor (vscode-file:// origin)
		// can fetch the HTML to inject the inspector/preload. Without it the cross-origin fetch
		// fails ("Failed to fetch") and the canvas is stuck view-only.
		await instance.sendText(`npx --yes serve -n --cors -l ${port} .`, true);

		return { port, alreadyRunning: false };
	}

	private async findFreePort(from: number, to: number): Promise<number> {
		const taken = new Set(this.staticPorts.values());
		for (let port = from; port <= to; port++) {
			if (!taken.has(port) && !(await this.isPortReachable(port))) {
				return port;
			}
		}
		throw new Error('No free port available for the static server');
	}

	/** Builds "npm|pnpm|yarn|bun run dev|start" from the app's package.json + lockfile. */
	private async resolveDevInvocation(rootUri: URI): Promise<string | null> {
		let scripts: Record<string, string> = {};
		try {
			const file = await this.fileService.readFile(URI.joinPath(rootUri, 'package.json'));
			scripts = JSON.parse(file.value.toString()).scripts ?? {};
		} catch {
			return null;
		}
		const scriptName = scripts['dev'] ? 'dev' : scripts['start'] ? 'start' : undefined;
		if (!scriptName) {
			return null;
		}
		const pm = await this.detectPackageManager(rootUri);
		return `${pm} run ${scriptName}`;
	}

	private async detectPackageManager(rootUri: URI): Promise<string> {
		const lockfiles: [string, string][] = [
			['pnpm-lock.yaml', 'pnpm'],
			['yarn.lock', 'yarn'],
			['bun.lockb', 'bun'],
			['bun.lock', 'bun'],
		];
		for (const [lockfile, pm] of lockfiles) {
			if (await this.fileService.exists(URI.joinPath(rootUri, lockfile))) {
				return pm;
			}
		}
		return 'npm';
	}

	private async isPortReachable(port: number): Promise<boolean> {
		try {
			// no-cors: resolves with an opaque response if anything is listening.
			await fetch(`http://localhost:${port}/`, { mode: 'no-cors', cache: 'no-store' });
			return true;
		} catch {
			return false;
		}
	}

	private async waitForPort(port: number, timeoutMs: number): Promise<{ ready: boolean }> {
		if (!port || isNaN(port)) {
			throw new Error('Invalid port');
		}
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await this.isPortReachable(port)) {
				return { ready: true };
			}
			await timeout(1000);
		}
		return { ready: false };
	}

	// --- File system (restricted to the workspace folders) ---

	private resolveWorkspacePath(rawPath: string): URI {
		const folders = this.workspaceContextService.getWorkspace().folders;
		let uri: URI | undefined;
		if (rawPath.startsWith('/') || /^[a-zA-Z]:[\\\/]/.test(rawPath)) {
			uri = URI.file(rawPath);
		} else if (folders.length > 0) {
			uri = URI.joinPath(folders[0].uri, rawPath.replace(/\\/g, '/'));
		}
		// Case-insensitive containment on Windows/macOS: a workspace folder URI may use a different
		// drive-letter/path casing (e.g. "C:\") than the path the iframe sends (e.g. "c:/"), and a
		// case-sensitive check would wrongly reject valid in-workspace paths and break write-back.
		if (!uri || !folders.some(folder => extUriBiasedIgnorePathCase.isEqualOrParent(uri!, folder.uri))) {
			throw new Error(`Path outside the workspace: ${rawPath}`);
		}
		return uri;
	}

	private async readFile(path: string, encoding: 'utf8' | 'base64' | 'auto') {
		const uri = this.resolveWorkspacePath(path);
		const file = await this.fileService.readFile(uri);
		// 'auto' decides per content: text comes back utf8, binaries come back base64.
		const finalEncoding = encoding === 'auto'
			? (this.looksBinary(file.value) ? 'base64' : 'utf8')
			: encoding;
		return {
			content: finalEncoding === 'base64' ? encodeBase64(file.value) : file.value.toString(),
			encoding: finalEncoding,
		};
	}

	private looksBinary(buffer: VSBuffer): boolean {
		// Scan the whole buffer for a NUL: a binary whose first NUL sits past byte 512 (common) was
		// being misread as text. The buffer is already in memory, so a linear scan is cheap vs the read.
		for (let i = 0; i < buffer.byteLength; i++) {
			if (buffer.buffer[i] === 0) {
				return true;
			}
		}
		return false;
	}

	private async writeFile(path: string, content: string, encoding: 'utf8' | 'base64') {
		const uri = this.resolveWorkspacePath(path);
		const buffer = encoding === 'base64' ? decodeBase64(content) : VSBuffer.fromString(content);
		this.beginWrite();
		try {
			this.recentSelfWrites.set(uri.fsPath, Date.now() + DesignEditorBridge.SELF_WRITE_ECHO_MS);
			await this.fileService.writeFile(uri, buffer);
			this.endWrite(true);
			return { ok: true };
		} catch (err) {
			this.endWrite(false);
			throw err;
		}
	}

	// --- Save status tracking ---

	private beginWrite(): void {
		this.pendingWrites++;
		this.resetSavedScheduler.cancel();
		this.setSaveState('saving');
	}

	private endWrite(ok: boolean): void {
		this.pendingWrites = Math.max(0, this.pendingWrites - 1);
		if (!ok) {
			this.setSaveState('error');
			return;
		}
		if (this.pendingWrites === 0) {
			this.setSaveState('saved');
			this.resetSavedScheduler.schedule();
		}
	}

	private setSaveState(state: DesignSaveState): void {
		if (this._saveState === state) {
			return;
		}
		this._saveState = state;
		this._onDidChangeSaveState.fire(state);
	}

	private async readDir(path: string) {
		const uri = this.resolveWorkspacePath(path);
		const stat = await this.fileService.resolve(uri);
		return (stat.children ?? []).map(child => ({ name: child.name, isDirectory: child.isDirectory }));
	}

	private async exists(path: string): Promise<boolean> {
		try {
			return await this.fileService.exists(this.resolveWorkspacePath(path));
		} catch {
			return false;
		}
	}

	private async statPath(path: string) {
		const uri = this.resolveWorkspacePath(path);
		const stat = await this.fileService.resolve(uri, { resolveMetadata: true });
		return {
			type: stat.isDirectory ? 'directory' : 'file',
			size: stat.size,
			mtime: stat.mtime,
			ctime: stat.ctime,
		};
	}

	private async rename(oldPath: string, newPath: string) {
		const source = this.resolveWorkspacePath(oldPath);
		const target = this.resolveWorkspacePath(newPath);
		await this.fileService.move(source, target, true);
		return { ok: true };
	}

	private async deletePath(path: string, recursive: boolean) {
		const uri = this.resolveWorkspacePath(path);
		await this.fileService.del(uri, { recursive, useTrash: false });
		return { ok: true };
	}

	private async mkdir(path: string) {
		const uri = this.resolveWorkspacePath(path);
		await this.fileService.createFolder(uri);
		return { ok: true };
	}

	private async copy(sourcePath: string, targetPath: string, overwrite: boolean) {
		const source = this.resolveWorkspacePath(sourcePath);
		const target = this.resolveWorkspacePath(targetPath);
		await this.fileService.copy(source, target, overwrite);
		return { ok: true };
	}

	// --- File watching (pushes `codecanvas:bridge-event` messages to the iframe) ---

	private readonly watchedRoots = new Set<string>();
	private watcherInstalled = false;

	private static readonly WATCH_IGNORED_SEGMENTS = new Set([
		'node_modules', '.git', '.next', 'dist', 'build', 'out', '.onlook', '.turbo', 'coverage',
	]);

	private async watch(rootPath: string): Promise<{ ok: boolean }> {
		const rootUri = this.resolveWorkspacePath(rootPath);
		this.watchedRoots.add(rootUri.toString());

		if (!this.watcherInstalled) {
			this.watcherInstalled = true;
			this._register(this.fileService.onDidFilesChange(e => this.forwardFileChanges(e.rawAdded, e.rawUpdated, e.rawDeleted)));
		}
		return { ok: true };
	}

	private forwardFileChanges(added: readonly URI[], updated: readonly URI[], deleted: readonly URI[]): void {
		const changes: { type: 'add' | 'change' | 'remove'; path: string; rootPath: string }[] = [];

		const now = Date.now();
		const isSelfWrite = (uri: URI): boolean => {
			const expiry = this.recentSelfWrites.get(uri.fsPath);
			if (expiry === undefined) {
				return false;
			}
			this.recentSelfWrites.delete(uri.fsPath); // one event per write
			return expiry >= now;
		};

		const collect = (uris: readonly URI[], type: 'add' | 'change' | 'remove') => {
			for (const uri of uris) {
				if (isSelfWrite(uri)) {
					continue;
				}
				for (const rootKey of this.watchedRoots) {
					const rootUri = URI.parse(rootKey);
					if (!extUriBiasedIgnorePathCase.isEqualOrParent(uri, rootUri)) {
						continue;
					}
					const relative = uri.path.substring(rootUri.path.length).replace(/^\//, '');
					const segments = relative.split('/');
					if (segments.some(seg => DesignEditorBridge.WATCH_IGNORED_SEGMENTS.has(seg))) {
						continue;
					}
					changes.push({ type, path: relative, rootPath: rootUri.fsPath });
				}
			}
		};

		collect(added, 'add');
		collect(updated, 'change');
		collect(deleted, 'remove');

		if (changes.length > 0) {
			this.iframe.contentWindow?.postMessage(
				{ type: 'codecanvas:bridge-event', event: 'fs-change', changes },
				'*'
			);
		}
	}

	// --- Workbench Chat (GitHub Copilot) ---

	/** Opens the workbench chat panel with context sent from the Design editor. */
	private async openWorkbenchChat(payload: OpenChatPayload) {
		const query = this.buildChatQuery(payload);
		await this.commandService.executeCommand('workbench.action.chat.open', query ? { query } : undefined);
		return { ok: true };
	}

	private buildChatQuery(payload: OpenChatPayload): string {
		const parts: string[] = [];

		if (payload.app) {
			parts.push(`[App: ${payload.app.framework} @ ${payload.app.rootPath}${payload.app.url ? ` | ${payload.app.url}` : ''}]`);
		}

		if (payload.selectedElement) {
			const el = payload.selectedElement;
			const elParts: string[] = [];
			if (el.tagName) { elParts.push(`tag=${el.tagName}`); }
			if (el.domId) { elParts.push(`id=${el.domId}`); }
			if (el.oid) { elParts.push(`oid=${el.oid}`); }
			if (el.text) { elParts.push(`text="${el.text}"`); }
			if (el.styles && Object.keys(el.styles).length > 0) {
				elParts.push(`styles={${Object.entries(el.styles).map(([k, v]) => `${k}:${v}`).join(', ')}}`);
			}
			if (elParts.length > 0) {
				parts.push(`[Element: ${elParts.join(' ')}]`);
			}
		}

		if (payload.source?.fileName) {
			const src = payload.source;
			parts.push(`[Source: ${src.fileName}${src.lineNumber ? `:${src.lineNumber}` : ''}${src.columnNumber ? `:${src.columnNumber}` : ''}]`);
		}

		if (payload.prompt) {
			if (parts.length > 0) {
				parts.push('');
			}
			parts.push(payload.prompt);
		}

		return parts.join('\n');
	}

	// --- Click-to-source (from the inspector bridge) ---

	private async openSourceFile(source: OpenSourcePayload): Promise<void> {
		try {
			if (!source || !source.fileName) {
				return;
			}
			// resolveWorkspacePath also rejects paths outside the workspace, so a
			// malicious preview page cannot make the editor open arbitrary files.
			const fileUri = this.resolveWorkspacePath(source.fileName);
			const line = Math.max(1, source.lineNumber ?? 1);
			const column = Math.max(1, source.columnNumber ?? 1);
			await this.editorService.openEditor({
				resource: fileUri,
				options: { selection: new Range(line, column, line, column), pinned: true },
			});
		} catch (err) {
			console.error('[DesignEditorBridge] Failed to open source file:', err);
		}
	}
}
