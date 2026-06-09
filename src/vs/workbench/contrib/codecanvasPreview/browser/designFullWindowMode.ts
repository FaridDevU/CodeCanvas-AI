/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { designEditorInputTypeId } from './designEditorInput.js';

// Command toggled from inside the Design editor (the iframe posts a message that the
// DesignEditorPane forwards to this command). Toggles a clean full-window layout that hides
// the workbench chrome around the Design canvas.
export const TOGGLE_DESIGN_FULL_WINDOW_COMMAND_ID = 'workbench.action.codecanvasToggleDesignFullWindow';

// Parts hidden in full-window mode. Title bar (the "nav") and activity bar stay visible.
const HIDDEN_PARTS: Parts[] = [
	Parts.SIDEBAR_PART,
	Parts.PANEL_PART,
	Parts.AUXILIARYBAR_PART,
	Parts.STATUSBAR_PART,
];

export class DesignFullWindowModeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.codecanvasDesignFullWindow';

	private fullWindow = false;
	private readonly wasVisible = new Map<Parts, boolean>();
	private tabsOverride: IDisposable | undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();

		this._register(CommandsRegistry.registerCommand(TOGGLE_DESIGN_FULL_WINDOW_COMMAND_ID, () => this.toggle()));

		// Auto-exit full-window when the Design editor is no longer the active editor, so the
		// user is never left with hidden chrome on a non-Design tab.
		this._register(this.editorService.onDidActiveEditorChange(() => {
			if (this.fullWindow && !this.isDesignActive()) {
				this.exit();
			}
		}));

		// Restore on shutdown so a hidden layout is never persisted.
		this._register({ dispose: () => this.exit() });
	}

	private isDesignActive(): boolean {
		return this.editorService.activeEditor?.typeId === designEditorInputTypeId;
	}

	private toggle(): void {
		if (this.fullWindow) {
			this.exit();
		} else {
			this.enter();
		}
	}

	private isPartVisible(part: Parts): boolean {
		return this.layoutService.isVisible(part, mainWindow);
	}

	private enter(): void {
		if (this.fullWindow) {
			return;
		}
		this.fullWindow = true;
		this.wasVisible.clear();
		for (const part of HIDDEN_PARTS) {
			this.wasVisible.set(part, this.isPartVisible(part));
			this.layoutService.setPartHidden(true, part);
		}
		this.tabsOverride?.dispose();
		this.tabsOverride = this.editorGroupsService.mainPart.enforcePartOptions({ showTabs: 'none' });
	}

	private exit(): void {
		if (!this.fullWindow) {
			return;
		}
		this.fullWindow = false;
		for (const part of HIDDEN_PARTS) {
			if (this.wasVisible.get(part)) {
				this.layoutService.setPartHidden(false, part);
			}
		}
		this.wasVisible.clear();
		this.tabsOverride?.dispose();
		this.tabsOverride = undefined;
	}
}

registerWorkbenchContribution2(
	DesignFullWindowModeContribution.ID,
	DesignFullWindowModeContribution,
	WorkbenchPhase.AfterRestored
);
