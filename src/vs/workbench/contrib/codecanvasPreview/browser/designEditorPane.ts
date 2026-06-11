/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension } from '../../../../base/browser/dom.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { DesignEditorBridge } from './designBridge.js';

export class DesignEditorPane extends EditorPane {

	static readonly ID = 'workbench.editors.designEditor';

	private container: HTMLElement | undefined;
	private webviewElement: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
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
		// Cache-bust so a reload always picks up a freshly built bundle (the iframe would
		// otherwise serve a cached index.html and never request the new hashed assets).
		const bundleUri = FileAccess.asBrowserUri('vs/../../resources/app/design-editor/index.html').with({ query: `v=${Date.now()}` });
		(this.webviewElement as HTMLIFrameElement).src = bundleUri.toString(true);

		// All iframe <-> workbench traffic (fullscreen toggle, click-to-source, file
		// system, terminal/dev server) goes through the bridge, which validates that
		// messages really come from the Design iframe and stay inside the workspace.
		this._register(this.instantiationService.createInstance(DesignEditorBridge, this.webviewElement as HTMLIFrameElement));
	}

	override layout(dimension: Dimension): void {
		// Layout is handled by the iframe
	}
}
