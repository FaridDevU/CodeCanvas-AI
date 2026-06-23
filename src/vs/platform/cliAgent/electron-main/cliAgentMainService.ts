/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { delimiter, dirname, isAbsolute, join } from '../../../base/common/path.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { removeAnsiEscapeCodes } from '../../../base/common/strings.js';
import { getWindowsShell, killTree } from '../../../base/node/processes.js';
import { ILogService } from '../../log/common/log.js';
import { CliFormat, ICliAgentService, ICliRunEvent, ICliRunResult, ICliRunSpec } from '../common/cliAgent.js';

/** A content block from Claude Code's stream-json (`assistant` message content). */
interface IClaudeContentBlock {
	readonly type?: string;
	readonly text?: string;
	readonly name?: string;
	readonly input?: {
		readonly file_path?: string;
		readonly path?: string;
		readonly command?: string;
		readonly pattern?: string;
		readonly url?: string;
		readonly query?: string;
	};
}

export class NativeCliAgentService extends Disposable implements ICliAgentService {
	readonly _serviceBrand: undefined;

	private readonly _onDidRunEvent = this._register(new Emitter<ICliRunEvent>());
	readonly onDidRunEvent = this._onDidRunEvent.event;

	/** Live children keyed by run id, so a run is cancelled by its own handle — never by name. */
	private readonly _running = new Map<string, ChildProcess>();

	constructor(@ILogService private readonly _logService: ILogService) {
		super();
	}

	run(runId: string, spec: ICliRunSpec): Promise<ICliRunResult> {
		const { command, extraPath } = resolveCli(spec.executable);
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (extraPath.length) {
			env.PATH = [...extraPath, env.PATH ?? env.Path ?? ''].filter(Boolean).join(delimiter);
		}

		const wantStdin = typeof spec.stdin === 'string';
		const args = [...spec.args];
		// Node refuses to spawn a `.cmd`/`.bat` shim directly (CVE-2024-27980), so route it through
		// cmd.exe. Safe here: every arg is program-controlled (flags, model aliases) — the prompt
		// rides stdin (claude) or is a controlled string (codex), never untrusted shell input.
		// ponytail: cmd.exe wrapper, not cross-spawn. Add cross-spawn only if argv ever carries
		// untrusted free text on a .cmd path.
		const isCmdShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
		const file = isCmdShim ? getWindowsShell(env) : command;
		const finalArgs = isCmdShim ? ['/d', '/s', '/c', command, ...args] : args;

		this._logService.info(`[cli-agent] run ${runId} ${command} ${args.join(' ')} (stdin=${wantStdin})`);

		return new Promise<ICliRunResult>((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawn(file, finalArgs, {
					cwd: spec.cwd || undefined,
					env,
					windowsHide: true,
					stdio: [wantStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
				});
			} catch (err) {
				reject(asRunError(command, err));
				return;
			}

			if (wantStdin && child.stdin) {
				child.stdin.on('error', () => { /* ignore EPIPE if the child exits early */ });
				child.stdin.end(spec.stdin);
			}
			this._running.set(runId, child);

			const emitText = (value: string) => { if (value) { this._onDidRunEvent.fire({ runId, kind: 'text', value }); } };
			const onLine = spec.format === 'claude-stream-json'
				? makeStreamJsonHandler(emitText)
				: (raw: string) => emitText(removeAnsiEscapeCodes(raw));

			let stdoutBuf = '';
			let stderr = '';
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => {
				if (spec.format === 'claude-stream-json') {
					onLine(chunk); // handler buffers/splits on newlines itself
					return;
				}
				stdoutBuf += chunk;
				let nl: number;
				while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
					onLine(stdoutBuf.slice(0, nl));
					stdoutBuf = stdoutBuf.slice(nl + 1);
				}
			});

			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

			child.on('error', err => {
				this._running.delete(runId);
				reject(asRunError(command, err));
			});

			child.on('close', (code: number | null) => {
				this._running.delete(runId);
				if (spec.format !== 'claude-stream-json' && stdoutBuf) {
					onLine(stdoutBuf); // flush trailing partial line
				}
				const detail = stderr.trim();
				if (code !== 0) {
					this._logService.warn(`[cli-agent] ${runId} ${command} exit=${code} stderr=${detail.slice(0, 800) || '(empty)'}`);
					// Surface the CLI's own error so the user sees the real cause (auth/flags/PATH).
					this._onDidRunEvent.fire({ runId, kind: 'error', value: detail || `${command} exited with code ${code}` });
				}
				resolve({ exitCode: code });
			});
		});
	}

	cancel(runId: string): void {
		const child = this._running.get(runId);
		if (!child) {
			return;
		}
		this._running.delete(runId);
		if (typeof child.pid === 'number') {
			killTree(child.pid, true).catch(() => { try { child.kill(); } catch { /* already dead */ } });
		} else {
			try { child.kill(); } catch { /* already dead */ }
		}
	}
}

function asRunError(command: string, err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	// A GUI launch doesn't inherit the shell PATH, so ENOENT almost always means "not installed
	// or not in a known location". Make that actionable rather than a bare errno.
	return new Error(`Could not run "${command}". Is the CLI installed? (${message})`);
}

/**
 * Resolve a CLI to a runnable path WITHOUT relying on PATH: a GUI-launched app doesn't inherit
 * the user's shell PATH, so installers' binaries (e.g. ~/AppData/Roaming/npm/claude.cmd) are
 * invisible to a bare spawn. Probe known install dirs, fall back to the bare name + a widened
 * PATH. Returns the command plus dirs to prepend to PATH so the CLI finds its sibling tools.
 */
function resolveCli(executable: string): { command: string; extraPath: string[] } {
	if (isAbsolute(executable) && existsSync(executable)) {
		return { command: executable, extraPath: [dirname(executable)] };
	}
	const home = homedir();
	const win = process.platform === 'win32';
	const base = executable.replace(/\.(cmd|exe)$/i, '');
	// Order matters: the native installer (~/.local/bin) ships a real exe; the npm shim is a .cmd.
	const candidates = win
		? [
			join(home, '.local', 'bin', `${base}.exe`),
			join(home, 'AppData', 'Roaming', 'npm', `${base}.cmd`),
			join(home, 'AppData', 'Roaming', 'npm', `${base}.exe`),
		]
		: [
			join(home, '.local', 'bin', base),
			join(home, '.npm-global', 'bin', base),
			`/opt/homebrew/bin/${base}`,
			`/usr/local/bin/${base}`,
			join(home, `.${base}`, 'local', base),
		];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return { command: candidate, extraPath: [dirname(candidate)] };
		}
	}
	const extraPath = win
		? [join(home, '.local', 'bin'), join(home, 'AppData', 'Roaming', 'npm')]
		: [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global', 'bin')];
	return { command: executable, extraPath };
}

/**
 * Returns a stdout handler that parses Claude Code's NDJSON stream. Buffers across chunks, splits
 * on newlines, and forwards each `assistant` event's content: text blocks verbatim, and `tool_use`
 * blocks as a compact markdown line (e.g. **Edit** `src/foo.ts`) so the user sees the agent
 * working. The tools already ran inside the CLI, so they are rendered as plain text — never as a
 * chat tool-use part (that would make the chat try to execute them again).
 */
function makeStreamJsonHandler(onText: (text: string) => void): (raw: string) => void {
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
			let event: { type?: string; message?: { content?: IClaudeContentBlock[] } };
			try {
				event = JSON.parse(line);
			} catch {
				continue; // partial/garbled line — skip
			}
			if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
				for (const block of event.message.content) {
					if (block?.type === 'text' && block.text) {
						onText(block.text);
					} else if (block?.type === 'tool_use' && block.name) {
						onText(formatToolUse(block));
					}
				}
			}
		}
	};
}

/** Compact, non-executable markdown line describing a tool the CLI ran. */
function formatToolUse(block: IClaudeContentBlock): string {
	const i = block.input ?? {};
	const arg = i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? '';
	const argText = typeof arg === 'string' && arg ? ` \`${arg.length > 120 ? arg.slice(0, 117) + '...' : arg}\`` : '';
	return `\n\n**${block.name}**${argText}\n`;
}

// CliFormat is re-exported so the channel/types stay in one import for consumers.
export type { CliFormat };
