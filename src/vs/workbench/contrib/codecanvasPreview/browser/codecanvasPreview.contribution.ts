/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeCanvas AI contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';

const PREVIEW_ID = 'codecanvas.preview';
const DEFAULT_LOCALHOST_URL = 'http://localhost:5173';

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

async function openBrowserPreview(accessor: ServicesAccessor, url: string, title = localize('preview.title', "CodeCanvas Preview")): Promise<void> {
	const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
	const editorService = accessor.get(IEditorService);
	const input = browserViewWorkbenchService.getOrCreateLazy(PREVIEW_ID, { url, title });

	input.navigate(url);
	await editorService.openEditor(input, { pinned: true });
}

async function hasNpmDevScript(fileService: IFileService, packageJson: URI): Promise<boolean> {
	try {
		const content = await fileService.readFile(packageJson);
		const manifest = JSON.parse(content.value.toString());
		return typeof manifest?.scripts?.dev === 'string';
	} catch {
		return false;
	}
}

async function openLocalhostPreview(accessor: ServicesAccessor): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const value = await quickInputService.input({
		title: localize('localhostPreview.title', "Open CodeCanvas Localhost Preview"),
		prompt: localize('localhostPreview.prompt', "Enter a localhost port or full URL"),
		value: DEFAULT_LOCALHOST_URL
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
		const picks = [{
			id: 'open-localhost',
			label: localize('preview.pick.openLocalhost', "Open localhost preview"),
			description: localize('preview.pick.openLocalhostDescription', "Use an already running dev server")
		}];

		if (await hasNpmDevScript(fileService, packageJson)) {
			picks.unshift({
				id: 'start-dev-server',
				label: localize('preview.pick.startDevServer', "Start npm run dev and open localhost"),
				description: DEFAULT_LOCALHOST_URL
			});
		}

		const picked = await quickInputService.pick(picks, {
			title: localize('preview.pick.title', "CodeCanvas Preview"),
			placeHolder: localize('preview.pick.placeholder', "Choose how to open this project")
		});

		if (!picked) {
			return;
		}

		if (picked.id === 'start-dev-server') {
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
			await openBrowserPreview(accessor, DEFAULT_LOCALHOST_URL, localize('vitePreview.editorTitle', "CodeCanvas Dev Server Preview"));
			return;
		}

		if (picked.id === 'open-localhost') {
			await openLocalhostPreview(accessor);
			return;
		}
	}

	await openLocalhostPreview(accessor);
}

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
