/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { CliFormat, ICliAgentService } from '../../../../../platform/cliAgent/common/cliAgent.js';

export type { CliFormat };

export interface ICliRunOptions {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly format?: CliFormat;
	/** Written to the child's stdin then closed (claude); omit to leave stdin ignored (codex). */
	readonly stdin?: string;
	/** Called with each decoded text chunk (assistant text, a tool-use line, or an error). */
	readonly onText: (text: string) => void;
	readonly token: CancellationToken;
}

/**
 * Runs a CLI via the main-process {@link ICliAgentService} (plain pipes, NOT a PTY) and forwards
 * its streamed output to `onText`. Resolves when the process exits; rejects only on a spawn
 * failure (CLI missing). A non-zero exit surfaces the CLI's stderr as a text chunk, not a throw,
 * so the error shows inline in the chat. Shared by the model provider and the chat agent.
 */
export async function runCli(opts: ICliRunOptions, cliAgentService: ICliAgentService): Promise<void> {
	const runId = generateUuid();
	const store = new DisposableStore();
	store.add(cliAgentService.onDidRunEvent(e => { if (e.runId === runId) { opts.onText(e.value); } }));
	store.add(opts.token.onCancellationRequested(() => cliAgentService.cancel(runId)));
	try {
		await cliAgentService.run(runId, {
			executable: opts.executable,
			args: opts.args,
			cwd: opts.cwd,
			format: opts.format,
			stdin: opts.stdin,
		});
	} finally {
		store.dispose();
	}
}
