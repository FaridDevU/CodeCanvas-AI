/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { joinPath } from '../../../../../../base/common/resources.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';

export type AccountState = 'linked' | 'unlinked' | 'unavailable';

export interface IAccountStatus {
	readonly state: AccountState;
	/** The linked account email, when known. */
	readonly email?: string;
}

/** Terminal command that signs the user in, per agent. Empty for agents without a backend. */
export const AGENT_LOGIN_COMMAND: Record<string, string> = {
	claude: 'claude auth login',
	codex: 'codex login',
};

/** Terminal command that signs the user out, per agent. */
export const AGENT_LOGOUT_COMMAND: Record<string, string> = {
	claude: 'claude auth logout',
	codex: 'codex logout',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(fileService: IFileService, uri: URI): Promise<any | undefined> {
	try {
		const content = await fileService.readFile(uri);
		return JSON.parse(content.value.toString());
	} catch {
		return undefined;
	}
}

/** Best-effort email claim from a JWT, without verifying the signature. */
function decodeJwtEmail(token: string | undefined): string | undefined {
	const payload = token?.split('.')[1];
	if (!payload) {
		return undefined;
	}
	try {
		const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
		return json.email ?? json.preferred_username ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the given agent has a linked account, and the email if known. Reads the CLI's own
 * local credential file — the same one its `... auth login` writes — so it reflects reality
 * without going through the agent host.
 */
export async function getAccountStatus(agentId: string, fileService: IFileService, home: URI): Promise<IAccountStatus> {
	switch (agentId) {
		case 'claude': {
			const json = await readJson(fileService, joinPath(home, '.claude.json'));
			const email = json?.oauthAccount?.emailAddress;
			return email ? { state: 'linked', email } : { state: 'unlinked' };
		}
		case 'codex': {
			const json = await readJson(fileService, joinPath(home, '.codex', 'auth.json'));
			if (!json || (!json.tokens && !json.OPENAI_API_KEY)) {
				return { state: 'unlinked' };
			}
			return { state: 'linked', email: decodeJwtEmail(json.tokens?.id_token) };
		}
		// Copilot uses VS Code's GitHub sign-in; kimi has no backend yet.
		default:
			return { state: 'unavailable' };
	}
}
