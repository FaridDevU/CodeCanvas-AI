/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Title bar device control: segmented desktop/tablet/mobile selector plus a viewport-width
// pill, rendered in the title bar center. The selection is exposed through the
// `previewViewport` observable so the preview can resize itself to match.

import './media/titleBarDeviceControl.css';
import * as dom from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ISettableObservable, observableValue } from '../../../../base/common/observable.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService, RawContextKey, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { IBrowserDeviceProfile } from '../../../../platform/browserView/common/browserView.js';

export const DEVICE_CONTROL_ACTION_ID = 'codecanvas.titlebar.deviceControl';
const HISTORY_ACTION_ID = 'codecanvas.titlebar.history';
const SHARE_ACTION_ID = 'codecanvas.titlebar.share';
const VERPREVIEW_ACTION_ID = 'codecanvas.titlebar.verPreview';
const STORAGE_KEY = 'codecanvas.previewViewport';
const DEVICE_CONTROL_CONTEXT = new RawContextKey<boolean>('codecanvasDeviceControl', false);
const PREVIEW_ID = 'codecanvas.preview';

// Strip vanilla VS Code title bar chrome that is not part of the CodeCanvas design.
// These are default overrides only (no behavior is removed): the Copilot sign-in
// indicator and the classic menu bar both disappear from the title bar.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'chat.titleBar.signIn.enabled': false,
		'chat.titleBar.openInAgentsWindow.enabled': false,
		'chat.agentsControl.enabled': 'hidden',
		'window.menuBarVisibility': 'compact',
		// Free the title bar center for the device control (search stays on Ctrl+P / the
		// Search activity).
		'window.commandCenter': false,
	}
}]);

export type DeviceKind = 'desktop' | 'tablet' | 'mobile';

export interface IDevicePreset {
	readonly kind: DeviceKind;
	readonly width: number;
	readonly icon: ThemeIcon;
	readonly label: string;
}

export const DEVICE_PRESETS: readonly IDevicePreset[] = [
	{ kind: 'desktop', width: 1280, icon: Codicon.deviceDesktop, label: localize('device.desktop', "Desktop") },
	{ kind: 'tablet', width: 768, icon: Codicon.window, label: localize('device.tablet', "Tablet") },
	{ kind: 'mobile', width: 375, icon: Codicon.deviceMobile, label: localize('device.mobile', "Mobile") },
];

/** Currently selected preview viewport (consumed by the preview to resize). */
export const previewViewport: ISettableObservable<IDevicePreset> = observableValue('codecanvas.previewViewport', DEVICE_PRESETS[0]);

function presetForKind(kind: string | undefined): IDevicePreset {
	return DEVICE_PRESETS.find(p => p.kind === kind) ?? DEVICE_PRESETS[0];
}

// Placeholder action: the visual control is rendered by the action view item below.
registerAction2(class DeviceControlAction extends Action2 {
	constructor() {
		super({
			id: DEVICE_CONTROL_ACTION_ID,
			title: localize('deviceControl', "Preview Viewport"),
			category: Categories.View,
			f1: false,
			menu: [{ id: MenuId.TitleBarAdjacentCenter, order: -10, when: DEVICE_CONTROL_CONTEXT }]
		});
	}
	override async run(_accessor: ServicesAccessor): Promise<void> { }
});

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
			menu: [{ id: MenuId.TitleBar, group: 'navigation', order: 1, when: DEVICE_CONTROL_CONTEXT }]
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
			menu: [{ id: MenuId.TitleBar, group: 'navigation', order: 2, when: DEVICE_CONTROL_CONTEXT }]
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

class DeviceControlViewItem extends BaseActionViewItem {
	private viewportLabel: HTMLElement | undefined;
	private readonly buttons = new Map<DeviceKind, HTMLElement>();
	private pendingModelResolve: IDisposable | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		@IStorageService private readonly storageService: IStorageService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('cc-device-control-item');

		const root = dom.append(container, dom.$('.cc-device-control'));
		const seg = dom.append(root, dom.$('.cc-device-seg'));

		for (const preset of DEVICE_PRESETS) {
			const btn = dom.append(seg, dom.$('button.cc-device-btn'));
			btn.title = `${preset.label} (${preset.width}px)`;
			btn.setAttribute('aria-label', btn.title);
			dom.append(btn, dom.$(ThemeIcon.asCSSSelector(preset.icon)));
			this._register(dom.addDisposableListener(btn, dom.EventType.CLICK, () => this.select(preset)));
			this.buttons.set(preset.kind, btn);
		}

		const viewport = dom.append(root, dom.$('.cc-device-viewport'));
		dom.append(viewport, dom.$(ThemeIcon.asCSSSelector(Codicon.chevronDown) + '.cc-device-viewport-chevron'));
		this.viewportLabel = dom.prepend(viewport, dom.$('span.cc-device-viewport-label'));
		this._register(dom.addDisposableListener(viewport, dom.EventType.CLICK, () => this.showViewportMenu(viewport)));

		// Always start on Desktop (no emulation) so the preview renders crisp; the user can
		// switch to tablet/mobile, which emulate (and scale) on purpose.
		this.applySelection(DEVICE_PRESETS[0]);
	}

	private select(preset: IDevicePreset): void {
		this.storageService.store(STORAGE_KEY, preset.kind, StorageScope.PROFILE, StorageTarget.USER);
		this.applySelection(preset);
	}

	private showViewportMenu(anchor: HTMLElement): void {
		const current = presetForKind(this.storageService.get(STORAGE_KEY, StorageScope.PROFILE));
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => DEVICE_PRESETS.map(preset => ({
				id: `codecanvas.viewport.${preset.kind}`,
				label: `${preset.label} — ${preset.width}px`,
				tooltip: '',
				class: undefined,
				enabled: true,
				checked: preset.kind === current.kind,
				run: () => this.select(preset),
			})),
		});
	}

	private applySelection(preset: IDevicePreset): void {
		previewViewport.set(preset, undefined);
		for (const [kind, btn] of this.buttons) {
			btn.classList.toggle('checked', kind === preset.kind);
		}
		if (this.viewportLabel) {
			this.viewportLabel.textContent = `${preset.width}px`;
		}
		const input = this.browserViewWorkbenchService.getKnownBrowserViews().get(PREVIEW_ID);
		if (input) {
			// Desktop = no emulation (full width); tablet/mobile = emulated device width.
			const device: IBrowserDeviceProfile | undefined = preset.kind === 'desktop'
				? undefined
				: { width: preset.width, mobile: true };
			// Drop a previous pending resolver so rapid switches before the model
			// resolves don't stack callbacks that all fire and cascade devices.
			this.pendingModelResolve?.dispose();
			this.pendingModelResolve = undefined;
			if (input.model) {
				void input.model.setDevice(device);
			} else {
				this.pendingModelResolve = input.onceModelResolves(model => {
					this.pendingModelResolve = undefined;
					void model.setDevice(device);
				});
			}
		}
	}
}

export class CodeCanvasTitleBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codecanvasTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._register(actionViewItemService.register(
			MenuId.TitleBarAdjacentCenter,
			DEVICE_CONTROL_ACTION_ID,
			(action, options) => instantiationService.createInstance(DeviceControlViewItem, action, options)
		));
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
		DEVICE_CONTROL_CONTEXT.bindTo(contextKeyService).set(true);
		// The CodeCanvas brand (logo + project + branch) is rendered by the title bar part
		// itself (see titlebarPart.createContentArea) so it survives title bar re-creation.
	}
}
