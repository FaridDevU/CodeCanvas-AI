/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeCanvas AI contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { FileChangeType } from '../../../../platform/files/common/files.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { IElementData } from '../../../../platform/browserView/common/browserView.js';

const PREVIEW_ID = 'codecanvas.preview';
const PREVIEW_VIEW_ID = 'codecanvasPreview';
const STATUS_ID = 'status.codecanvasPreview';

const codecanvasPreviewIcon = registerIcon('codecanvas-preview-icon', Codicon.eye, localize('codecanvasPreviewIcon', 'View icon of the CodeCanvas Preview.'));

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
		{ file: 'next.config.ts', patterns: [/port\s*:\s*(\d+)/]},
		{ file: 'next.config.mjs', patterns: [/port\s*:\s*(\d+)/]},
		{ file: 'next.config.js', patterns: [/port\s*:\s*(\d+)/]},
		{ file: 'astro.config.mjs', patterns: [/server\s*:\s*\{[^}]*port\s*:\s*(\d+)/s, /port\s*:\s*(\d+)/]},
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

async function openBrowserPreview(accessor: ServicesAccessor, url: string, title = localize('preview.title', "CodeCanvas Preview")): Promise<void> {
	const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
	const editorService = accessor.get(IEditorService);
	const input = browserViewWorkbenchService.getOrCreateLazy(PREVIEW_ID, { url, title });
	input.navigate(url);
	await editorService.openEditor(input, { pinned: true });
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

async function openLocalhostPreview(accessor: ServicesAccessor): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const value = await quickInputService.input({
		title: localize('localhostPreview.title', "Open CodeCanvas Localhost Preview"),
		prompt: localize('localhostPreview.prompt', "Enter a localhost port or full URL"),
		value: 'http://localhost:5173'
	});

	if (!value) {
		return;
	}

	await openBrowserPreview(accessor, normalizePreviewUrl(value), localize('localhostPreview.editorTitle', "CodeCanvas Localhost Preview"));
}

async function openWorkspacePreview(accessor: ServicesAccessor): Promise<void> {
	const contextService = accessor.get(IWorkspaceContextService);
	const fileService = accessor.get(IFileService);
	const quickInputService = accessor.get(IQuickInputService);
	const root = getWorkspaceRoot(contextService);

	if (!root) {
		await openLocalhostPreview(accessor);
		return;
	}

	const indexHtml = URI.joinPath(root, 'index.html');
	if (await fileService.exists(indexHtml)) {
		await openBrowserPreview(accessor, indexHtml.toString(), localize('htmlPreview.editorTitle', "CodeCanvas HTML Preview"));
		return;
	}

	const packageJson = URI.joinPath(root, 'package.json');
	if (await fileService.exists(packageJson)) {

		const picks: IQuickPickItem[] = [];
		const { hasScript, devScriptValue } = await hasNpmDevScript(fileService, packageJson);

		if (hasScript) {
			const configPort = await detectConfigPort(fileService, root);
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

		const picked = await quickInputService.pick(picks, {
			title: localize('preview.pick.title', "CodeCanvas Preview"),
			placeHolder: localize('preview.pick.placeholder', "Choose how to open this project")
		});

		if (!picked) {
			return;
		}

		if (picked.id === 'start-dev-server') {
			const configPort = hasScript ? await detectConfigPort(fileService, root) : undefined;
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

			const terminalService = accessor.get(ITerminalService);
			const instance = await terminalService.createTerminal({
				cwd: root,
				location: TerminalLocation.Panel,
				config: {
					name: localize('preview.terminalName', "CodeCanvas Preview")
				}
			});
			await terminalService.revealTerminal(instance);
			await instance.runCommand('npm run dev', true, 'codecanvas.preview.startDevServer');

			const notificationService = accessor.get(INotificationService);
			notificationService.info(localize('preview.waiting', "Starting dev server, waiting for {0}...", previewUrl));

			setTimeout(async () => {
				try {
					const controller = new AbortController();
					const timeout = setTimeout(() => controller.abort(), 15000);
					const response = await fetch(previewUrl, { signal: controller.signal });
					clearTimeout(timeout);

					if (response.ok || response.status < 500) {
						await openBrowserPreview(accessor, previewUrl, localize('vitePreview.editorTitle', "CodeCanvas Dev Server Preview"));
						notificationService.info(localize('preview.connected', "Connected to dev server at {0}", previewUrl));
					}
				} catch {
					notificationService.warn(localize('preview.notReady', "Dev server not ready yet. Use CodeCanvas: Open Localhost Preview to connect manually."));
				}
			}, 3000);

			return;
		}

		if (picked.id === 'open-localhost') {
			await openLocalhostPreview(accessor);
			return;
		}
	}

	await openLocalhostPreview(accessor);
}

// Preview status bar contribution
class CodeCanvasPreviewStatusContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codecanvasPreviewStatus';

	private statusEntry: IStatusbarEntryAccessor | undefined;
	private disposables = new DisposableStore();
	private watcherDisposables = new DisposableStore();
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
			model.then(m => m.reload(true)).catch(() => {});
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

// Preview view container in the activity bar
Registry.as<IViewContainersRegistry>(
	ViewContainerExtensions.ViewContainersRegistry
).registerViewContainer({
	id: PREVIEW_VIEW_ID,
	title: localize2('codecanvasPreview', "CodeCanvas Preview"),
	icon: codecanvasPreviewIcon,
	order: 5,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [PREVIEW_VIEW_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: PREVIEW_VIEW_ID,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar);

// Actions
registerAction2(class OpenCodeCanvasPreviewAction extends Action2 {
	constructor() {
		super({
			id: 'codecanvas.preview.open',
			title: localize2('openPreview', "CodeCanvas: Open Preview"),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.CommandPalette
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await openWorkspacePreview(accessor);
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
		await openLocalhostPreview(accessor);
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
			showElementInfo(notificationService, data);
		});

		const activeListener = model.onDidChangeElementSelectionActive((active: boolean) => {
			if (!active) {
				listener.dispose();
				activeListener.dispose();
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
	}
});

function showElementInfo(notificationService: INotificationService, data: IElementData): void {
	const parser = new DOMParser();
	const doc = parser.parseFromString(data.outerHTML, 'text/html');
	const el = doc.body.firstElementChild;
	const tagName = el?.tagName?.toLowerCase() ?? 'element';

	const classes = data.attributes?.class ?? '';
	const id = data.attributes?.id ?? '';
	const selector = `${tagName}${id ? '#' + id : ''}${classes ? '.' + classes.split(' ').join('.') : ''}`;

	const bounds = data.bounds;
	const dims = data.dimensions;
	const infoLines = [
		localize('inspector.tag', "Tag: {0}", tagName.toUpperCase()),
		localize('inspector.selector', "Selector: {0}", selector),
		localize('inspector.dimensions', "Size: {0}x{1}px", bounds?.width ?? dims?.width ?? '?', bounds?.height ?? dims?.height ?? '?'),
	];

	if (data.innerText && data.innerText.trim()) {
		infoLines.push(localize('inspector.text', "Text: \"{0}\"", data.innerText.trim().substring(0, 100)));
	}

	if (data.attributes) {
		const attrs = Object.entries(data.attributes).filter(([k]) => k !== 'class' && k !== 'id');
		if (attrs.length > 0) {
			infoLines.push(localize('inspector.attrs', "Attributes: {0}", attrs.map(([k, v]) => `${k}="${v}"`).join(', ')));
		}
	}

	if (data.ancestors && data.ancestors.length > 0) {
		const ancestorPath = data.ancestors.map(a => a.tagName.toLowerCase()).join(' > ') + ' > ' + tagName;
		infoLines.push(localize('inspector.path', "Path: {0}", ancestorPath));
	}

	notificationService.info(infoLines.join('\n'));
}

registerWorkbenchContribution2(CodeCanvasPreviewStatusContribution.ID, CodeCanvasPreviewStatusContribution, WorkbenchPhase.BlockRestore);