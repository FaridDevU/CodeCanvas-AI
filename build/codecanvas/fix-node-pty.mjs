/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Permanent, reproducible fix for native modules that fail to build on Windows because their
// binding.gyp requires MSVC Spectre-mitigated runtime libraries ('SpectreMitigation': 'Spectre').
// If the "MSVC v143 - Spectre-mitigated libs" component is NOT installed in Visual Studio Build
// Tools, the build fails with MSB8040 and the .node binaries are never produced.
//
// Affected modules in this repo:
//   - node-pty           -> conpty.node / conpty_console_list.node (integrated terminal won't launch)
//   - native-is-elevated -> iselevated.node ("Cannot find module .../iselevated")
//
// The right fix (Option A, recommended) is to install the Spectre-mitigated libs once; see
// build/codecanvas/TERMINAL_CONPTY.md. This module is Option B: a repo-owned, reproducible
// workaround that does NOT live inside node_modules. It removes the SpectreMitigation flag from the
// installed binding.gyp and rebuilds the module against Electron (driven by the repo .npmrc:
// runtime=electron, target=<electron>, build_from_source=true).
//
// It runs two ways:
//   - Automatically after `npm install` (root postinstall calls it best-effort: rebuilds only if
//     the binaries are missing, and never fails the install -- it warns instead).
//   - Manually / in CI via `npm run fix-terminal` (strict: non-zero exit on failure). Pass
//     --no-rebuild to only normalize the binding.gyp files.
//
// It is idempotent and a no-op on non-Windows.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..', '..');

/** Native modules whose binding.gyp needs the Spectre flag removed + a rebuild against Electron. */
const NATIVE_MODULES = [
	{ name: 'node-pty', binaries: ['conpty.node', 'conpty_console_list.node'] },
	{ name: 'native-is-elevated', binaries: ['iselevated.node'] },
];

/**
 * Normalize one native module's binding.gyp and (optionally) rebuild it against Electron.
 * Never throws / never exits: returns a structured result so the caller decides if it's fatal.
 *
 * @param {{ name: string, binaries: string[] }} mod
 * @param {{ rebuild?: 'always' | 'if-missing' | 'never', log?: (msg: string) => void }} [opts]
 * @returns {{ status: 'ok' | 'skipped' | 'failed' | 'needs-rebuild', message: string }}
 */
export function fixNativeModule(mod, { rebuild = 'always', log = console.log } = {}) {
	const tag = `[fix-native:${mod.name}]`;
	if (process.platform !== 'win32') {
		return { status: 'skipped', message: 'Not on Windows; nothing to do.' };
	}
	const bindingGyp = resolve(root, 'node_modules', mod.name, 'binding.gyp');
	const releaseDir = resolve(root, 'node_modules', mod.name, 'build', 'Release');
	const configGypi = resolve(root, 'node_modules', mod.name, 'build', 'config.gypi');
	if (!existsSync(bindingGyp)) {
		return { status: 'failed', message: `${mod.name} not found at ${bindingGyp}. Run "npm install" first.` };
	}

	// 1. Remove the SpectreMitigation requirement (idempotent). Strip the whole property line and
	//    any dangling comma so the gyp stays valid whether or not it was the last entry.
	const original = readFileSync(bindingGyp, 'utf8');
	let patched = original.replace(/[ \t]*['"]SpectreMitigation['"]\s*:\s*['"]Spectre['"]\s*,?\r?\n/g, '');
	patched = patched.replace(/,(\s*\r?\n\s*[}\]])/g, '$1');
	if (patched !== original) {
		writeFileSync(bindingGyp, patched, 'utf8');
		log(`${tag} Removed SpectreMitigation from binding.gyp.`);
	} else {
		log(`${tag} binding.gyp already free of SpectreMitigation (ok).`);
	}

	const binaryPaths = mod.binaries.map((b) => resolve(releaseDir, b));
	const binariesPresent = binaryPaths.every((p) => existsSync(p));

	// 2. Rebuild against Electron when asked (always, or only when the binaries are missing).
	const shouldRebuild = rebuild === 'always' || (rebuild === 'if-missing' && !binariesPresent);
	if (shouldRebuild) {
		log(`${tag} Rebuilding against Electron (npm rebuild ${mod.name})...`);
		try {
			execSync(`npm rebuild ${mod.name}`, { cwd: root, stdio: 'inherit' });
		} catch {
			return {
				status: 'failed',
				message: `npm rebuild ${mod.name} failed (see output above). If MSB8040 persists, install `
					+ 'the MSVC Spectre-mitigated libs (Option A) -- see build/codecanvas/TERMINAL_CONPTY.md.',
			};
		}
	} else if (rebuild === 'never' && !binariesPresent) {
		return { status: 'needs-rebuild', message: `binding.gyp normalized but ${mod.name} binaries are missing.` };
	}

	// 3. Verify the produced binaries and that they were built for Electron, not system Node.
	for (const p of binaryPaths) {
		if (!existsSync(p)) {
			return { status: 'failed', message: `Missing ${p} after rebuild.` };
		}
	}
	if (existsSync(configGypi)) {
		const cfg = readFileSync(configGypi, 'utf8');
		if (!/"built_with_electron"\s*:\s*1/.test(cfg)) {
			return {
				status: 'failed',
				message: `${mod.name} was NOT built against Electron (built_with_electron != 1). `
					+ 'Check that .npmrc has runtime=electron and rebuild again.',
			};
		}
		log(`${tag} Verified built_with_electron: 1 (Electron target).`);
	}
	return { status: 'ok', message: `${mod.name}: ${mod.binaries.join(', ')} present and built for Electron.` };
}

/** Fixes all native modules. Returns the worst result (failed > needs-rebuild > ok/skipped). */
export function fixNativeModules(opts = {}) {
	let worst = { status: 'skipped', message: 'Not on Windows; nothing to do.' };
	const rank = { ok: 0, skipped: 0, 'needs-rebuild': 1, failed: 2 };
	for (const mod of NATIVE_MODULES) {
		const result = fixNativeModule(mod, opts);
		if (rank[result.status] >= rank[worst.status]) {
			worst = result;
		}
	}
	return worst;
}

// Backward-compatible alias used by the root postinstall.
export function fixNodePty(opts = {}) {
	return fixNativeModules(opts);
}

// CLI entry (`npm run fix-terminal`): strict -- exit non-zero on failure, never hide the error.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const rebuild = process.argv.includes('--no-rebuild') ? 'never' : 'always';
	const result = fixNativeModules({ rebuild });
	if (result.status === 'failed') {
		console.error(`\n[fix-native] ERROR: ${result.message}\n`);
		process.exit(1);
	}
	console.log(`[fix-native] ${result.status.toUpperCase()}: ${result.message}`);
}
