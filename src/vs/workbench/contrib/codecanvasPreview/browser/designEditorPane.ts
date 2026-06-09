/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, Dimension } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { TOGGLE_DESIGN_FULL_WINDOW_COMMAND_ID } from './designFullWindowMode.js';

export class DesignEditorPane extends EditorPane {

	static readonly ID = 'workbench.editors.designEditor';

	private container: HTMLElement | undefined;
	private webviewElement: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
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
		this.webviewElement = append(this.container, $('iframe.design-webview'));
		this.webviewElement.style.width = '100%';
		this.webviewElement.style.height = '100%';
		this.webviewElement.style.border = 'none';
		this.webviewElement.style.backgroundColor = '#1e1e1e';

		// Load the design editor bundle. The bundle lives at <appRoot>/resources/app/design-editor,
		// which sits next to `out`, so we escape the file root with `vs/../../`.
		const bundleUri = FileAccess.asBrowserUri('vs/../../resources/app/design-editor/index.html');
		(this.webviewElement as HTMLIFrameElement).src = bundleUri.toString(true);

		// The full-window toggle button lives inside the iframe (Onlook top bar). It posts a
		// message that we forward to the workbench command that hides/shows the chrome.
		this._register(addDisposableListener(mainWindow, 'message', (e: MessageEvent) => {
			if (e.data && e.data.type === 'codecanvas:toggle-design-fullscreen') {
				this.commandService.executeCommand(TOGGLE_DESIGN_FULL_WINDOW_COMMAND_ID);
			}
		}));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
	}

	override layout(dimension: Dimension): void {
		// Layout is handled by the iframe
	}
}
