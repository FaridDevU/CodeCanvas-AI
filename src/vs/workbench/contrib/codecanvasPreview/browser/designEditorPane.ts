/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/designView.css';
import { $, append, Dimension } from '../../../../base/browser/dom.js';
import { FileAccess } from '../../../../base/common/network.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { DesignEditorBridge } from './designBridge.js';

export class DesignEditorPane extends EditorPane {

	static readonly ID = 'workbench.editors.designEditor';

	private container: HTMLElement | undefined;
	private webviewElement: HTMLIFrameElement | undefined;
	private bridge: DesignEditorBridge | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(DesignEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	override getTitle(): string {
		return localize('design', "Design");
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = parent;
		this.container.style.display = 'flex';
		this.container.style.flexDirection = 'column';
		this.container.style.width = '100%';
		this.container.style.height = '100%';
		this.container.style.backgroundColor = 'var(--vscode-editor-background, #1e1e1e)';

		// Create webview container
		this.webviewElement = append(this.container, $('iframe.design-webview')) as HTMLIFrameElement;
		this.webviewElement.style.width = '100%';
		this.webviewElement.style.height = '100%';
		this.webviewElement.style.border = 'none';
		this.webviewElement.style.backgroundColor = '#1e1e1e';
		this.loadBundle();

		// All iframe <-> workbench traffic (fullscreen toggle, click-to-source, file system,
		// terminal/dev server, checkpoints) goes through the bridge, which validates that messages
		// really come from the Design iframe and stay inside the workspace. The checkpoint history UI
		// lives inside the iframe as a left-panel tab (design-editor-src) and drives this bridge over
		// the `checkpoint.*` RPC; the keyboard shortcuts below call the same bridge directly.
		this.bridge = this._register(this.instantiationService.createInstance(DesignEditorBridge, this.webviewElement));
	}

	/** Loads (or reloads) the design editor bundle, cache-busting so a fresh build is always picked up. */
	private loadBundle(): void {
		if (!this.webviewElement) {
			return;
		}
		// The bundle lives at <appRoot>/resources/app/design-editor, next to `out`, so we escape
		// the file root with `vs/../../`.
		const bundleUri = FileAccess.asBrowserUri('vs/../../resources/app/design-editor/index.html').with({ query: `v=${Date.now()}` });
		this.webviewElement.src = bundleUri.toString(true);
	}

	// --- Commands (keyboard shortcuts) -------------------------------------------------------
	// Both no-op unless the project is an editable static HTML app, so the shortcuts only act where
	// the Checkpoints panel applies.

	async runCreateCheckpoint(): Promise<void> {
		const bridge = this.bridge;
		if (!bridge || !(await bridge.hasHtmlApp())) {
			return;
		}
		try {
			const cp = await bridge.createCheckpoint();
			this.notificationService.info(localize('cc.design.checkpointCreated', "{0} creado ({1} archivos).", cp.name, cp.fileCount));
		} catch (err) {
			this.notificationService.error(localize('cc.design.checkpointError', "No se pudo crear el checkpoint: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	async runRevertToInitial(): Promise<void> {
		const bridge = this.bridge;
		if (!bridge || !(await bridge.hasHtmlApp())) {
			return;
		}
		if (!bridge.hasCheckpoint()) {
			this.notificationService.info(localize('cc.design.noCheckpoint', "Todavia no hay cambios de Design que revertir."));
			return;
		}

		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('cc.design.revert.confirm', "Revertir al checkpoint inicial?"),
			detail: localize('cc.design.revert.detail', "Se restauraran los archivos editados al checkpoint inicial de esta sesion. Los archivos nuevos no se borraran. Esta accion no se puede deshacer."),
			primaryButton: localize('cc.design.revert.primary', "Revertir"),
		});
		if (!confirmed) {
			return;
		}

		try {
			const { restored, failed } = await bridge.rollback();
			// Reload the canvas so it reflects the restored files; the sidebar re-analyzes on its own
			// through the file watcher.
			this.loadBundle();
			if (failed > 0) {
				this.notificationService.warn(localize('cc.design.revert.partial', "Se restauraron {0} archivos; {1} fallaron.", restored, failed));
			} else {
				this.notificationService.info(localize('cc.design.revert.done', "Cambios revertidos ({0} archivos restaurados).", restored));
			}
		} catch (err) {
			this.notificationService.error(localize('cc.design.revert.error', "No se pudieron revertir los cambios: {0}", err instanceof Error ? err.message : String(err)));
		}
	}

	override layout(dimension: Dimension): void {
		// Layout is handled by the iframe
	}
}

// Keyboard shortcuts: active only while the Design editor is focused (Ctrl+Alt+P avoids clashing
// with Quick Open on Ctrl+P). The handlers themselves gate on an editable HTML app.
const whenDesignActive = ContextKeyExpr.equals('activeEditor', DesignEditorPane.ID);

function activeDesignPane(accessor: ServicesAccessor): DesignEditorPane | undefined {
	const pane = accessor.get(IEditorService).activeEditorPane;
	return pane instanceof DesignEditorPane ? pane : undefined;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'codecanvas.design.createCheckpoint',
			title: localize2('cc.design.cmd.createCheckpoint', "Design: Crear checkpoint"),
			f1: true,
			precondition: whenDesignActive,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				when: whenDesignActive,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyP,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		void activeDesignPane(accessor)?.runCreateCheckpoint();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'codecanvas.design.revertToInitial',
			title: localize2('cc.design.cmd.revertToInitial', "Design: Revertir al inicial"),
			f1: true,
			precondition: whenDesignActive,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				when: whenDesignActive,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyR,
			},
		});
	}
	run(accessor: ServicesAccessor): void {
		void activeDesignPane(accessor)?.runRevertToInitial();
	}
});
