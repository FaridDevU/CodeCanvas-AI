/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
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
import { DesignEditorInput } from './designEditorInput.js';
import { DesignEditorPane } from './designEditorPane.js';

const DESIGN_VIEW_CONTAINER_ID = 'workbench.view.codecanvasDesign';
const DESIGN_VIEW_ID = 'codecanvas.design.placeholder';
const OPEN_DESIGN_EDITOR_COMMAND_ID = 'workbench.action.openDesignEditor';

const designIcon = registerIcon('codecanvas-design-icon', Codicon.symbolCustomColor, localize('codecanvasDesignIcon', 'View icon of the CodeCanvas Design view.'));

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
		// Open the custom singleton editor input directly. Opening by { resource, override }
		// requires a registered editor resolver (which this editor does not have) and fails
		// with "The editor could not be opened due to an unexpected error".
		await editorService.openEditor(instantiationService.createInstance(DesignEditorInput), { pinned: true });
	}
});

class DesignViewPane extends ViewPane {
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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, accessibleViewInformationService);

		// Clicking the Design activity-bar icon should open the Design editor (the Onlook
		// canvas) in the main area and get the placeholder sidebar column out of the way.
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				this.enterDesign();
			}
		}));
	}

	private async enterDesign(): Promise<void> {
		// Open the custom singleton editor input directly (opening by { resource, override }
		// needs a registered editor resolver we don't have and fails to open). Hiding the
		// surrounding workbench chrome (sidebar/panel/tabs) is handled by
		// DesignFullWindowModeContribution, which reacts to this editor becoming active.
		await this.editorService.openEditor(this.instantiationService.createInstance(DesignEditorInput), { pinned: true });
	}

	override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.alignItems = 'center';
		container.style.justifyContent = 'center';
		container.style.textAlign = 'center';
		container.style.padding = '0 16px';

		const icon = append(container, $('.codicon.codicon-symbol-color'));
		icon.style.fontSize = '40px';
		icon.style.marginBottom = '12px';
		icon.style.opacity = '0.7';

		const title = append(container, $('h3'));
		title.textContent = localize('cc.design.title', "Design");
		title.style.margin = '0 0 6px 0';
		title.style.fontWeight = '400';

		const subtitle = append(container, $('p'));
		// allow-any-unicode-next-line
		subtitle.textContent = localize('cc.design.subtitle', "Tu espacio de diseño (en construcción).");
		subtitle.style.margin = '0';
		subtitle.style.fontSize = '12px';
		subtitle.style.opacity = '0.6';
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
