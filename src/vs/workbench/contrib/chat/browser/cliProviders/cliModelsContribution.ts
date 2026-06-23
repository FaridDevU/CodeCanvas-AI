/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isWindows } from '../../../../../base/common/platform.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../../nls.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { CliLanguageModelProvider, ICliModelDescriptor, PERMISSION_MODE_SETTING } from './cliLanguageModelProvider.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'codecanvas',
	title: localize('codecanvas.title', "CodeCanvas"),
	type: 'object',
	properties: {
		[PERMISSION_MODE_SETTING]: {
			type: 'string',
			enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
			enumDescriptions: [
				localize('cc.perm.default', "Ask before each action (write actions are skipped in the headless agent)."),
				localize('cc.perm.acceptEdits', "Auto-apply file edits; other actions still require permission."),
				localize('cc.perm.plan', "Only plan the changes; do not apply anything."),
				localize('cc.perm.bypass', "Run every action without asking. Use with care."),
			],
			default: 'acceptEdits',
			description: localize('cc.perm.desc', "How freely the AI agent (Claude CLI) may act on your project."),
		},
	},
});

/**
 * CLI-backed chat models that appear in the model picker alongside Copilot.
 * Each runs as a hidden PTY process. Start with Claude; Codex is the same shape.
 */
const CLI_MODELS: readonly ICliModelDescriptor[] = [
	{
		vendor: 'claude-cli',
		displayName: 'Claude',
		executable: 'claude',
		// The picker lists these; selecting one passes its alias via `--model` (default = none).
		models: [
			{ id: 'default', name: 'Claude (CLI)' },
			{ id: 'opus', name: 'Claude Opus', modelArg: 'opus' },
			{ id: 'sonnet', name: 'Claude Sonnet', modelArg: 'sonnet' },
			{ id: 'haiku', name: 'Claude Haiku', modelArg: 'haiku' },
		],
		// Agent mode: `-p` one-shot + stream-json so we get text + tool events. `--verbose` is
		// required by claude to stream the full NDJSON under `-p`. `--permission-mode` lets the
		// agent act (edit files / run commands) without an interactive prompt.
		buildArgs: (prompt, { modelArg, permissionMode }) => [
			'-p', '--output-format', 'stream-json', '--verbose',
			...(permissionMode ? ['--permission-mode', permissionMode] : []),
			...(modelArg ? ['--model', modelArg] : []),
			prompt,
		],
		format: 'claude-stream-json',
	},
	{
		vendor: 'codex-cli',
		displayName: 'Codex',
		// On Windows the npm shim is `codex.cmd`; CreateProcess (no shell) won't apply
		// PATHEXT, so spawn the exact file. Elsewhere the bare `codex` resolves.
		executable: isWindows ? 'codex.cmd' : 'codex',
		models: [
			{ id: 'codex', name: 'Codex (CLI)' },
			{ id: 'gpt-5-codex', name: 'Codex GPT-5', modelArg: 'gpt-5-codex' },
		],
		// ponytail: `codex exec <prompt>` is codex's non-interactive run; `-m` picks the model.
		buildArgs: (prompt, { modelArg }) => ['exec', ...(modelArg ? ['-m', modelArg] : []), prompt],
	},
];

export class CliModelsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.cliModelsContribution';

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		for (const descriptor of CLI_MODELS) {
			const vendorDescriptor = { vendor: descriptor.vendor, displayName: descriptor.displayName, configuration: undefined, managementCommand: undefined, when: undefined };
			this._languageModelsService.deltaLanguageModelChatProviderDescriptors([vendorDescriptor], []);
			this._register(toDisposable(() => this._languageModelsService.deltaLanguageModelChatProviderDescriptors([], [vendorDescriptor])));

			const provider = this._register(this._instantiationService.createInstance(CliLanguageModelProvider, descriptor));
			this._register(this._languageModelsService.registerLanguageModelProvider(descriptor.vendor, provider));
			// Resolve the model now; the service otherwise only resolves on a provider change event.
			provider.notifyModelsChanged();
		}
	}
}
