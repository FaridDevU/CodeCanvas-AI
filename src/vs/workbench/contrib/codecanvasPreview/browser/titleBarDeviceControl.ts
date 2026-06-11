/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CodeCanvas title bar controls: the "Ver Preview", "History" and "Share" pills.
// The original VS Code command center (search) is left enabled in the title bar center.

import './media/titleBarDeviceControl.css';
import * as dom from '../../../../base/browser/dom.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction, toAction, Separator } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2, IMenuService } from '../../../../platform/actions/common/actions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { IAuthenticationService, AuthenticationSession } from '../../../../workbench/services/authentication/common/authentication.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

const HISTORY_ACTION_ID = 'codecanvas.titlebar.history';
const SHARE_ACTION_ID = 'codecanvas.titlebar.share';
const USER_PROFILE_ACTION_ID = 'codecanvas.titlebar.userProfile';
const TITLEBAR_CONTROLS_CONTEXT = new RawContextKey<boolean>('codecanvasDeviceControl', false);

// Strip vanilla VS Code title bar chrome that is not part of the CodeCanvas design.
// These are default overrides only (no behavior is removed): the Copilot sign-in
// indicator and the classic menu bar both disappear from the title bar. The command
// center (search) is intentionally left enabled.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'chat.titleBar.signIn.enabled': false,
		'chat.titleBar.openInAgentsWindow.enabled': false,
		'chat.agentsControl.enabled': 'hidden',
		'window.menuBarVisibility': 'compact',
	}
}]);

// User profile avatar in the title bar. Shows GitHub user initials or generic icon.
registerAction2(class UserProfileAction extends Action2 {
	constructor() {
		super({
			id: USER_PROFILE_ACTION_ID,
			title: localize('cc.userProfile', "User Profile"),
			icon: Codicon.account,
			category: Categories.View,
			f1: false,
			menu: [{ id: MenuId.TitleBar, group: 'navigation', order: 0, when: TITLEBAR_CONTROLS_CONTEXT }]
		});
	}
	override async run(): Promise<void> {
		// The account menu is opened by clicking the avatar item (see AvatarTitleBarItem).
		// This run() is only a fallback for the command palette / keybindings.
	}
});

// History: reveals the Timeline. Share: copies the workspace path to the clipboard.
registerAction2(class HistoryAction extends Action2 {
	constructor() {
		super({
			id: HISTORY_ACTION_ID,
			title: localize('cc.history', "History"),
			icon: Codicon.history,
			category: Categories.View,
			f1: false,
			menu: [{ id: MenuId.TitleBar, group: 'navigation', order: 1, when: TITLEBAR_CONTROLS_CONTEXT }]
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('timeline.focus').then(undefined, () => { });
	}
});

registerAction2(class ShareAction extends Action2 {
	constructor() {
		super({
			id: SHARE_ACTION_ID,
			title: localize('cc.share', "Share"),
			icon: Codicon.share,
			category: Categories.View,
			f1: false,
			menu: [{ id: MenuId.TitleBar, group: 'navigation', order: 2, when: TITLEBAR_CONTROLS_CONTEXT }]
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		// Resolve services synchronously before any await; the accessor is only valid synchronously.
		const folder = accessor.get(IWorkspaceContextService).getWorkspace().folders[0];
		const clipboardService = accessor.get(IClipboardService);
		const notificationService = accessor.get(INotificationService);
		if (folder) {
			await clipboardService.writeText(folder.uri.fsPath);
			notificationService.info(localize('cc.shareCopied', "Project path copied to clipboard: {0}", folder.uri.fsPath));
		}
	}
});

// GitHub avatar URLs accept a size param; request a large image so it stays crisp.
function avatarUrlWithSize(url: string, size: number): string {
	if (!url) {
		return url;
	}
	return url + (url.includes('?') ? '&' : '?') + 's=' + size;
}

/** A title-bar avatar that shows the GitHub profile photo of the account signed into
 *  CodeCanvas (the same native GitHub session used by Copilot / the Accounts menu).
 *  Clicking it opens a small account menu; "Ver foto de perfil" shows the photo in-app. */
class AvatarTitleBarItem extends BaseActionViewItem {
	private avatarEl: HTMLElement | undefined;
	private avatarUrl: string | undefined;
	private accountLabel: string | undefined;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		private readonly contextMenuService: IContextMenuService,
		private readonly authService: IAuthenticationService,
		private readonly menuService: IMenuService,
		private readonly contextKeyService: IContextKeyService,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('cc-titlebar-avatar-item');

		const avatar = dom.append(container, dom.$('div.cc-titlebar-avatar'));
		avatar.title = localize('cc.userProfile.tooltip', "Cuenta");
		this.avatarEl = avatar;
		this.renderAvatar();
		void this.loadSession();

		this._register(this.authService.onDidChangeSessions(e => {
			if (e.providerId === 'github') {
				void this.loadSession();
			}
		}));
		this._register(dom.addDisposableListener(avatar, dom.EventType.CLICK, () => this.showMenu(avatar)));
	}

	private async loadSession(): Promise<void> {
		try {
			const sessions = await this.authService.getSessions('github', [], { silent: true });
			if (sessions.length > 0) {
				this.accountLabel = sessions[0].account.label;
				this.avatarUrl = await this.resolveAvatar(sessions[0]);
			} else {
				this.accountLabel = undefined;
				this.avatarUrl = undefined;
			}
		} catch {
			this.accountLabel = undefined;
			this.avatarUrl = undefined;
		}
		this.renderAvatar();
	}

	private async resolveAvatar(session: AuthenticationSession): Promise<string | undefined> {
		// Prefer the GitHub API (authoritative avatar_url); fall back to the id-based URL.
		try {
			const res = await fetch('https://api.github.com/user', {
				headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/vnd.github+json' },
			});
			if (res.ok) {
				const data = await res.json() as { avatar_url?: string };
				if (data.avatar_url) {
					return data.avatar_url;
				}
			}
		} catch {
			// ignore - fall through to id-based URL
		}
		if (session.account.id && /^\d+$/.test(session.account.id)) {
			return `https://avatars.githubusercontent.com/u/${session.account.id}`;
		}
		return undefined;
	}

	private renderAvatar(): void {
		const avatar = this.avatarEl;
		if (!avatar) {
			return;
		}
		dom.clearNode(avatar);
		avatar.classList.remove('cc-titlebar-avatar-icon');
		if (this.avatarUrl) {
			const img = dom.append(avatar, dom.$<HTMLImageElement>('img.cc-titlebar-avatar-img'));
			img.src = avatarUrlWithSize(this.avatarUrl, 160);
			img.alt = this.accountLabel ?? 'GitHub';
		} else {
			avatar.appendChild(dom.$(ThemeIcon.asCSSSelector(Codicon.account)));
			avatar.classList.add('cc-titlebar-avatar-icon');
		}
	}

	private showMenu(anchor: HTMLElement): void {
		// Reuse the native Accounts menu (sign in to Copilot, manage account preferences,
		// manage language model access, per-account actions) so this avatar is the single
		// account entry point. "Ver foto de perfil" is added on top when a photo is available.
		const menu = this.menuService.createMenu(MenuId.AccountsContext, this.contextKeyService);
		const actions: IAction[] = [];

		if (this.avatarUrl) {
			actions.push(toAction({
				id: 'cc.gh.viewPhoto',
				label: localize('cc.gh.viewPhoto', "Ver foto de perfil"),
				class: ThemeIcon.asClassName(Codicon.account),
				run: () => this.showPhoto(),
			}));
			actions.push(new Separator());
		}

		for (const [, group] of menu.getActions({ shouldForwardArgs: true })) {
			actions.push(...group, new Separator());
		}
		if (actions.length && actions[actions.length - 1] instanceof Separator) {
			actions.pop();
		}

		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
			onHide: () => menu.dispose(),
			anchorAlignment: AnchorAlignment.RIGHT,
		});
	}

	private showPhoto(): void {
		if (this.avatarUrl) {
			showAvatarModal(avatarUrlWithSize(this.avatarUrl, 460), this.accountLabel ?? '');
		}
	}
}

/** Shows the profile photo in a centered circular overlay inside the app (dismiss with click/Esc). */
function showAvatarModal(url: string, label: string): void {
	const doc = mainWindow.document;
	const overlay = doc.createElement('div');
	overlay.className = 'cc-avatar-modal-overlay';

	const circle = doc.createElement('div');
	circle.className = 'cc-avatar-modal-circle';
	const img = doc.createElement('img');
	img.src = url;
	img.alt = label;
	circle.appendChild(img);
	overlay.appendChild(circle);

	if (label) {
		const caption = doc.createElement('div');
		caption.className = 'cc-avatar-modal-caption';
		caption.textContent = label;
		overlay.appendChild(caption);
	}

	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			close();
		}
	};
	function close(): void {
		overlay.remove();
		doc.removeEventListener('keydown', onKey);
	}
	overlay.addEventListener('click', close);
	doc.addEventListener('keydown', onKey);
	doc.body.appendChild(overlay);
}

export class CodeCanvasTitleBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.codecanvasTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IAuthenticationService authService: IAuthenticationService,
		@IMenuService menuService: IMenuService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		// The title-bar avatar is now the single account entry point, so hide the default
		// Accounts item at the bottom of the activity bar (key: workbench.activity.showAccounts).
		storageService.store('workbench.activity.showAccounts', false, StorageScope.PROFILE, StorageTarget.USER);
		this._register(actionViewItemService.register(
			MenuId.TitleBar,
			USER_PROFILE_ACTION_ID,
			(action, options) => new AvatarTitleBarItem(action, options, contextMenuService, authService, menuService, contextKeyService)
		));
		this._register(actionViewItemService.register(
			MenuId.TitleBar,
			HISTORY_ACTION_ID,
			(action, options) => new LabeledTitleBarItem(action, options, Codicon.history, localize('cc.history', "History"), true)
		));
		this._register(actionViewItemService.register(
			MenuId.TitleBar,
			SHARE_ACTION_ID,
			(action, options) => new LabeledTitleBarItem(action, options, Codicon.share, localize('cc.share', "Share"), false)
		));
		// Reveal the menu items only after the view-item providers are registered so the
		// toolbar renders our custom controls instead of generic buttons.
		TITLEBAR_CONTROLS_CONTEXT.bindTo(contextKeyService).set(true);
		// The CodeCanvas brand (logo + project + branch) is rendered by the title bar part
		// itself (see titlebarPart.createContentArea) so it survives title bar re-creation.
	}
}

/** A title-bar pill that shows an icon + label (used for History and Share). */
class LabeledTitleBarItem extends BaseActionViewItem {
	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		private readonly icon: ThemeIcon,
		private readonly label: string,
		private readonly showChevron: boolean,
	) {
		super(undefined, action, options);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('cc-titlebar-pill-item');

		const pill = dom.append(container, dom.$('div.cc-titlebar-pill'));
		pill.title = this.label;
		pill.appendChild(dom.$(ThemeIcon.asCSSSelector(this.icon)));
		const label = dom.append(pill, dom.$('span'));
		label.textContent = this.label;
		if (this.showChevron) {
			pill.appendChild(dom.$(`span.cc-titlebar-pill-chevron${ThemeIcon.asCSSSelector(Codicon.chevronDown)}`));
		}

		this._register(dom.addDisposableListener(pill, dom.EventType.CLICK, () => this.action.run()));
	}
}
