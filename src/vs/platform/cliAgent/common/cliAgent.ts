/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ICliAgentService = createDecorator<ICliAgentService>('ICliAgentService');

/** Output shape of a CLI run. `text` = stdout verbatim; `claude-stream-json` = Claude Code NDJSON. */
export type CliFormat = 'text' | 'claude-stream-json';

export interface ICliRunSpec {
	/** Executable name (resolved against known install dirs) or an absolute path. */
	readonly executable: string;
	/** Flags only — the prompt is delivered via `stdin` or appended by the caller. */
	readonly args: readonly string[];
	readonly cwd: string;
	readonly format?: CliFormat;
	/**
	 * Written to the child's stdin, then stdin is closed. Use for `claude` (prompt via stdin
	 * dodges the Windows command-line length limit and gives EOF). Omit to leave stdin ignored,
	 * which `codex exec` needs — it blocks forever reading an open non-TTY pipe.
	 */
	readonly stdin?: string;
}

/** A streamed chunk from a run, tagged with the run id so a caller can filter its own. */
export interface ICliRunEvent {
	readonly runId: string;
	readonly kind: 'text' | 'error';
	readonly value: string;
}

export interface ICliRunResult {
	readonly exitCode: number | null;
}

/**
 * Runs a coding-agent CLI (`claude`, `codex`, ...) headless and streams its output back. Lives
 * in the electron-main process so it spawns the CLI through a plain pipe (NOT a PTY): a PTY makes
 * stdin/stdout a TTY, which makes `claude` think it is interactive, ignore `-p`, and hang. Pipes
 * keep it in non-interactive mode. Reached from the workbench over an IPC channel.
 */
export interface ICliAgentService {
	readonly _serviceBrand: undefined;
	/** Fires for every text/error chunk of every active run; filter by `runId`. */
	readonly onDidRunEvent: Event<ICliRunEvent>;
	/** Spawn the CLI; resolves when the process exits. Rejects only on a spawn failure. */
	run(runId: string, spec: ICliRunSpec): Promise<ICliRunResult>;
	/** Kill the run's process tree by handle (never by name — that would kill unrelated CLIs). */
	cancel(runId: string): void;
}

/** Used on platforms without a main process (web). Any call is a programming error there. */
export class NullCliAgentService implements ICliAgentService {
	readonly _serviceBrand: undefined;
	readonly onDidRunEvent = Event.None;
	async run(): Promise<ICliRunResult> {
		throw new Error('CLI agent is not available in this environment');
	}
	cancel(): void { }
}
