/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';

/**
 * Bridges the agent selector (chat view host) to the model picker (chat input widget),
 * which are otherwise decoupled. The selector sets the active agent; the model picker
 * scopes its list to that agent via {@link isModelVendorActive}.
 *
 * ponytail: module-level singleton — fine for the single Design chat view. Thread through
 * widget options if multiple chat views ever need independent agents.
 */

/**
 * Agent id (from the agent selector) → predicate over a model's vendor. The picker shows
 * only models whose vendor passes. Each wired agent scopes to the provider that owns it;
 * unmapped agents (e.g. kimi) show all models.
 */
const AGENT_FILTER: Record<string, (vendor: string) => boolean> = {
	claude: vendor => vendor === 'claude-cli',
	codex: vendor => vendor === 'codex-cli',
	// `extensions/copilot` registers the normal GitHub Copilot chat models under this
	// vendor. Do not include `copilotcli` here: that provider belongs to CLI/background
	// sessions, not the standard local Copilot chat.
	copilot: vendor => vendor === 'copilot',
};

let _activeAgentId: string | undefined;
let _filter: ((vendor: string) => boolean) | undefined;
const _onDidChange = new Emitter<void>();

/** Fires when the active agent (and thus the model filter) changes. */
export const onDidChangeActiveAgent: Event<void> = _onDidChange.event;

export function setActiveAgent(agentId: string): void {
	if (agentId === _activeAgentId) {
		return;
	}
	_activeAgentId = agentId;
	_filter = AGENT_FILTER[agentId];
	_onDidChange.fire();
}

/** The currently selected agent id (claude/codex/copilot/...), or undefined before first pick. */
export function getActiveAgentId(): string | undefined {
	return _activeAgentId;
}

/** Whether the picker should show a model with this vendor for the active agent. */
export function isModelVendorActive(vendor: string): boolean {
	return _filter ? _filter(vendor) : true;
}

/** True when the active agent narrows the model list at all (undefined = show everything). */
export function hasActiveAgentFilter(): boolean {
	return _filter !== undefined;
}
