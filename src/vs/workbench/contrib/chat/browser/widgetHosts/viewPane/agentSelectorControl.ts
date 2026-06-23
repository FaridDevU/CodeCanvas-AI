/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentSelectorControl.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { setActiveAgent } from '../../cliProviders/ccActiveAgent.js';
import { IAccountStatus } from './ccAccountStatus.js';

export interface IAgentDescriptor {
	/** Stable id; also the theme suffix `cc-agent-<id>` and logo class `cc-logo-<id>`. */
	readonly id: string;
	readonly label: string;
	readonly description: string;
	/** Shown but not selectable, with a "coming soon" badge (not wired up yet). */
	readonly comingSoon?: boolean;
}

/** The agents shown in the selector. Color + logo per agent live in agentSelectorControl.css. */
export const CC_AGENTS: readonly IAgentDescriptor[] = [
	// allow-any-unicode-next-line
	{ id: 'claude', label: 'Claude', description: 'Análisis profundo y razonamiento avanzado' },
	// allow-any-unicode-next-line
	{ id: 'kimi', label: 'Kimi', description: 'Respuestas rápidas y concisas', comingSoon: true },
	// allow-any-unicode-next-line
	{ id: 'codex', label: 'Codex', description: 'Experto en código y herramientas', comingSoon: true },
	{ id: 'copilot', label: 'Copilot', description: 'Asistencia en tiempo real' },
];

const AGENT_CLASS_PREFIX = 'cc-agent-';

/**
 * Header for the chat panel: "Nuevo chat" / "Historial" buttons plus a dropdown to pick
 * the active AI agent (Claude/Kimi/Codex/Copilot). Picking an agent stamps `cc-agent-<id>`
 * on the theme target so the whole panel takes the agent color.
 * Phase 1: drives theming + emits events; wiring to the model provider is a later phase.
 */
export class AgentSelectorControl extends Disposable {
	private readonly _onDidChangeAgent = this._register(new Emitter<IAgentDescriptor>());
	readonly onDidChangeAgent: Event<IAgentDescriptor> = this._onDidChangeAgent.event;

	private readonly _onNewChat = this._register(new Emitter<void>());
	readonly onNewChat: Event<void> = this._onNewChat.event;

	private readonly _onHistory = this._register(new Emitter<void>());
	readonly onHistory: Event<void> = this._onHistory.event;

	private readonly _onUseOwnApi = this._register(new Emitter<void>());
	readonly onUseOwnApi: Event<void> = this._onUseOwnApi.event;

	/** Fired when the user clicks "Vincular ahora" for the current agent. */
	private readonly _onLink = this._register(new Emitter<void>());
	readonly onLink: Event<void> = this._onLink.event;

	/** Fired when the user clicks the sign-out button for the current agent. */
	private readonly _onLogout = this._register(new Emitter<void>());
	readonly onLogout: Event<void> = this._onLogout.event;

	private readonly _root: HTMLElement;
	private readonly _triggerLogo: HTMLElement;
	private readonly _triggerLabel: HTMLElement;
	private readonly _menu: HTMLElement;
	private readonly _statusRow: HTMLElement;
	private readonly _statusDot: HTMLElement;
	private readonly _statusText: HTMLElement;
	private readonly _linkButton: HTMLElement;
	private readonly _logoutButton: HTMLElement;
	/** Menu item element per agent id, so `_apply` updates selection without DOM queries. */
	private readonly _items = new Map<string, HTMLElement>();
	private _current: IAgentDescriptor;
	private _open = false;

	constructor(
		container: HTMLElement,
		private readonly _themeTarget: HTMLElement,
	) {
		super();
		this._current = CC_AGENTS[0];

		const root = this._root = append(container, $('.cc-agent-header'));

		// Action row: "+ Nuevo chat" | "Historial"
		const actions = append(root, $('.cc-agent-actions'));
		const newChat = append(actions, $('button.cc-agent-action'));
		append(newChat, $('span.codicon.codicon-add'));
		append(newChat, $('span')).textContent = localize('cc.newChat', "Nuevo chat");
		this._register(addDisposableListener(newChat, EventType.CLICK, () => this._onNewChat.fire()));

		const history = append(actions, $('button.cc-agent-action'));
		append(history, $('span.codicon.codicon-history'));
		append(history, $('span')).textContent = localize('cc.history', "Historial");
		this._register(addDisposableListener(history, EventType.CLICK, () => this._onHistory.fire()));

		// Agent selector
		const selector = append(root, $('.cc-agent-selector'));
		const trigger = append(selector, $('button.cc-agent-trigger'));
		this._triggerLogo = append(trigger, $('span.cc-agent-logo'));
		this._triggerLabel = append(trigger, $('span.cc-agent-trigger-label'));
		this._triggerLabel.textContent = this._current.label;
		append(trigger, $('span.cc-agent-caret.codicon.codicon-chevron-down'));
		this._register(addDisposableListener(trigger, EventType.CLICK, e => { e.stopPropagation(); this._toggle(); }));

		this._menu = append(selector, $('.cc-agent-menu'));
		for (const agent of CC_AGENTS) {
			const item = append(this._menu, $(`.cc-agent-item.${AGENT_CLASS_PREFIX}${agent.id}`));
			this._items.set(agent.id, item);
			append(item, $(`span.cc-agent-logo.cc-logo-${agent.id}`));
			const text = append(item, $('.cc-agent-item-text'));
			append(text, $('span.cc-agent-item-label')).textContent = agent.label;
			if (agent.comingSoon) {
				item.classList.add('coming-soon');
				// allow-any-unicode-next-line
				append(item, $('span.cc-agent-item-soon')).textContent = localize('cc.comingSoon', "Próximamente");
			} else {
				append(item, $('span.cc-agent-item-check.codicon.codicon-check'));
			}
			this._register(addDisposableListener(item, EventType.CLICK, e => { e.stopPropagation(); this.select(agent.id); this._toggle(false); }));
		}

		// Footer: use your own API key.
		append(this._menu, $('.cc-agent-sep'));
		const apiItem = append(this._menu, $('.cc-agent-item.cc-agent-api'));
		append(apiItem, $('span.cc-agent-api-icon.codicon.codicon-key'));
		const apiText = append(apiItem, $('.cc-agent-item-text'));
		append(apiText, $('span.cc-agent-item-label')).textContent = localize('cc.useOwnApi', "Usar API propia");
		append(apiText, $('span.cc-agent-item-desc')).textContent = localize('cc.useOwnApiDesc', "Conecta tu propia clave de API");
		this._register(addDisposableListener(apiItem, EventType.CLICK, e => { e.stopPropagation(); this._onUseOwnApi.fire(); this._toggle(false); }));

		this._register(addDisposableListener(getWindow(container).document, EventType.CLICK, () => this._toggle(false)));

		// Account status: red dot + "Vincular ahora" when unlinked, green dot + email when linked.
		// Anchored bottom-right of the panel (next to the "Default Approvals" footer) via CSS.
		this._statusRow = append(this._themeTarget, $('.cc-agent-status'));
		append(this._statusRow, $('span.cc-agent-status-sep')); // divider, matches the "Local | Default Approvals" one
		this._statusDot = append(this._statusRow, $('span.cc-agent-status-dot'));
		this._statusText = append(this._statusRow, $('span.cc-agent-status-text'));
		this._linkButton = append(this._statusRow, $('button.cc-agent-status-link'));
		this._linkButton.textContent = localize('cc.link', "Vincular ahora");
		this._register(addDisposableListener(this._linkButton, EventType.CLICK, e => { e.stopPropagation(); this._onLink.fire(); }));

		// Sign out: shown only when linked (CSS keys off the status state class).
		this._logoutButton = append(this._statusRow, $('button.cc-agent-status-logout'));
		// allow-any-unicode-next-line
		this._logoutButton.textContent = localize('cc.logout', "Cerrar sesión");
		this._register(addDisposableListener(this._logoutButton, EventType.CLICK, e => { e.stopPropagation(); this._onLogout.fire(); }));

		this._apply();
	}

	/** Render the account status for the current agent. Call on agent change / after re-check. */
	setAccountStatus(status: IAccountStatus): void {
		this._statusRow.classList.remove('linked', 'unlinked', 'unavailable');
		this._statusRow.classList.add(status.state);
		if (status.state === 'linked') {
			this._statusText.textContent = status.email ?? localize('cc.linked', "Cuenta vinculada");
		} else if (status.state === 'unlinked') {
			this._statusText.textContent = localize('cc.notLinked', "No vinculado");
		} else {
			this._statusText.textContent = '';
		}
	}

	get currentAgent(): IAgentDescriptor { return this._current; }

	/** Total height of the header, so the host can reserve space in its layout. */
	get height(): number { return this._root.offsetHeight; }

	select(id: string): void {
		const agent = CC_AGENTS.find(a => a.id === id);
		if (!agent || agent.comingSoon || agent.id === this._current.id) {
			return; // coming-soon agents are shown but not selectable
		}
		this._current = agent;
		this._apply();
		this._onDidChangeAgent.fire(agent);
	}

	private _toggle(force?: boolean): void {
		this._open = force ?? !this._open;
		this._menu.classList.toggle('open', this._open);
	}

	private _apply(): void {
		setActiveAgent(this._current.id);

		for (const a of CC_AGENTS) {
			this._themeTarget.classList.remove(AGENT_CLASS_PREFIX + a.id);
		}
		this._themeTarget.classList.add(AGENT_CLASS_PREFIX + this._current.id);

		this._triggerLogo.className = `cc-agent-logo cc-logo-${this._current.id}`;
		this._triggerLabel.textContent = this._current.label;

		for (const [id, item] of this._items) {
			item.classList.toggle('selected', id === this._current.id);
		}
	}
}
