/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CodeCanvas title bar controls: the "Ver Preview", "History" and "Share" pills.
// The original VS Code command center (search) is left enabled in the title bar center.

import './media/titleBarDeviceControl.css';
import * as dom from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService, RawContextKey, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

const HISTORY_ACTION_ID = 'codecanvas.titlebar.history';
const SHARE_ACTION_ID = 'codecanvas.titlebar.share';
const VERPREVIEW_ACTION_ID = 'codecanvas.titlebar.verPreview';
const TITLEBAR_CONTROLS_CONTEXT = new RawContextKey<boolean>('codecanvasDeviceControl', false);

// Strip vanilla VS Code title bar chrome that is not part of the CodeCanvas design.
// These are default overrides only (no behavior is removed): the Copilot sign-in
// indicator and the classic menu bar both disappear from the title bar. The command
// center (search) is intentionally left enabled.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'chat.titleBar.signIn.enabled': false,
		'chat.titleBar.openInAgentsWindow.enabled': false,
		'chat.agentsControl.enabled': 'hidden',
		'window.menuBarVisibility': 'compact',
	}
}]);

// Prominent "Ver Preview" button in the title bar, shown only for web projects.
registerAction2(class VerPreviewAction extends Action2 {
	constructor() {
		super({
			id: VERPREVIEW_ACTION_ID,
			title: localize('cc.verPreview', "Ver Preview"),
			icon: Codicon.eye,
			category: Categories.View,
			f1: false,
			menu: [{ id: MenuId.TitleBar, group: 'navigation', order: 0, when: ContextKeyExpr.has('codecanvasIsWebProject') }]
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('codecanvas.preview.open');
	}
});

// History: reveals the Timeline. Share: copies the workspace path to the clipboard.
registerAction2(class HistoryAction extends Action2 {
	constructor() {
		super({
			id: HISTORY_ACTION_ID,
			title: localize('cc.history', "History"),
			icon: Codicon.history,
			category: Categories.View,
			f1: false,
			menu: [{ id: MenuId.TitleBar, group: 'navigation', order: 1, when: TITLEBAR_CONTROLS_CONTEXT }]
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('timeline.focus').then(undefined, () => { });
	}
});

registerAction2(class ShareAction extends Action2 {
	constructor() {
		super({
			id: SHARE_ACTION_ID,
			title: localize('cc.share', "Share"),
			icon: Codicon.share,
			category: Categories.View,
			f1: false,
			menu: [{ id: MenuId.TitleBar, group: 'navigation', order: 2, when: TITLEBAR_CONTROLS_CONTEXT }]
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		// Resolve services synchronously before any await; the accessor is only valid synchronously.
		const folder = accessor.get(IWorkspaceContextService).getWorkspace().folders[0];
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);
		if (folder) {
			await clipboardService.writeText(folder.uri.fsPath);
			notificationService.info(localize('cc.shareCopied', "Project path copied to clipboard: {0}", folder.uri.fsPath));
		}
	}
});

/** A title-bar pill that renders an icon plus a text label (and an optional chevron). */
class LabeledTitleBarItem extends BaseActionViewItem {
	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		private readonly icon: ThemeIcon,
		private readonly text: string,
		private readonly withChevron: boolean,
		private readonly accent = false,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('cc-titlebar-pill-item');
		const pill = dom.append(container, dom.$('button.cc-titlebar-pill'));
		if (this.accent) {
			pill.classList.add('cc-titlebar-pill-accent');
		}
		pill.title = this.text;
		dom.append(pill, dom.$(ThemeIcon.asCSSSelector(this.icon)));
		const label = dom.append(pill, dom.$('span.cc-titlebar-pill-label'));
		label.textContent = this.text;
		if (this.withChevron) {
			dom.append(pill, dom.$(ThemeIcon.asCSSSelector(Codicon.chevronDown) + '.cc-titlebar-pill-chevron'));
		}
		this._register(dom.addDisposableListener(pill, dom.EventType.CLICK, () => this.action.run()));
	}
}

export class CodeCanvasTitleBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codecanvasTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._register(actionViewItemService.register(
			MenuId.TitleBar,
			VERPREVIEW_ACTION_ID,
			(action, options) => new LabeledTitleBarItem(action, options, Codicon.eye, localize('cc.verPreview', "Ver Preview"), false, true)
		));
		this._register(actionViewItemService.register(
			MenuId.TitleBar,
			HISTORY_ACTION_ID,
			(action, options) => new LabeledTitleBarItem(action, options, Codicon.history, localize('cc.history', "History"), true)
		));
		this._register(actionViewItemService.register(
			MenuId.TitleBar,
			SHARE_ACTION_ID,
			(action, options) => new LabeledTitleBarItem(action, options, Codicon.share, localize('cc.share', "Share"), false)
		));
		// Reveal the menu items only after the view-item providers are registered so the
		// toolbar renders our custom controls instead of generic buttons.
		TITLEBAR_CONTROLS_CONTEXT.bindTo(contextKeyService).set(true);
		// The CodeCanvas brand (logo + project + branch) is rendered by the title bar part
		// itself (see titlebarPart.createContentArea) so it survives title bar re-creation.
	}
}
