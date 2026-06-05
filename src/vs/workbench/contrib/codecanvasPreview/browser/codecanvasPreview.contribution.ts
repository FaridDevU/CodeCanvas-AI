/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/shinyText.css';
import { URI } from '../../../../base/common/uri.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { CodeCanvasTitleBarContribution } from './titleBarDeviceControl.js';
import { CodeCanvasStatusBarContribution } from './codecanvasStatusBar.js';
import { observableValue, ISettableObservable } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { FileChangeType, IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { RawContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IElementData } from '../../../../platform/browserView/common/browserView.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { generateDiff, createBackup, IDomDelta } from '../common/EdicionVisual/diffEngine.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { CodeCanvasSnapshotsView } from './snapshotsView.js';

const PREVIEW_ID = 'codecanvas.preview';
const STATUS_ID = 'status.codecanvasPreview';

const codecanvasPreviewIcon = registerIcon('codecanvas-preview-icon', Codicon.eye, localize('codecanvasPreviewIcon', 'View icon of the CodeCanvas Preview.'));

const currentElementData: ISettableObservable<IElementData | null> = observableValue('codecanvas.currentElement', null);

export const codecanvasIsWebProject = new RawContextKey<boolean>('codecanvasIsWebProject', false);
export const webProjectUrl: ISettableObservable<string | undefined> = observableValue('codecanvas.webProjectUrl', undefined);

async function detectWebProject(root: URI, fileService: IFileService): Promise<{ isWeb: boolean; url?: string }> {
	// Dev-server project (Vite/Next/etc.).
	const packageJson = URI.joinPath(root, 'package.json');
	if (await fileService.exists(packageJson)) {
		const { hasScript, devScriptValue } = await hasNpmDevScript(fileService, packageJson);
		if (hasScript) {
			const configPort = await detectConfigPort(fileService, root);
			const guessedUrls = getDefaultUrlsFromPackageScripts(devScriptValue);
			const url = configPort ? `http://localhost:${configPort}` : (await tryConnectToUrls(guessedUrls) ?? guessedUrls[0]);
			return { isWeb: true, url };
		}
	}

	// Static site: any .html anywhere counts (matches what the preview can open).
	const pages = await listPreviewablePages(root, fileService);
	if (pages.length > 0) {
		return { isWeb: true, url: pages[0].toString() };
	}

	return { isWeb: false };
}

const PAGE_IGNORE_DIRS = new Set(['node_modules', 'out', 'dist', 'build', '.git', '.next', '.cache']);

// Collect every previewable .html page in the workspace (root index.html first), skipping
// build output and backup files.
async function listPreviewablePages(root: URI, fileService: IFileService): Promise<URI[]> {
	const pages: URI[] = [];
	const queue: URI[] = [root];
	while (queue.length > 0) {
		const current = queue.shift()!;
		let stat;
		try {
			stat = await fileService.resolve(current);
		} catch {
			continue;
		}
		for (const child of stat.children ?? []) {
			if (child.isDirectory) {
				if (!PAGE_IGNORE_DIRS.has(child.name)) {
					queue.push(child.resource);
				}
			} else if (child.name.endsWith('.html') && !/_backup/i.test(child.name)) {
				pages.push(child.resource);
			}
		}
	}
	// Root-level index.html first, then the rest alphabetically by path.
	pages.sort((a, b) => {
		const aRoot = a.path === URI.joinPath(root, 'index.html').path ? 0 : 1;
		const bRoot = b.path === URI.joinPath(root, 'index.html').path ? 0 : 1;
		return aRoot - bRoot || a.path.localeCompare(b.path);
	});
	return pages;
}

interface ICodeCanvasPreviewServices {
	readonly browserViewWorkbenchService: IBrowserViewWorkbenchService;
	readonly contextService: IWorkspaceContextService;
	readonly editorService: IEditorService;
	readonly fileService: IFileService;
	readonly notificationService: INotificationService;
	readonly quickInputService: IQuickInputService;
	readonly terminalService: ITerminalService;
	readonly storageService: IStorageService;
}

function getPreviewServices(accessor: ServicesAccessor): ICodeCanvasPreviewServices {
	return {
		browserViewWorkbenchService: accessor.get(IBrowserViewWorkbenchService),
		contextService: accessor.get(IWorkspaceContextService),
		editorService: accessor.get(IEditorService),
		fileService: accessor.get(IFileService),
		notificationService: accessor.get(INotificationService),
		quickInputService: accessor.get(IQuickInputService),
		terminalService: accessor.get(ITerminalService),
		storageService: accessor.get(IStorageService)
	};
}

function getWorkspaceRoot(contextService: IWorkspaceContextService): URI | undefined {
	if (contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
		return undefined;
	}
	return contextService.getWorkspace().folders[0]?.uri;
}

function normalizePreviewUrl(value: string): string {
	const trimmed = value.trim();
	if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
		return trimmed;
	}
	if (/^\d+$/.test(trimmed)) {
		return `http://localhost:${trimmed}`;
	}
	return `http://${trimmed}`;
}

function getDefaultUrlsFromPackageScripts(devScriptValue: string): string[] {
	const urls: string[] = [];

	if (devScriptValue.includes('next dev') || devScriptValue.includes('next start')) {
		urls.push('http://localhost:3000');
	}

	if (devScriptValue.includes('vite')) {
		urls.push('http://localhost:5173');
	}

	if (devScriptValue.includes('astro dev')) {
		urls.push('http://localhost:4321');
	}

	if (devScriptValue.includes('ng serve')) {
		urls.push('http://localhost:4200');
	}

	if (devScriptValue.includes('nuxt dev')) {
		urls.push('http://localhost:3000');
	}

	if (devScriptValue.includes('remix dev') || devScriptValue.includes('remix vite:dev')) {
		urls.push('http://localhost:3000');
	}

	if (devScriptValue.includes('turbo dev') || devScriptValue.includes('turbo start')) {
		urls.push('http://localhost:3000');
	}

	if (devScriptValue.includes('wmr') || devScriptValue.includes('preview run')) {
		urls.push('http://localhost:8080');
	}

	if (urls.length === 0) {
		urls.push('http://localhost:5173', 'http://localhost:3000', 'http://localhost:4200');
	}

	return urls;
}

async function detectConfigPort(
	fileService: IFileService,
	root: URI,
): Promise<number | undefined> {
	const configs = [
		{ file: 'vite.config.ts', patterns: [/server\s*:\s*\{[^}]*port\s*:\s*(\d+)/s, /port\s*:\s*(\d+)/] },
		{ file: 'vite.config.js', patterns: [/server\s*:\s*\{[^}]*port\s*:\s*(\d+)/s, /port\s*:\s*(\d+)/] },
		{ file: 'vite.config.mjs', patterns: [/server\s*:\s*\{[^}]*port\s*:\s*(\d+)/s, /port\s*:\s*(\d+)/] },
		{ file: 'next.config.ts', patterns: [/port\s*:\s*(\d+)/] },
		{ file: 'next.config.mjs', patterns: [/port\s*:\s*(\d+)/] },
		{ file: 'next.config.js', patterns: [/port\s*:\s*(\d+)/] },
		{ file: 'astro.config.mjs', patterns: [/server\s*:\s*\{[^}]*port\s*:\s*(\d+)/s, /port\s*:\s*(\d+)/] },
	];

	for (const { file, patterns } of configs) {
		const configUri = URI.joinPath(root, file);
		try {
			if (await fileService.exists(configUri)) {
				const content = await fileService.readFile(configUri);
				const text = content.value.toString();
				for (const pattern of patterns) {
					const match = text.match(pattern);
					if (match && match[1]) {
						return parseInt(match[1], 10);
					}
				}
			}
		} catch {
			continue;
		}
	}

	return undefined;
}

async function openBrowserPreview(services: ICodeCanvasPreviewServices, url: string, title = localize('preview.title', "CodeCanvas Preview")): Promise<void> {
	const input = services.browserViewWorkbenchService.getOrCreateLazy(PREVIEW_ID, { url, title });
	input.navigate(url);
	// Open in a dedicated side column so the preview lives next to the code, not as a tab
	// in the code group. There is a single preview input, so it is reused in that column.
	await services.editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
}

async function tryConnectToUrls(urls: string[]): Promise<string | null> {
	for (const url of urls) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 3000);
			await fetch(url, { method: 'HEAD', signal: controller.signal });
			clearTimeout(timeout);
			return url;
		} catch {
			continue;
		}
	}
	return null;
}

async function hasNpmDevScript(fileService: IFileService, packageJson: URI): Promise<{ hasScript: boolean; devScriptValue: string }> {
	try {
		const content = await fileService.readFile(packageJson);
		const manifest = JSON.parse(content.value.toString());
		const devScript = manifest?.scripts?.dev;
		if (typeof devScript === 'string') {
			return { hasScript: true, devScriptValue: devScript };
		}
		return { hasScript: false, devScriptValue: '' };
	} catch {
		return { hasScript: false, devScriptValue: '' };
	}
}

async function openLocalhostPreview(services: ICodeCanvasPreviewServices): Promise<void> {
	const value = await services.quickInputService.input({
		title: localize('localhostPreview.title', "Open CodeCanvas Localhost Preview"),
		prompt: localize('localhostPreview.prompt', "Enter a localhost port or full URL"),
		value: 'http://localhost:5173'
	});

	if (!value) {
		return;
	}

	await openBrowserPreview(services, normalizePreviewUrl(value), localize('localhostPreview.editorTitle', "CodeCanvas Localhost Preview"));
}

const PREVIEW_PAGE_KEY = 'codecanvas.preview.lastPage';

// Resolve which HTML page to preview: 1 page → that one; remembered choice → reuse it;
// otherwise ask. forceChoose skips the remembered value.
async function pickPreviewPage(services: ICodeCanvasPreviewServices, root: URI, pages: URI[], _forceChoose: boolean): Promise<URI | undefined> {
	if (pages.length === 1) {
		return pages[0];
	}
	const rel = (u: URI) => u.path.slice(root.path.length).replace(/^\/+/, '');
	type PageItem = IQuickPickItem & { uri: URI };
	const items: PageItem[] = pages.map(p => ({ label: rel(p), uri: p }));

	// Pre-select the last previewed page, but always let the user choose again.
	const last = services.storageService.get(PREVIEW_PAGE_KEY, StorageScope.WORKSPACE);
	const activeItem = last ? items.find(i => i.uri.toString() === last) : undefined;

	const picked = await services.quickInputService.pick<PageItem>(items, {
		title: localize('preview.pickPage.title', "Choose a page to preview"),
		placeHolder: localize('preview.pickPage.placeholder', "Select which HTML page to open"),
		activeItem
	});
	if (!picked) {
		return undefined;
	}
	services.storageService.store(PREVIEW_PAGE_KEY, picked.uri.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	return picked.uri;
}

async function openWorkspacePreview(services: ICodeCanvasPreviewServices, forceChoosePage = false): Promise<void> {
	const root = getWorkspaceRoot(services.contextService);

	if (!root) {
		await openLocalhostPreview(services);
		return;
	}

	const packageJson = URI.joinPath(root, 'package.json');
	const pkgExists = await services.fileService.exists(packageJson);
	const { hasScript, devScriptValue } = pkgExists
		? await hasNpmDevScript(services.fileService, packageJson)
		: { hasScript: false, devScriptValue: '' };

	// Static site (no dev script): let the user pick which .html page to preview.
	if (!hasScript) {
		const pages = await listPreviewablePages(root, services.fileService);
		if (pages.length > 0) {
			const page = await pickPreviewPage(services, root, pages, forceChoosePage);
			if (page) {
				await openBrowserPreview(services, page.toString(), localize('htmlPreview.editorTitle', "CodeCanvas HTML Preview"));
			}
			return;
		}
		await openLocalhostPreview(services);
		return;
	}

	// Project has a dev script: offer to start the dev server or use a running one.
	{
		const picks: IQuickPickItem[] = [];

		if (hasScript) {
			const configPort = await detectConfigPort(services.fileService, root);
			const guessedUrls = getDefaultUrlsFromPackageScripts(devScriptValue);
			let portLabel = '';

			if (configPort) {
				portLabel = ` (port ${configPort})`;
			} else {
				const connected = await tryConnectToUrls(guessedUrls);
				if (connected) {
					portLabel = ` (detected running on ${new URL(connected).port})`;
				}
			}

			picks.push({
				id: 'start-dev-server',
				label: localize('preview.pick.startDevServer', "Start npm run dev and open preview"),
				description: configPort ? `http://localhost:${configPort}` : guessedUrls.join(', ') + portLabel
			});
		}

		picks.push({
			id: 'open-localhost',
			label: localize('preview.pick.openLocalhost', "Open localhost preview"),
			description: localize('preview.pick.openLocalhostDescription', "Use an already running dev server")
		});

		const picked = await services.quickInputService.pick(picks, {
			title: localize('preview.pick.title', "CodeCanvas Preview"),
			placeHolder: localize('preview.pick.placeholder', "Choose how to open this project")
		});

		if (!picked) {
			return;
		}

		if (picked.id === 'start-dev-server') {
			const configPort = hasScript ? await detectConfigPort(services.fileService, root) : undefined;
			const guessedUrls = getDefaultUrlsFromPackageScripts(devScriptValue || '');
			let previewUrl: string;

			if (configPort) {
				previewUrl = `http://localhost:${configPort}`;
			} else {
				const connected = await tryConnectToUrls(guessedUrls);
				if (connected) {
					previewUrl = connected;
				} else {
					previewUrl = guessedUrls[0] || 'http://localhost:5173';
				}
			}

			const instance = await services.terminalService.createTerminal({
				cwd: root,
				location: TerminalLocation.Panel,
				config: {
					name: localize('preview.terminalName', "CodeCanvas Preview")
				}
			});
			await services.terminalService.revealTerminal(instance);
			await instance.runCommand('npm run dev', true, 'codecanvas.preview.startDevServer');

			services.notificationService.info(localize('preview.waiting', "Starting dev server, waiting for {0}...", previewUrl));

			setTimeout(async () => {
				try {
					const controller = new AbortController();
					const timeout = setTimeout(() => controller.abort(), 15000);
					const response = await fetch(previewUrl, { signal: controller.signal });
					clearTimeout(timeout);

					if (response.ok || response.status < 500) {
						await openBrowserPreview(services, previewUrl, localize('vitePreview.editorTitle', "CodeCanvas Dev Server Preview"));
						services.notificationService.info(localize('preview.connected', "Connected to dev server at {0}", previewUrl));
					}
				} catch {
					services.notificationService.warn(localize('preview.notReady', "Dev server not ready yet. Use CodeCanvas: Open Localhost Preview to connect manually."));
				}
			}, 3000);

			return;
		}

		if (picked.id === 'open-localhost') {
			await openLocalhostPreview(services);
			return;
		}
	}

	await openLocalhostPreview(services);
}

// Preview status bar contribution
class CodeCanvasPreviewStatusContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codecanvasPreviewStatus';

	private statusEntry: IStatusbarEntryAccessor | undefined;
	private readonly disposables = new DisposableStore();
	private readonly watcherDisposables = new DisposableStore();
	private reloadTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
	) {
		this.registerListeners();
	}

	private registerListeners(): void {
		this.disposables.add(this.browserViewWorkbenchService.onDidChangeBrowserViews(() => {
			this.updateStatus();
		}));
		this.updateStatus();
	}

	private updateStatus(): void {
		const input = this.browserViewWorkbenchService.getKnownBrowserViews().get(PREVIEW_ID);

		if (!input) {
			if (this.statusEntry) {
				this.statusEntry.dispose();
				this.statusEntry = undefined;
			}
			this.stopFileWatcher();
			return;
		}

		const model = input.model;
		if (model) {
			const loading = model.loading;
			const error = model.error;
			const url = model.url;

			if (!this.statusEntry) {
				this.statusEntry = this.statusbarService.addEntry(
					this.buildStatusProps(loading, error, url),
					STATUS_ID,
					StatusbarAlignment.LEFT,
					100
				);
			} else {
				this.statusEntry.update(this.buildStatusProps(loading, error, url));
			}

			if (!loading && !error) {
				this.startFileWatcher();
			}
		}
	}

	private buildStatusProps(loading: boolean, error: { errorDescription?: string } | undefined, url: string) {
		let text = '';
		let tooltip = '';
		let kind: 'standard' | 'warning' | 'error' = 'standard';

		if (error) {
			text = `$(error) ${localize('status.error', "Preview Error")}`;
			tooltip = error.errorDescription || localize('status.errorTooltip', "Preview failed to load");
			kind = 'error';
		} else if (loading) {
			text = `$(sync~spin) ${localize('status.loading', "Preview Loading...")}`;
			tooltip = localize('status.loadingTooltip', "Preview is loading");
			kind = 'standard';
		} else {
			text = `$(eye) ${localize('status.connected', "Preview")}`;
			tooltip = url;
			kind = 'standard';
		}

		return {
			name: localize('status.name', "CodeCanvas Preview"),
			text,
			tooltip,
			kind,
			ariaLabel: text,
			command: 'codecanvas.preview.reload'
		};
	}

	private startFileWatcher(): void {
		this.stopFileWatcher();
		const root = getWorkspaceRoot(this.contextService);
		if (!root) { return; }

		this.watcherDisposables.add(this.fileService.onDidFilesChange(e => {
			const workspaceRoot = getWorkspaceRoot(this.contextService);
			if (!workspaceRoot) { return; }

			if (e.contains(workspaceRoot, FileChangeType.ADDED, FileChangeType.UPDATED, FileChangeType.DELETED)) {
				if (this.reloadTimeout) {
					clearTimeout(this.reloadTimeout);
				}
				this.reloadTimeout = setTimeout(() => {
					this.reloadPreview();
				}, 500);
			}
		}));
	}

	private stopFileWatcher(): void {
		this.watcherDisposables.clear();
		if (this.reloadTimeout) {
			clearTimeout(this.reloadTimeout);
			this.reloadTimeout = undefined;
		}
	}

	private reloadPreview(): void {
		const input = this.browserViewWorkbenchService.getKnownBrowserViews().get(PREVIEW_ID);
		if (!input) { return; }

		const model = input.model ?? input.resolve();
		if (model instanceof Promise) {
			model.then(m => m.reload(true)).catch(() => { });
		} else {
			model.reload(true);
		}
	}

	dispose(): void {
		this.disposables.dispose();
		this.watcherDisposables.dispose();
		this.statusEntry?.dispose();
		if (this.reloadTimeout) {
			clearTimeout(this.reloadTimeout);
		}
	}
}

// Snapshots view container (Panel / bottom)
const snapshotsContainer = Registry.as<IViewContainersRegistry>(
	ViewContainerExtensions.ViewContainersRegistry
).registerViewContainer({
	id: 'codecanvas.snapshotsContainer',
	title: localize2('snapshots', "Snapshots"),
	icon: codecanvasPreviewIcon,
	order: 10,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['codecanvas.snapshotsContainer', { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'codecanvas.snapshotsContainer',
	hideIfEmpty: false,
}, ViewContainerLocation.Panel);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: CodeCanvasSnapshotsView.ID,
	name: CodeCanvasSnapshotsView.NAME,
	ctorDescriptor: new SyncDescriptor(CodeCanvasSnapshotsView),
	containerIcon: codecanvasPreviewIcon,
	canToggleVisibility: true,
	canMoveView: true,
	order: 1,
}], snapshotsContainer);

// Actions
registerAction2(class OpenCodeCanvasPreviewAction extends Action2 {
	constructor() {
		super({
			id: 'codecanvas.preview.open',
			title: localize2('openPreview', "CodeCanvas: Open Preview"),
			category: Categories.View,
			icon: Codicon.eye,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				// Visible button at the top-right of the editor when the project is web.
				{ id: MenuId.EditorTitle, group: 'navigation', order: -100, when: codecanvasIsWebProject }
			]
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openWorkspacePreview(getPreviewServices(accessor));
	}
});

registerAction2(class ChoosePreviewPageAction extends Action2 {
	constructor() {
		super({
			id: 'codecanvas.preview.choosePage',
			title: localize2('choosePreviewPage', "CodeCanvas: Choose Preview Page"),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openWorkspacePreview(getPreviewServices(accessor), true);
	}
});

registerAction2(class OpenCodeCanvasLocalhostPreviewAction extends Action2 {
	constructor() {
		super({
			id: 'codecanvas.preview.openLocalhost',
			title: localize2('openLocalhostPreview', "CodeCanvas: Open Localhost Preview"),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openLocalhostPreview(getPreviewServices(accessor));
	}
});

registerAction2(class ReloadCodeCanvasPreviewAction extends Action2 {
	constructor() {
		super({
			id: 'codecanvas.preview.reload',
			title: localize2('reloadPreview', "CodeCanvas: Reload Preview"),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
		const input = browserViewWorkbenchService.getKnownBrowserViews().get(PREVIEW_ID);
		if (!input) {
			return;
		}
		const model = input.model ?? await input.resolve();
		await model.reload(true);
	}
});

registerAction2(class InspectElementAction extends Action2 {
	constructor() {
		super({
			id: 'codecanvas.preview.inspectElement',
			title: localize2('inspectElement', "CodeCanvas: Inspect Element"),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
		const notificationService = accessor.get(INotificationService);
		const input = browserViewWorkbenchService.getKnownBrowserViews().get(PREVIEW_ID);
		if (!input) {
			notificationService.info(localize('inspector.noPreview', "Open a preview first (CodeCanvas: Open Preview)"));
			return;
		}

		const model = input.model ?? await input.resolve();
		await model.toggleElementSelection(true);
		notificationService.info(localize('inspector.active', "Click on any element in the preview to inspect it. Press Escape to stop."));

		const listener = model.onDidSelectElement((data: IElementData) => {
			currentElementData.set(data, undefined, undefined);
		});

		const activeListener = model.onDidChangeElementSelectionActive((active: boolean) => {
			if (!active) {
				listener.dispose();
				activeListener.dispose();
				currentElementData.set(null, undefined, undefined);
			}
		});
	}
});

registerAction2(class StopInspectAction extends Action2 {
	constructor() {
		super({
			id: 'codecanvas.preview.stopInspect',
			title: localize2('stopInspect', "CodeCanvas: Stop Inspect"),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
		const input = browserViewWorkbenchService.getKnownBrowserViews().get(PREVIEW_ID);
		if (!input) { return; }

		const model = input.model ?? await input.resolve();
		await model.toggleElementSelection(false);
		currentElementData.set(null, undefined, undefined);
	}
});

// Edicion visual + diffs
let pendingDelta: IDomDelta | null = null;

function getElementSelector(elementData: IElementData): string {
	const parser = new DOMParser();
	const doc = parser.parseFromString(elementData.outerHTML, 'text/html');
	const el = doc.body.firstElementChild;
	const tagName = el?.tagName?.toLowerCase() ?? 'element';
	const classes = elementData.attributes?.class ?? '';
	const firstClass = classes.split(/\s+/).filter(Boolean)[0];
	return firstClass ? `.${firstClass}` : tagName;
}

function promptDelta(
	delta: IDomDelta,
	fileService: IFileService,
	notificationService: INotificationService,
	contextService: IWorkspaceContextService,
	onReject?: () => void
): void {
	pendingDelta = delta;

	notificationService.prompt(
		Severity.Info,
		localize('editCSS.diffTitle', "CSS Changes Proposed") + '\n\n' +
		delta.changes.map(c => `${c.property}: ${c.oldValue} -> ${c.newValue}`).join('\n'),
		[
			{
				label: localize('editCSS.accept', "Accept"),
				run: async () => { await acceptDelta(fileService, notificationService, contextService); }
			},
			{
				label: localize('editCSS.reject', "Reject"),
				run: () => {
					onReject?.();
					notificationService.info(localize('editCSS.rejected', "Changes rejected."));
					pendingDelta = null;
				}
			},
			{
				label: localize('editCSS.showDiff', "Show Diff"),
				run: () => {
					notificationService.info(delta.diff);
				}
			}
		]
	);
}

async function findSourceFile(elementData: IElementData, contextService: IWorkspaceContextService, fileService: IFileService): Promise<string | null> {
	const root = getWorkspaceRoot(contextService);
	if (!root || !elementData.ancestors || elementData.ancestors.length === 0) {
		return null;
	}

	const tag = elementData.ancestors[elementData.ancestors.length - 1]?.tagName?.toLowerCase();
	if (tag === 'head' || elementData.url?.startsWith('http')) {
		return null;
	}

	const candidates: URI[] = [];
	try {
		if (elementData.url?.startsWith('file:')) {
			const pageUri = URI.parse(elementData.url);
			const pageDir = URI.joinPath(pageUri, '..');
			candidates.push(URI.joinPath(pageDir, 'styles.css'));
		}
	} catch {
		// Ignore invalid page URLs and continue with workspace candidates.
	}

	candidates.push(
		URI.joinPath(root, 'styles.css'),
		URI.joinPath(root, 'style.css'),
		URI.joinPath(root, 'src', 'styles.css'),
		URI.joinPath(root, 'src', 'style.css')
	);

	for (const candidate of candidates) {
		if (await fileService.exists(candidate)) {
			return candidate.fsPath;
		}
	}

	return (await findFirstCssFile(root, fileService))?.fsPath ?? null;
}

async function findFirstCssFile(root: URI, fileService: IFileService): Promise<URI | null> {
	const ignored = new Set(['node_modules', 'out', 'dist', 'build', '.git']);
	const queue: URI[] = [root];
	while (queue.length > 0) {
		const current = queue.shift()!;
		let stat;
		try {
			stat = await fileService.resolve(current);
		} catch {
			continue;
		}
		for (const child of stat.children ?? []) {
			if (child.name.endsWith('.css') && child.isFile) {
				return child.resource;
			}
			if (child.isDirectory && !ignored.has(child.name)) {
				queue.push(child.resource);
			}
		}
	}
	return null;
}

registerAction2(class MoveResizeElementAction extends Action2 {
	constructor() {
		super({
			id: 'codecanvas.preview.moveResizeElement',
			title: localize2('moveResizeElement', "CodeCanvas: Move/Resize Selected Element"),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const elementData = currentElementData.get();
		const notificationService = accessor.get(INotificationService);
		if (!elementData?.elementId) {
			notificationService.info(localize('visualEdit.noElement', "Inspect an element first (CodeCanvas: Inspect Element)"));
			return;
		}

		const currentStyles = elementData.computedStyles ?? {};
		const position = (currentStyles['position'] ?? '').toLowerCase();
		if (position !== 'absolute' && position !== 'fixed') {
			notificationService.info(localize('visualEdit.absoluteOnly',
				"Visual editing currently supports only elements with position: absolute or fixed (this one is '{0}').",
				position || 'static'));
			return;
		}

		const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
		const fileService = accessor.get(IFileService);
		const contextService = accessor.get(IWorkspaceContextService);
		const input = browserViewWorkbenchService.getKnownBrowserViews().get(PREVIEW_ID);
		if (!input) {
			notificationService.info(localize('visualEdit.noPreview', "Open a preview first (CodeCanvas: Open Preview)"));
			return;
		}

		const model = input.model ?? await input.resolve();
		const listener = model.onDidCommitVisualEdit(async visualDelta => {
			listener.dispose();
			if (visualDelta.elementId !== elementData.elementId) {
				return;
			}
			const filePath = await findSourceFile(elementData, contextService, fileService);
			if (!filePath) {
				notificationService.warn(localize('visualEdit.noCssFile', "No CSS file was found in the workspace for this element."));
				return;
			}
			const delta = await generateDiff({
				filePath,
				selector: getElementSelector(elementData),
				originalStyles: visualDelta.originalStyles,
				modifiedStyles: visualDelta.modifiedStyles
			}, fileService);
			promptDelta(delta, fileService, notificationService, contextService, () => {
				void model.reload(true);
			});
		});
		await model.toggleVisualEdit(elementData.elementId, true);
		notificationService.info(localize('visualEdit.active', "Drag the element to move it, or drag the corner handle to resize it. Press Escape to cancel."));
	}
});

registerAction2(class EditCSSAction extends Action2 {
	constructor() {
		super({
			id: 'codecanvas.preview.editCSS',
			title: localize2('editCSS', "CodeCanvas: Edit CSS of Selected Element"),
			category: Categories.View,
			f1: true,
			menu: { id: MenuId.CommandPalette }
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const elementData = currentElementData.get();
		if (!elementData) {
			accessor.get(INotificationService).info(
				localize('editCSS.noElement', "Inspect an element first (CodeCanvas: Inspect Element)"));
			return;
		}

		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const fileService = accessor.get(IFileService);
		const contextService = accessor.get(IWorkspaceContextService);

		const selector = getElementSelector(elementData);

		const stylesToEdit: Record<string, string> = {};
		const currentStyles = elementData.computedStyles ?? {};

		// Phase 3 scope: start with positioned elements only (absolute/fixed),
		// where position/size deltas map cleanly to CSS.
		const position = (currentStyles['position'] ?? '').toLowerCase();
		if (position !== 'absolute' && position !== 'fixed') {
			notificationService.info(localize('editCSS.absoluteOnly',
				"Visual editing currently supports only elements with position: absolute or fixed (this one is '{0}').",
				position || 'static'));
			return;
		}

		const editableProps = ['position', 'top', 'left', 'right', 'bottom', 'width', 'height',
			'margin', 'padding', 'display', 'background-color', 'color', 'font-size', 'opacity', 'z-index'];

		for (const prop of editableProps) {
			if (currentStyles[prop]) {
				stylesToEdit[prop] = currentStyles[prop];
			}
		}

		const styleLines = Object.entries(stylesToEdit)
			.map(([k, v]) => `${k}: ${v};`)
			.join('\n');

		const newStyles = await quickInputService.input({
			title: localize('editCSS.title', "Edit CSS for {0}", selector),
			prompt: localize('editCSS.prompt', "Edit CSS properties (one per line, format: property: value;)"),
			value: styleLines
		});

		if (!newStyles) { return; }

		const parsedStyles: Record<string, string> = {};
		for (const line of newStyles.split('\n')) {
			const match = line.trim().match(/^([a-z-]+)\s*:\s*(.+?);?\s*$/);
			if (match) {
				parsedStyles[match[1].trim()] = match[2].trim().replace(/;$/, '');
			}
		}

		if (Object.keys(parsedStyles).length === 0) {
			notificationService.warn(localize('editCSS.invalid', "No valid CSS properties found."));
			return;
		}

		const originalStyles: Record<string, string> = {};
		for (const prop of editableProps) {
			if (currentStyles[prop]) {
				originalStyles[prop] = currentStyles[prop];
			}
		}

		const filePath = await findSourceFile(elementData, contextService, fileService);
		if (!filePath) {
			notificationService.warn(localize('editCSS.noCssFile', "No CSS file was found in the workspace for this element."));
			return;
		}

		const delta = await generateDiff({
			filePath,
			selector,
			originalStyles,
			modifiedStyles: parsedStyles
		}, fileService);

		promptDelta(delta, fileService, notificationService, contextService);
	}
});

async function acceptDelta(
	fileService: IFileService,
	notificationService: INotificationService,
	contextService: IWorkspaceContextService
): Promise<void> {
	if (!pendingDelta) { return; }
	const delta = pendingDelta;
	pendingDelta = null;

	const fileUri = URI.file(delta.filePath);
	try {
		const backupUri = await createBackup(fileUri, fileService);
		notificationService.info(localize('editCSS.backup', "Backup created: {0}", backupUri.fsPath));

		await fileService.writeFile(fileUri, VSBuffer.fromString(delta.modifiedContent));
		notificationService.info(localize('editCSS.saved', "Changes applied to {0}.", delta.filePath));
	} catch (e) {
		notificationService.error(localize('editCSS.error', "Failed to write: {0}", (e as Error).message));
	}
}

class CodeCanvasWebProjectContribution extends DisposableStore implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codecanvasWebProject';
	private redetectTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IFileService fileService: IFileService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const ctx = codecanvasIsWebProject.bindTo(contextKeyService);

		const update = async () => {
			try {
				const root = getWorkspaceRoot(contextService);
				if (!root) {
					ctx.set(false);
					webProjectUrl.set(undefined, undefined);
					return;
				}
				const result = await detectWebProject(root, fileService);
				ctx.set(result.isWeb);
				webProjectUrl.set(result.url, undefined);
			} catch {
				ctx.set(false);
				webProjectUrl.set(undefined, undefined);
			}
		};

		update();
		this.add(contextService.onDidChangeWorkbenchState(() => update()));
		this.add(contextService.onDidChangeWorkspaceFolders(() => update()));

		// Re-detect when the project gains a manifest or an HTML page after being opened.
		this.add(fileService.onDidFilesChange(e => {
			const root = getWorkspaceRoot(contextService);
			if (!root) { return; }
			const manifestChanged = e.affects(URI.joinPath(root, 'package.json'));
			const htmlChanged = e.rawAdded.concat(e.rawDeleted).some(u => u.path.endsWith('.html'));
			if (!manifestChanged && !htmlChanged) { return; }
			if (this.redetectTimeout) { clearTimeout(this.redetectTimeout); }
			this.redetectTimeout = setTimeout(() => update(), 500);
		}));
	}
}

class CodeCanvasPreviewButtonContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codecanvasPreviewButton';
	private statusEntry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		const update = () => {
			const isWeb = contextKeyService.getContextKeyValue<boolean>('codecanvasIsWebProject');
			if (isWeb) {
				if (!this.statusEntry) {
					this.statusEntry = statusbarService.addEntry({
						name: localize('cc.verPreview.name', "Ver Preview"),
						text: `$(eye) ${localize('cc.verPreview', "Ver Preview")}`,
						ariaLabel: localize('cc.verPreview', "Ver Preview"),
						tooltip: localize('cc.verPreview.tooltip', "Abrir vista previa del proyecto"),
						command: 'codecanvas.preview.open',
					}, 'status.codecanvasPreviewButton', StatusbarAlignment.LEFT, 100);
				}
			} else {
				this.statusEntry?.dispose();
				this.statusEntry = undefined;
			}
		};

		update();
		contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set(['codecanvasIsWebProject']))) {
				update();
			}
		});
	}
}

registerWorkbenchContribution2(CodeCanvasPreviewStatusContribution.ID, CodeCanvasPreviewStatusContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(CodeCanvasTitleBarContribution.ID, CodeCanvasTitleBarContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(CodeCanvasStatusBarContribution.ID, CodeCanvasStatusBarContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(CodeCanvasWebProjectContribution.ID, CodeCanvasWebProjectContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(CodeCanvasPreviewButtonContribution.ID, CodeCanvasPreviewButtonContribution, WorkbenchPhase.AfterRestored);
