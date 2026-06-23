/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../../nls.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { IChatAgentService } from '../../common/participants/chatAgents.js';
import { CliLanguageModelProvider, ICliModelDescriptor, PERMISSION_MODE_SETTING } from './cliLanguageModelProvider.js';
import { CC_ACTIVE_AGENT, CliChatAgent, registerCliChatAgent } from './cliChatAgent.js';
import { getActiveAgentId, onDidChangeActiveAgent } from './ccActiveAgent.js';

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
		agentId: 'claude',
		displayName: 'Claude',
		executable: 'claude',
		// claude reads the prompt from stdin (see promptVia) — dodges Windows' cmdline length limit.
		promptVia: 'stdin',
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
		buildArgs: ({ modelArg, permissionMode }) => [
			'-p', '--output-format', 'stream-json', '--verbose',
			...(permissionMode ? ['--permission-mode', permissionMode] : []),
			...(modelArg ? ['--model', modelArg] : []),
		],
		format: 'claude-stream-json',
	},
	{
		vendor: 'codex-cli',
		agentId: 'codex',
		displayName: 'Codex',
		// Bare name; the main-process runner resolves it to the real binary (codex.exe / codex.cmd)
		// from known install dirs, PATH-independently.
		executable: 'codex',
		// ponytail: `codex exec` blocks reading an open non-TTY pipe, so the prompt rides argv.
		promptVia: 'argv',
		models: [
			{ id: 'codex', name: 'Codex (CLI)' },
			{ id: 'gpt-5-codex', name: 'Codex GPT-5', modelArg: 'gpt-5-codex' },
		],
		// ponytail: `codex exec <prompt>` is codex's non-interactive run; `-m` picks the model.
		buildArgs: ({ modelArg }) => ['exec', ...(modelArg ? ['-m', modelArg] : [])],
	},
];

export class CliModelsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.cliModelsContribution';

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IChatAgentService private readonly _chatAgentService: IChatAgentService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
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

			// The chat agent is what actually answers in the panel (the LM provider above only
			// populates the model picker). Registered as a default non-core agent, gated by the
			// active-agent context key so it routes the request to the CLI when its agent is picked.
			this._register(registerCliChatAgent(
				descriptor,
				descriptor.agentId,
				this._chatAgentService,
				() => this._register(this._instantiationService.createInstance(CliChatAgent, descriptor)),
			));
		}

		// Mirror the panel's agent selector into a context key, so the gated chat agents above
		// activate/deactivate as the user switches agent.
		const activeAgentKey = CC_ACTIVE_AGENT.bindTo(this._contextKeyService);
		const syncActiveAgent = () => activeAgentKey.set(getActiveAgentId() ?? 'claude');
		syncActiveAgent();
		this._register(onDidChangeActiveAgent(syncActiveAgent));
	}
}
