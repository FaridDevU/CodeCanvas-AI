/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
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
 * Per-run output handlers, keyed by run id. We keep ONE long-lived subscription to the service's
 * `onDidRunEvent` (below) and dispatch by run id, rather than subscribing/unsubscribing per call.
 * Subscribing per call churns the IPC channel event: after the first run's listener is disposed and
 * a new one is added, the re-subscription does not redeliver — so only the first turn ever received
 * output. A single persistent listener avoids that churn entirely.
 */
const runHandlers = new Map<string, (text: string) => void>();
let dispatcherWired = false;

/**
 * Runs a CLI via the main-process {@link ICliAgentService} (plain pipes, NOT a PTY) and forwards
 * its streamed output to `onText`. Resolves when the process exits; rejects only on a spawn
 * failure (CLI missing). A non-zero exit surfaces the CLI's stderr as a text chunk, not a throw,
 * so the error shows inline in the chat. Shared by the model provider and the chat agent.
 */
export async function runCli(opts: ICliRunOptions, cliAgentService: ICliAgentService): Promise<void> {
	// Wire the dispatch listener once, for the lifetime of the (singleton) service. Never disposed:
	// per-run subscribe/unsubscribe broke event delivery on every turn after the first.
	// ponytail: single app-lifetime listener on a singleton service; a registered run map is enough.
	if (!dispatcherWired) {
		dispatcherWired = true;
		cliAgentService.onDidRunEvent(e => runHandlers.get(e.runId)?.(e.value));
	}

	const runId = generateUuid();
	runHandlers.set(runId, opts.onText);
	const cancelSub = opts.token.onCancellationRequested(() => cliAgentService.cancel(runId));
	try {
		await cliAgentService.run(runId, {
			executable: opts.executable,
			args: opts.args,
			cwd: opts.cwd,
			format: opts.format,
			stdin: opts.stdin,
		});
	} finally {
		runHandlers.delete(runId);
		cancelSub.dispose();
	}
}
