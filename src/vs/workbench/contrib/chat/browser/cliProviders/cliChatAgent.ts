/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ICliAgentService } from '../../../../../platform/cliAgent/common/cliAgent.js';
import { ChatAgentLocation, ChatModeKind } from '../../common/constants.js';
import {
	IChatAgentHistoryEntry,
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
	IChatAgentService,
} from '../../common/participants/chatAgents.js';
import { IChatProgress } from '../../common/chatService/chatService.js';
import { ICliModelDescriptor, PERMISSION_MODE_SETTING } from './cliLanguageModelProvider.js';
import { runCli } from './cliProcess.js';

/** Context key tracking which agent the user picked in the panel selector (claude/codex/copilot). */
export const CC_ACTIVE_AGENT = new RawContextKey<string>('ccActiveAgent', 'claude');

/**
 * Chat agent backed by a CLI (Claude Code, ...). This is the piece that makes the panel
 * actually answer through the CLI: it registers as a default, non-core agent, so the chat's
 * default-agent resolution (which prefers non-core agents) routes the request here instead of
 * to Copilot. Its `invoke` spawns the CLI and streams stdout back as markdown.
 *
 * Gated by the `ccActiveAgent` context key so it only takes over when its agent is selected;
 * pick Copilot and this deactivates, restoring the built-in default agent.
 */
class CliChatAgent extends Disposable implements IChatAgentImplementation {
	constructor(
		private readonly _descriptor: ICliModelDescriptor,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@ICliAgentService private readonly _cliAgentService: ICliAgentService,
	) {
		super();
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const permissionMode = this._configurationService.getValue<string>(PERMISSION_MODE_SETTING);
		const modelArg = this._resolveModelArg(request.userSelectedModelId);
		this._logService.info(`[cli-agent] invoke vendor=${this._descriptor.vendor} model=${request.userSelectedModelId} arg=${modelArg} perm=${permissionMode}`);
		const prompt = this._buildPrompt(request, history);
		const cwd = request.workingDirectory?.fsPath ?? this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
		const flags = this._descriptor.buildArgs({ modelArg, permissionMode });
		const promptViaStdin = this._descriptor.promptVia === 'stdin';

		try {
			await runCli({
				executable: this._descriptor.executable,
				args: promptViaStdin ? flags : [...flags, prompt],
				cwd,
				format: this._descriptor.format,
				stdin: promptViaStdin ? prompt : undefined,
				onText: text => progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]),
				token,
			}, this._cliAgentService);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			progress([{ kind: 'markdownContent', content: new MarkdownString(`\n\n\`\`\`\n${message}\n\`\`\`\n`) }]);
			return { errorDetails: { message } };
		}

		return {};
	}

	/** Map the picker's `<vendor>:<id>` model id to the CLI `--model` alias for this vendor. */
	private _resolveModelArg(userSelectedModelId: string | undefined): string | undefined {
		if (!userSelectedModelId) {
			return undefined;
		}
		const id = userSelectedModelId.includes(':') ? userSelectedModelId.split(':').pop()! : userSelectedModelId;
		return this._descriptor.models.find(m => m.id === id)?.modelArg;
	}

	/**
	 * Flatten the prior turns plus this request into one prompt string. The CLI runs one-shot
	 * (`-p`), so it has no memory between turns — we replay the transcript as text each time.
	 */
	private _buildPrompt(request: IChatAgentRequest, history: IChatAgentHistoryEntry[]): string {
		const lines: string[] = [];
		for (const entry of history) {
			if (entry.request.message) {
				lines.push(`User: ${entry.request.message}`);
			}
			const answer = entry.response
				.map(part => part.kind === 'markdownContent' ? part.content.value : '')
				.join('');
			if (answer.trim()) {
				lines.push(`Assistant: ${answer}`);
			}
		}
		lines.push(`User: ${request.message}`);
		return lines.join('\n\n');
	}
}

/**
 * Registers a CLI vendor as a selectable, default chat agent. `selectorId` is the agent-selector
 * id (claude/codex) that gates it via the `ccActiveAgent` context key.
 */
export function registerCliChatAgent(
	descriptor: ICliModelDescriptor,
	selectorId: string,
	chatAgentService: IChatAgentService,
	createImpl: () => CliChatAgent,
): IDisposable {
	const store = new DisposableStore();
	const id = `codecanvas.${descriptor.vendor}`;

	store.add(chatAgentService.registerAgent(id, {
		id,
		name: selectorId,
		isDefault: true,
		isCore: false,
		modes: [ChatModeKind.Agent, ChatModeKind.Ask],
		// Only active when this agent is the one picked in the panel selector.
		when: ContextKeyExpr.equals(CC_ACTIVE_AGENT.key, selectorId).serialize(),
		slashCommands: [],
		disambiguation: [],
		locations: [ChatAgentLocation.Chat],
		metadata: {},
		description: descriptor.displayName,
		extensionId: nullExtensionDescription.identifier,
		extensionVersion: undefined,
		extensionDisplayName: nullExtensionDescription.name,
		extensionPublisherId: nullExtensionDescription.publisher,
	}));

	store.add(chatAgentService.registerAgentImplementation(id, createImpl()));
	return store;
}

export { CliChatAgent };
