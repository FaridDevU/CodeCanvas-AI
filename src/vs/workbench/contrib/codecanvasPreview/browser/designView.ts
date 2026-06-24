/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/designView.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation, IViewDescriptorService } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IAccessibleViewInformationService } from '../../../services/accessibility/common/accessibleViewInformationService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorActivation } from '../../../../platform/editor/common/editor.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { DesignEditorInput, designEditorInputTypeId } from './designEditorInput.js';
import { DesignEditorPane } from './designEditorPane.js';
import { DesignProjectAnalyzer, IGNORED_DIRS, type AnalyzedApp, type ProjectAnalysis } from './designProjectAnalyzer.js';

const DESIGN_VIEW_CONTAINER_ID = 'workbench.view.codecanvasDesign';
const DESIGN_VIEW_ID = 'codecanvas.design.placeholder';
const OPEN_DESIGN_EDITOR_COMMAND_ID = 'workbench.action.openDesignEditor';

const designIcon = registerIcon('codecanvas-design-icon', Codicon.symbolCustomColor, localize('codecanvasDesignIcon', 'View icon of the CodeCanvas Design view.'));

// A file change invalidates the analysis only when it is relevant (configuration or web source).
// y no vive en carpetas de build/deps; si no, el output de un dev server entra en bucle.
function isRelevantFileChange(resource: URI): boolean {
	const segments = resource.path.split('/');
	const basename = (segments.pop() || '').toLowerCase();
	if (segments.some(seg => IGNORED_DIRS.has(seg))) {
		return false;
	}
	return basename === 'package.json' ||
		basename.startsWith('vite.config') ||
		basename.startsWith('next.config') ||
		basename.startsWith('astro.config') ||
		basename.startsWith('tailwind.config') ||
		basename.endsWith('.tsx') ||
		basename.endsWith('.jsx') ||
		basename.endsWith('.html') ||
		basename.endsWith('.css');
}

// Register Design Editor Pane
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		DesignEditorPane,
		DesignEditorPane.ID,
		localize('design', "Design")
	),
	[
		new SyncDescriptor(DesignEditorInput)
	]
);

// Register command to open Design Editor
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_DESIGN_EDITOR_COMMAND_ID,
			title: localize2('openDesignEditor', 'Design'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor) {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		await editorService.openEditor(instantiationService.createInstance(DesignEditorInput), { pinned: true });
	}
});

class DesignViewPane extends ViewPane {
	private opening = false;
	private readonly analyzer: DesignProjectAnalyzer;
	private container: HTMLElement | undefined;
	// Crece en cada analisis; un resultado solo se renderiza si sigue siendo el ultimo.
	private analysisVersion = 0;
	private readonly refreshScheduler: RunOnceScheduler;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IAccessibleViewInformationService accessibleViewInformationService: IAccessibleViewInformationService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IFileService fileService: IFileService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, accessibleViewInformationService);

		this.analyzer = this.instantiationService.createInstance(DesignProjectAnalyzer);

		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				// Si cambio el workspace o la cache es vieja, re-analizar.
				if (this.analyzer.isStale()) {
					this.analyzer.invalidate();
				}
				// El sidebar NO debe forzar la apertura del editor de Design cada vez que se hace
				// visible (era invasivo y podia provocar foco/loop raros). El usuario abre Design
				// manualmente; aqui solo refrescamos el analisis.
				this.runAnalysis();
			}
		}));

		// Watcher: invalidate the cache when relevant project files change.
		// Debounced so a burst of saves triggers a single re-analysis.
		this.refreshScheduler = this._register(new RunOnceScheduler(() => {
			this.analyzer.invalidate();
			if (this.isBodyVisible()) {
				this.renderAnalyzing();
				this.runAnalysis();
			}
		}, 500));

		this._register(fileService.onDidFilesChange(e => {
			const allChanges = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted];
			if (allChanges.some(isRelevantFileChange)) {
				this.refreshScheduler.schedule();
			}
		}));
	}

	private isDesignActive(): boolean {
		return this.editorService.activeEditor?.typeId === designEditorInputTypeId;
	}

	// Opens the Design editor. Kept available for manual/programmatic open (the sidebar no longer
	// auto-opens on visibility). Non-private so it isn't flagged as unused now that the auto-open call
	// was removed, and so a future command can drive it.
	async enterDesign(): Promise<void> {
		if (this.opening || this.isDesignActive()) {
			return;
		}
		this.opening = true;
		try {
			await this.editorService.openEditor(
				this.instantiationService.createInstance(DesignEditorInput),
				{ pinned: true, activation: EditorActivation.ACTIVATE }
			);
		} catch (err) {
			console.error('[CodeCanvas] Failed to open Design editor:', err);
		} finally {
			this.opening = false;
		}
	}

	override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.container = container;
		container.classList.add('design-view-container');

		this.renderAnalyzing();
		this.runAnalysis();
	}

	private renderAnalyzing(): void {
		if (!this.container) { return; }
		clearNode(this.container);
		const wrapper = append(this.container, $('.design-analysis.analyzing'));

		append(wrapper, $('.codicon.codicon-loading'));
		const text = append(wrapper, $('p'));
		text.textContent = localize('cc.design.analyzing', "Analyzing project...");
	}

	private async runAnalysis(): Promise<void> {
		const version = ++this.analysisVersion;
		try {
			const analysis = await this.analyzer.analyze();
			if (version !== this.analysisVersion) {
				return; // un analisis mas nuevo ya esta en curso; no pisar su render
			}
			this.renderAnalysis(analysis);
		} catch (err) {
			if (version !== this.analysisVersion) {
				return;
			}
			console.error('[CodeCanvas] Analysis failed:', err);
			this.renderError();
		}
	}

	private renderError(): void {
		if (!this.container) { return; }
		clearNode(this.container);
		const wrapper = append(this.container, $('.design-analysis.error'));
		const p = append(wrapper, $('p'));
		p.textContent = localize('cc.design.error', "Could not analyze the project.");
		this.appendReanalyzeButton(wrapper);
	}

	private renderAnalysis(analysis: ProjectAnalysis): void {
		if (!this.container) { return; }
		clearNode(this.container);
		const wrapper = append(this.container, $('.design-analysis'));

		if (analysis.apps.length === 0) {
			this.renderNoWorkspace(wrapper);
			return;
		}

		for (const app of analysis.apps) {
			this.renderAppCard(wrapper, app);
		}

		this.appendReanalyzeButton(wrapper);
	}

	private renderNoWorkspace(wrapper: HTMLElement): void {
		const empty = append(wrapper, $('.design-empty'));
		append(empty, $('.codicon.codicon-folder'));
		const text = append(empty, $('p'));
		text.textContent = localize('cc.design.noWorkspace', "Open a folder in Code to analyze your projects.");
	}

	private renderAppCard(wrapper: HTMLElement, app: AnalyzedApp): void {
		const card = append(wrapper, $('.design-app-card'));

		// Header: name + badge
		const header = append(card, $('.design-app-header'));
		const name = append(header, $('strong'));
		name.textContent = app.name;
		const badge = append(header, $('span.framework-badge'));
		badge.textContent = app.framework;

		// Dev info
		const devInfo = append(card, $('.design-app-dev'));
		devInfo.textContent = app.devCommand
			? `${app.devCommand}${app.devPort ? ' :' + app.devPort : ''}`
			: localize('cc.design.noDevScript', "Sin script de desarrollo");

		// Stack tags
		if (app.stack.length > 0) {
			const stackRow = append(card, $('.design-app-stack'));
			for (const tech of app.stack) {
				append(stackRow, $('span')).textContent = tech;
			}
		}

		// Editable status
		const statusRow = append(card, $('.design-app-status'));
		statusRow.classList.add(app.editable ? 'editable' : 'not-supported');

		const statusIcon = append(statusRow, $('span'));
		if (app.editable) {
			statusIcon.className = 'codicon codicon-check';
			append(statusRow, $('span.status-text')).textContent = localize('cc.design.editable', "Editable por Design");

			// Explicit "open" action. The sidebar no longer auto-opens the editor on visibility
			// (that was invasive), so this button is the way to enter Design from the panel.
			const openBtn = append(card, $('button.design-open-editor-button')) as HTMLButtonElement;
			append(openBtn, $('span.codicon.codicon-open-preview'));
			append(openBtn, $('span.design-open-editor-label')).textContent =
				localize('cc.design.open', "Open Design editor");
			openBtn.addEventListener('click', () => { void this.enterDesign(); });
		} else {
			statusIcon.className = 'codicon codicon-close';
			append(statusRow, $('span.status-text')).textContent = localize('cc.design.notSupported', "No soportado");
			if (app.reason) {
				const reason = append(statusRow, $('span.reason'));
				reason.textContent = `(${app.reason})`;
			}
		}

		// Pages (collapsible)
		if (app.pages.length > 0) {
			const pagesHeader = append(card, $('.design-app-pages-header'));
			const pagesIcon = append(pagesHeader, $('span.codicon.codicon-chevron-right'));
			const pagesLabel = append(pagesHeader, $('span'));
			pagesLabel.textContent = localize('cc.design.pages', "Paginas") + ` (${app.pages.length})`;

			const pagesList = append(card, $('.design-app-pages-list'));
			for (const page of app.pages) {
				append(pagesList, $('.design-page-item')).textContent = `${page.name} -> ${page.path}`;
			}

			let expanded = false;
			pagesHeader.addEventListener('click', () => {
				expanded = !expanded;
				pagesList.classList.toggle('expanded', expanded);
				pagesIcon.className = expanded ? 'codicon codicon-chevron-down' : 'codicon codicon-chevron-right';
			});
		}
	}

	private appendReanalyzeButton(wrapper: HTMLElement): void {
		const footer = append(wrapper, $('.design-footer'));
		const btn = append(footer, $('button'));
		btn.textContent = localize('cc.design.reanalyze', "Re-analizar");
		btn.addEventListener('click', () => {
			this.analyzer.invalidate();
			this.renderAnalyzing();
			this.runAnalysis();
		});
	}
}

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);

export const DESIGN_VIEW_CONTAINER = viewContainerRegistry.registerViewContainer({
	id: DESIGN_VIEW_CONTAINER_ID,
	title: localize2('codecanvasDesign', "Design"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [DESIGN_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: DESIGN_VIEW_CONTAINER_ID,
	icon: designIcon,
	order: 1,
	hideIfEmpty: false,
	alwaysUseContainerInfo: true,
	openCommandActionDescriptor: {
		id: DESIGN_VIEW_CONTAINER_ID,
		title: localize2('codecanvasDesign', "Design"),
		mnemonicTitle: localize({ key: 'miViewCodeCanvasDesign', comment: ['&& denotes a mnemonic'] }, "&&Design"),
		order: 1,
	},
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: DESIGN_VIEW_ID,
	name: localize2('codecanvasDesignPlaceholder', "Design"),
	ctorDescriptor: new SyncDescriptor(DesignViewPane),
	canToggleVisibility: true,
	canMoveView: false,
	order: 1,
}], DESIGN_VIEW_CONTAINER);
