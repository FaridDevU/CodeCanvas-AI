/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { AsyncIterableSource } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { removeAnsiEscapeCodes } from '../../../../../base/common/strings.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IShellLaunchConfig, ITerminalProcessOptions } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { ITerminalInstanceService } from '../../../terminal/browser/terminal.js';
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
	/** Provider/group name shown in the picker, e.g. `Claude`. */
	readonly displayName: string;
	/** Executable to spawn, e.g. `claude`. */
	readonly executable: string;
	/** Selectable models shown in the picker for this vendor. */
	readonly models: readonly ICliSubModel[];
	/**
	 * Builds the argv for a one-shot, non-interactive run that prints to stdout and exits.
	 * `modelArg` (from the chosen sub-model) selects the model; undefined = CLI default.
	 */
	readonly buildArgs: (prompt: string, modelArg?: string) => string[];
	/**
	 * Output shape. `text` streams stdout verbatim. `claude-stream-json` parses Claude Code's
	 * NDJSON (`--output-format stream-json`): emits the text blocks, ignores system/result noise.
	 * Tool events (tool_use/tool_result) are ignored for now — rendered in a later step.
	 */
	readonly format?: 'text' | 'claude-stream-json';
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
		@ITerminalInstanceService private readonly _terminalInstanceService: ITerminalInstanceService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
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
		const prompt = this._buildPrompt(messages);
		const source = new AsyncIterableSource<IChatResponsePart>();
		const store = new DisposableStore();

		const result = (async () => {
			const backend = await this._terminalInstanceService.getBackend();
			if (!backend) {
				throw new Error('No terminal backend available to run the CLI model');
			}

			const cwd = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
			const env = await backend.getEnvironment();

			const shellLaunchConfig: IShellLaunchConfig = {
				executable: this._descriptor.executable,
				args: this._descriptor.buildArgs(prompt, subModel.modelArg),
				name: `CodeCanvas ${subModel.name}`,
				// ponytail: hidden/transient so it never shows in the terminal panel.
				isTransient: true,
				hideFromUser: true,
			};

			const options: ITerminalProcessOptions = {
				shellIntegration: { enabled: false, suggestEnabled: false, nonce: generateUuid() },
				windowsUseConptyDll: false,
				environmentVariableCollections: undefined,
				workspaceFolder: undefined,
				isScreenReaderOptimized: false,
			};

			// ponytail: huge cols so the PTY never reflows long stream-json lines into broken
			// JSON. A real pipe would be cleaner, but the terminal backend only offers PTYs.
			const proc = await backend.createProcess(shellLaunchConfig, cwd, 100000, 30, '11', env, options, /* shouldPersist */ false);
			store.add(proc);

			const onData = this._descriptor.format === 'claude-stream-json'
				? this._makeStreamJsonHandler(source)
				: (raw: string) => { const text = removeAnsiEscapeCodes(raw); if (text) { source.emitOne({ type: 'text', value: text }); } };
			store.add(proc.onProcessData(e => onData(typeof e === 'string' ? e : e.data)));

			store.add(token.onCancellationRequested(() => proc.shutdown(true)));

			let startError: string | undefined;
			const exitCode = await new Promise<number | undefined>(resolve => {
				store.add(proc.onProcessExit(code => resolve(code)));
				proc.start().then(err => {
					if (err) {
						this._logService.error(`[cli-model] failed to start ${this._descriptor.executable}`, err);
						startError = err.message;
						resolve(typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code : 1);
					}
				}, e => {
					this._logService.error(`[cli-model] start threw for ${this._descriptor.executable}`, e);
					startError = e instanceof Error ? e.message : String(e);
					resolve(1);
				});
			});

			if (startError) {
				// Almost always the binary isn't on the app's PATH (a GUI launch doesn't inherit
				// the shell PATH). Make that actionable instead of a bare exit code.
				throw new Error(`Could not run "${this._descriptor.executable}". Is it installed and on PATH? (${startError})`);
			}
			if (exitCode && exitCode !== 0) {
				throw new Error(`${subModel.name} exited with code ${exitCode}`);
			}
		})();

		// Resolve/reject the stream when the process is done.
		result.then(() => source.resolve(), err => source.reject(err instanceof Error ? err : new Error(String(err))))
			.finally(() => store.dispose());

		return { stream: source.asyncIterable, result };
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		// ponytail: rough char/4 estimate; swap for a real tokenizer if budgeting matters.
		const text = typeof message === 'string' ? message : this._messageText(message);
		return Math.ceil(text.length / 4);
	}

	/**
	 * Returns a stdout handler that parses Claude Code's NDJSON stream. Buffers across chunks,
	 * splits on newlines, and emits the text from each `assistant` event. Non-JSON / other event
	 * types are skipped. Tool events are intentionally ignored here (rendered in a later step).
	 */
	private _makeStreamJsonHandler(source: AsyncIterableSource<IChatResponsePart>): (raw: string) => void {
		let buffer = '';
		return (raw: string) => {
			buffer += raw;
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = removeAnsiEscapeCodes(buffer.slice(0, nl)).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) {
					continue;
				}
				let event: { type?: string; message?: { content?: { type?: string; text?: string }[] } };
				try {
					event = JSON.parse(line);
				} catch {
					continue; // partial/garbled line (PTY noise) — skip
				}
				if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
					for (const block of event.message.content) {
						if (block?.type === 'text' && block.text) {
							source.emitOne({ type: 'text', value: block.text });
						}
					}
				}
			}
		};
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
