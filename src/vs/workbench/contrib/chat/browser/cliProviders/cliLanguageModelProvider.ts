/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { AsyncIterableSource } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { CliFormat, ICliAgentService } from '../../../../../platform/cliAgent/common/cliAgent.js';
import { runCli } from './cliProcess.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatResponsePart,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
} from '../../common/languageModels.js';

/**
 * Describes a CLI-backed chat model (Claude, Codex, ...). The model is run as a
 * hidden, isolated terminal process (PTY headless) — never attached to a visible
 * terminal instance — and its stdout is streamed back as chat text.
 */
/** Setting that controls the CLI permission level (how freely the agent may act). */
export const PERMISSION_MODE_SETTING = 'codecanvas.design.permissionMode';

/** One selectable model within a vendor — e.g. Claude Opus/Sonnet/Haiku, all run by `claude`. */
export interface ICliSubModel {
	/** Model id within the vendor; identifier is `<vendor>:<id>`. */
	readonly id: string;
	/** Display name in the model picker, e.g. `Claude Sonnet`. */
	readonly name: string;
	/** Value for the CLI's `--model` flag (alias). Undefined = the CLI's own default model. */
	readonly modelArg?: string;
}

export interface ICliModelDescriptor {
	/** Stable vendor id, e.g. `claude-cli`. Drives per-provider theming (CSS class). */
	readonly vendor: string;
	/** Agent-selector id (claude/codex) that gates the chat agent via the `ccActiveAgent` key. */
	readonly agentId: string;
	/** Provider/group name shown in the picker, e.g. `Claude`. */
	readonly displayName: string;
	/** Executable to spawn, e.g. `claude`. */
	readonly executable: string;
	/** Selectable models shown in the picker for this vendor. */
	readonly models: readonly ICliSubModel[];
	/**
	 * How the prompt reaches the CLI. `stdin` (claude) dodges the Windows command-line length
	 * limit and gives the process EOF; `argv` (codex) appends the prompt as the last argument.
	 */
	readonly promptVia: 'stdin' | 'argv';
	/**
	 * Builds the flag argv for a one-shot, non-interactive run (NOT the prompt — see `promptVia`).
	 * `modelArg` selects the model; `permissionMode` is the CLI permission level (so the agent may
	 * edit files / run commands without an interactive prompt). Both optional = CLI defaults.
	 */
	readonly buildArgs: (opts: { modelArg?: string; permissionMode?: string }) => string[];
	/**
	 * Output shape. `text` streams stdout verbatim. `claude-stream-json` parses Claude Code's
	 * NDJSON (`--output-format stream-json`): emits the text blocks, ignores system/result noise.
	 * Tool events (tool_use/tool_result) are ignored for now — rendered in a later step.
	 */
	readonly format?: CliFormat;
}

/**
 * Language model provider backed by a CLI run in a headless PTY. Implements the
 * same {@link ILanguageModelChatProvider} surface as the agent-host provider, so
 * the model shows up in the existing chat model picker with no UI changes.
 */
export class CliLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly _descriptor: ICliModelDescriptor,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ICliAgentService private readonly _cliAgentService: ICliAgentService,
	) {
		super();
	}

	/**
	 * Triggers (re)resolution of this provider's models by the language model service.
	 * The service only resolves a provider's models in response to `onDidChange`, not on
	 * registration, so the contribution calls this once after registering.
	 */
	notifyModelsChanged(): void {
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInfo(_options: unknown, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const d = this._descriptor;
		return d.models.map(m => ({
			identifier: `${d.vendor}:${m.id}`,
			metadata: {
				extension: nullExtensionDescription.identifier,
				name: m.name,
				id: m.id,
				vendor: d.vendor,
				version: '1.0',
				family: d.vendor,
				maxInputTokens: 200000,
				maxOutputTokens: 8192,
				isDefaultForLocation: {},
				isUserSelectable: true,
				// The CLI runs its own tools (edit/bash/...) internally, so it IS an agent. These
				// flags let it pass the picker's agent-mode filter; the chat's own tools are ignored.
				capabilities: { vision: false, toolCalling: true, agentMode: true },
			},
		}));
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, _options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const subModel = this._descriptor.models.find(m => m.id === modelId) ?? this._descriptor.models[0];
		const permissionMode = this._configurationService.getValue<string>(PERMISSION_MODE_SETTING);
		const prompt = this._buildPrompt(messages);
		const source = new AsyncIterableSource<IChatResponsePart>();
		const cwd = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
		const flags = this._descriptor.buildArgs({ modelArg: subModel.modelArg, permissionMode });
		const promptViaStdin = this._descriptor.promptVia === 'stdin';

		const result = runCli({
			executable: this._descriptor.executable,
			args: promptViaStdin ? flags : [...flags, prompt],
			cwd,
			format: this._descriptor.format,
			stdin: promptViaStdin ? prompt : undefined,
			onText: text => source.emitOne({ type: 'text', value: text }),
			token,
		}, this._cliAgentService);

		result.then(() => source.resolve(), err => source.reject(err instanceof Error ? err : new Error(String(err))));

		return { stream: source.asyncIterable, result };
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		// ponytail: rough char/4 estimate; swap for a real tokenizer if budgeting matters.
		const text = typeof message === 'string' ? message : this._messageText(message);
		return Math.ceil(text.length / 4);
	}

	private _buildPrompt(messages: IChatMessage[]): string {
		// ponytail: flatten the transcript into one prompt string; the CLI gets the
		// whole conversation as text. Upgrade to per-turn stdin if history grows costly.
		return messages.map(m => {
			const role = m.role === ChatMessageRole.User ? 'User' : m.role === ChatMessageRole.Assistant ? 'Assistant' : 'System';
			return `${role}: ${this._messageText(m)}`;
		}).join('\n\n');
	}

	private _messageText(message: IChatMessage): string {
		return message.content.map(p => p.type === 'text' ? p.value : '').join('');
	}
}
