/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeCanvas AI contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { $, append } from '../../../../base/browser/dom.js';
import { observableValue, ISettableObservable, runOnChange } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { FileChangeType } from '../../../../platform/files/common/files.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IElementData } from '../../../../platform/browserView/common/browserView.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { generateDiff, createBackup, IDomDelta } from './EdicionVisual/diffEngine.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';

const PREVIEW_ID = 'codecanvas.preview';
const PREVIEW_VIEW_ID = 'codecanvasPreview';
const INSPECTOR_VIEW_ID = 'codecanvas.inspector';
const STATUS_ID = 'status.codecanvasPreview';

const codecanvasPreviewIcon = registerIcon('codecanvas-preview-icon', Codicon.eye, localize('codecanvasPreviewIcon', 'View icon of the CodeCanvas Preview.'));
const codecanvasInspectorIcon = registerIcon('codecanvas-inspector-icon', Codicon.inspect, localize('codecanvasInspectorIcon', 'View icon of the CodeCanvas Inspector.'));

const currentElementData: ISettableObservable<IElementData | null> = observableValue('codecanvas.currentElement', null);

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

// Inspector ViewPane
class CodeCanvasInspectorView extends ViewPane {
	static readonly ID = INSPECTOR_VIEW_ID;
	static readonly NAME = localize2('inspectorView', "Element Inspector");

	private contentEl!: HTMLElement;

	constructor(
		options: IViewPaneOptions,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService anotherInstantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOpenerService openerService: IOpenerService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService,
			viewDescriptorService, anotherInstantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.style.padding = '8px';
		container.style.fontFamily = 'var(--monaco-monospace-font, monospace)';
		container.style.fontSize = '12px';
		container.style.overflowY = 'auto';

		this.contentEl = append(container, $('div'));
		this.renderEmpty();

		this._register(runOnChange(currentElementData, (data) => {
			if (data) {
				this.renderElement(data);
			} else {
				this.renderEmpty();
			}
		}));
	}

	private renderEmpty(): void {
		this.contentEl.innerHTML = '';
		const empty = append(this.contentEl, $('div'));
		empty.style.color = 'var(--vscode-descriptionForeground, #7d7d87)';
		empty.style.textAlign = 'center';
		empty.style.padding = '20px';
		empty.textContent = localize('inspector.empty', "Click an element in the preview to inspect it.\nRun CodeCanvas: Inspect Element to start.");
	}

	private renderElement(data: IElementData): void {
		this.contentEl.innerHTML = '';

		const parser = new DOMParser();
		const doc = parser.parseFromString(data.outerHTML, 'text/html');
		const el = doc.body.firstElementChild;
		const tagName = el?.tagName?.toLowerCase() ?? 'element';
		const id = data.attributes?.id ?? '';
		const classes = data.attributes?.class ?? '';
		const selector = `${tagName}${id ? '#' + id : ''}${classes ? '.' + classes.replace(/\s+/g, '.') : ''}`;
		const bounds = data.bounds;
		const dims = data.dimensions;

		const section = (title: string): HTMLElement => {
			const sec = $('div', undefined);
			sec.style.marginBottom = '12px';

			const h = $('div', undefined);
			h.style.fontWeight = 'bold';
			h.style.marginBottom = '4px';
			h.style.color = 'var(--vscode-textLink-foreground, #228df2)';
			h.textContent = title;
			h.style.fontSize = '11px';
			h.style.textTransform = 'uppercase';
			h.style.letterSpacing = '0.5px';
			sec.appendChild(h);

			const body = $('div', undefined);
			sec.appendChild(body);
			return sec;
		};

		const row = (label: string, value: string, isMono = true): HTMLElement => {
			const r = $('div', undefined);
			r.style.display = 'flex';
			r.style.marginBottom = '2px';

			const lbl = $('span', undefined);
			lbl.textContent = label + ': ';
			lbl.style.color = 'var(--vscode-descriptionForeground, #7d7d87)';
			lbl.style.flexShrink = '0';
			r.appendChild(lbl);

			const val = $('span', undefined);
			val.textContent = value;
			val.style.wordBreak = 'break-all';
			if (isMono) {
				val.style.color = 'var(--vscode-textPreformat-foreground, #ccc)';
			}
			r.appendChild(val);

			return r;
		};

		// Tag section
		const tagSection = section(localize('inspector.section.element', "Element"));
		append(tagSection.children[1] as HTMLElement, row(localize('inspector.tag', "Tag"), tagName.toUpperCase()));
		append(tagSection.children[1] as HTMLElement, row(localize('inspector.selector', "Selector"), selector || tagName));
		this.contentEl.appendChild(tagSection);

		// Dimensions section
		const dimsSection = section(localize('inspector.section.dimensions', "Dimensions"));
		const w = bounds?.width ?? dims?.width ?? 0;
		const h = bounds?.height ?? dims?.height ?? 0;
		append(dimsSection.children[1] as HTMLElement, row(localize('inspector.size', "Size"), `${w} x ${h}`));
		if (dimensionsData(data)) {
			const d = dimensionsData(data)!;
			append(dimsSection.children[1] as HTMLElement, row(localize('inspector.position', "Position"), `left:${d.left}, top:${d.top}`));
		}
		this.contentEl.appendChild(dimsSection);

		// Attributes section
		if (data.attributes) {
			const filtered = Object.entries(data.attributes).filter(([k]) => k !== 'class' && k !== 'id' && k !== 'style');
			if (filtered.length > 0) {
				const attrsSection = section(localize('inspector.section.attributes', "Attributes"));
				const attrsBody = attrsSection.children[1] as HTMLElement;
				for (const [key, value] of filtered) {
					append(attrsBody, row(key, value));
				}
				this.contentEl.appendChild(attrsSection);
			}
		}

		// Computed styles section
		if (data.computedStyles) {
			const important = ['display', 'position', 'color', 'background-color', 'font-size', 'font-family',
				'margin', 'padding', 'border', 'width', 'height', 'top', 'left', 'right', 'bottom',
				'flex', 'grid', 'z-index', 'overflow'];
			const relevant = Object.entries(data.computedStyles)
				.filter(([k]) => important.includes(k) || important.some(p => k.startsWith(p)))
				.slice(0, 20);

			if (relevant.length > 0) {
				const styleSection = section(localize('inspector.section.styles', "Computed Styles"));
				const styleBody = styleSection.children[1] as HTMLElement;
				for (const [key, val] of relevant) {
					append(styleBody, row(key, val));
				}
				this.contentEl.appendChild(styleSection);
			}
		}

		// DOM path section
		if (data.ancestors && data.ancestors.length > 0) {
			const pathSection = section(localize('inspector.section.path', "DOM Path"));
			const ancestorPath = data.ancestors.slice().reverse().map(a => a.tagName.toLowerCase()).join(' > ') + ' > ' + tagName;
			const pathVal = $('span', undefined);
			pathVal.textContent = ancestorPath;
			pathVal.style.color = 'var(--vscode-textPreformat-foreground, #ccc)';
			pathVal.style.fontSize = '11px';
			append(pathSection.children[1] as HTMLElement, pathVal);
			this.contentEl.appendChild(pathSection);
		}
	}
}

function dimensionsData(data: IElementData): { left: number; top: number; width: number; height: number } | undefined {
	if (data.dimensions) { return data.dimensions; }
	if (data.bounds) { return { left: data.bounds.x, top: data.bounds.y, width: data.bounds.width, height: data.bounds.height }; }
	return undefined;
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

// View container + views registration
const viewContainer = Registry.as<IViewContainersRegistry>(
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

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: CodeCanvasInspectorView.ID,
	name: CodeCanvasInspectorView.NAME,
	ctorDescriptor: new SyncDescriptor(CodeCanvasInspectorView),
	containerIcon: codecanvasInspectorIcon,
	canToggleVisibility: true,
	canMoveView: true,
	order: 1,
}], viewContainer);

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

async function findSourceFile(elementData: IElementData, contextService: IWorkspaceContextService): Promise<string | null> {
	const root = getWorkspaceRoot(contextService);
	if (!root || !elementData.ancestors || elementData.ancestors.length === 0) {
		return null;
	}

	const tag = elementData.ancestors[elementData.ancestors.length - 1]?.tagName?.toLowerCase();
	if (tag === 'head' || elementData.url?.startsWith('http')) {
		return null;
	}

	return URI.joinPath(root, 'styles.css').fsPath;
}

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

		const parser = new DOMParser();
		const doc = parser.parseFromString(elementData.outerHTML, 'text/html');
		const el = doc.body.firstElementChild;
		const tagName = el?.tagName?.toLowerCase() ?? 'element';

		const classes = elementData.attributes?.class ?? '';
		const id = elementData.attributes?.id ?? '';
		const selector = `${tagName}${id ? '#' + id : ''}${classes ? '.' + classes.replace(/\s+/g, '.') : ''}`;

		const stylesToEdit: Record<string, string> = {};
		const currentStyles = elementData.computedStyles ?? {};
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

		const filePath = await findSourceFile(elementData, contextService) || '/project/styles.css';

		const delta = await generateDiff({
			filePath,
			selector: `.${classes.split(' ')[0] || tagName}`,
			originalStyles,
			modifiedStyles: parsedStyles
		}, fileService);

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

registerWorkbenchContribution2(CodeCanvasPreviewStatusContribution.ID, CodeCanvasPreviewStatusContribution, WorkbenchPhase.BlockRestore);