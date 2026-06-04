/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeCanvas AI contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

export interface IDomDelta {
	readonly filePath: string;
	readonly selector: string;
	readonly changes: readonly IDomChangeEntry[];
	readonly originalContent: string;
	readonly modifiedContent: string;
	readonly diff: string;
}

export interface IDomChangeEntry {
	readonly property: string;
	readonly oldValue: string;
	readonly newValue: string;
}

export interface IDeltaRequest {
	readonly filePath: string;
	readonly selector: string;
	readonly originalStyles: Record<string, string>;
	readonly modifiedStyles: Record<string, string>;
}

export async function generateDiff(delta: IDeltaRequest, fileService: IFileService): Promise<IDomDelta> {
	const changes: IDomChangeEntry[] = [];
	const allKeys = new Set([...Object.keys(delta.originalStyles), ...Object.keys(delta.modifiedStyles)]);

	for (const key of allKeys) {
		const oldVal = delta.originalStyles[key] ?? '';
		const newVal = delta.modifiedStyles[key] ?? '';
		if (oldVal !== newVal) {
			changes.push({ property: key, oldValue: oldVal, newValue: newVal });
		}
	}

	const fileUri = URI.file(delta.filePath);
	const originalContent = (await fileService.readFile(fileUri)).value.toString();
	const modifiedContent = applyChangesToContent(originalContent, delta.selector, changes);
	const unifiedDiff = generateUnifiedDiff(originalContent, modifiedContent, delta.filePath);

	return {
		filePath: delta.filePath,
		selector: delta.selector,
		changes,
		originalContent,
		modifiedContent,
		diff: unifiedDiff
	};
}

export async function createBackup(fileUri: URI, fileService: IFileService): Promise<URI> {
	const content = (await fileService.readFile(fileUri)).value.toString();
	const backupUri = URI.file(fileUri.fsPath + '.codecanvas-backup-' + Date.now());
	await fileService.writeFile(backupUri, VSBuffer.fromString(content));
	return backupUri;
}

function applyChangesToContent(content: string, selector: string, changes: readonly IDomChangeEntry[]): string {
	const cssProps = changes.map(c => `  ${c.property}: ${c.newValue};`).join('\n');
	const newRule = `${selector} {\n${cssProps}\n}`;

	const escapedSelector = escapeRegExp(selector);
	const ruleRegex = new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, 'gs');

	if (ruleRegex.test(content)) {
		return content.replace(ruleRegex, newRule);
	}
	return content + '\n' + newRule + '\n';
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generateUnifiedDiff(original: string, modified: string, fileName: string): string {
	const origLines = original.split('\n');
	const modLines = modified.split('\n');
	const lcs: number[][] = [];

	for (let i = 0; i <= origLines.length; i++) {
		lcs[i] = new Array(modLines.length + 1).fill(0);
	}
	for (let i = 1; i <= origLines.length; i++) {
		for (let j = 1; j <= modLines.length; j++) {
			lcs[i][j] = origLines[i - 1] === modLines[j - 1]
				? lcs[i - 1][j - 1] + 1
				: Math.max(lcs[i - 1][j], lcs[i][j - 1]);
		}
	}

	const chunks: { type: '+' | '-' | ' '; text: string }[] = [];
	let i = origLines.length, j = modLines.length;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && origLines[i - 1] === modLines[j - 1]) {
			chunks.unshift({ type: ' ', text: origLines[i - 1] }); i--; j--;
		} else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
			chunks.unshift({ type: '+', text: modLines[j - 1] }); j--;
		} else {
			chunks.unshift({ type: '-', text: origLines[i - 1] }); i--;
		}
	}

	const lines: string[] = [`--- a/${fileName}`, `+++ b/${fileName}`];
	for (const c of chunks) {
		lines.push(c.type + c.text);
	}

	return lines.join('\n');
}