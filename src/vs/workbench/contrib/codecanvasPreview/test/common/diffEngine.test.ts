/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { generateDiff, createBackup } from '../../common/EdicionVisual/diffEngine.js';

// Minimal in-memory file service for the diff engine logic (read/write round-trip).
function createMemoryFileService(seed: Record<string, string> = {}): IFileService {
	// Key by URI.toString() so the lookups are platform-independent (fsPath
	// would differ between POSIX seeds and Windows backslash paths).
	const files = new Map<string, string>();
	for (const [path, content] of Object.entries(seed)) {
		files.set(URI.file(path).toString(), content);
	}
	const service = {
		readFile: async (resource: URI) => ({ value: VSBuffer.fromString(files.get(resource.toString()) ?? '') }),
		writeFile: async (resource: URI, content: VSBuffer) => { files.set(resource.toString(), content.toString()); },
	};
	return service as unknown as IFileService;
}

suite('Diff Engine', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('generates unified diff for changed properties', async () => {
		const cssPath = '/project/styles.css';
		const fileService = createMemoryFileService({
			[cssPath]: '.box {\n  left: 10px;\n  top: 20px;\n  width: 100px;\n}'
		});

		const delta = await generateDiff({
			filePath: cssPath,
			selector: '.box',
			originalStyles: { left: '10px', top: '20px', width: '100px' },
			modifiedStyles: { left: '50px', top: '20px', width: '200px' }
		}, fileService);

		assert.strictEqual(delta.changes.length, 2);
		assert.ok(delta.changes.some(c => c.property === 'left' && c.newValue === '50px'));
		assert.ok(delta.changes.some(c => c.property === 'width' && c.newValue === '200px'));
		assert.ok(delta.modifiedContent.includes('left: 50px;'));
		assert.ok(delta.diff.includes('--- a/') && delta.diff.includes('+++ b/'));
	});

	test('reports no changes when styles are equal', async () => {
		const cssPath = '/project/styles.css';
		const fileService = createMemoryFileService({ [cssPath]: '.hero { color: red; }' });

		const delta = await generateDiff({
			filePath: cssPath,
			selector: '.hero',
			originalStyles: { color: 'red', 'font-size': '16px' },
			modifiedStyles: { color: 'red', 'font-size': '16px' }
		}, fileService);

		assert.strictEqual(delta.changes.length, 0);
	});

	test('detects added properties', async () => {
		const cssPath = '/project/styles.css';
		const fileService = createMemoryFileService({ [cssPath]: '.card { color: blue; }' });

		const delta = await generateDiff({
			filePath: cssPath,
			selector: '.card',
			originalStyles: { color: 'blue' },
			modifiedStyles: { color: 'blue', position: 'absolute', 'z-index': '10' }
		}, fileService);

		assert.strictEqual(delta.changes.length, 2);
		assert.ok(delta.changes.some(c => c.property === 'position'));
		assert.ok(delta.modifiedContent.includes('position: absolute;'));
	});

	test('replaces an existing rule and preserves unrelated rules', async () => {
		const cssPath = '/project/main.css';
		const fileService = createMemoryFileService({
			[cssPath]: 'main {\n  padding: 20px;\n}\n\n.container {\n  max-width: 800px;\n}\n'
		});

		const delta = await generateDiff({
			filePath: cssPath,
			selector: '.container',
			originalStyles: { 'max-width': '800px' },
			modifiedStyles: { 'max-width': '1200px' }
		}, fileService);

		assert.ok(delta.modifiedContent.includes('max-width: 1200px;'));
		assert.ok(delta.modifiedContent.includes('padding: 20px;'), 'unrelated rule preserved');
	});

	test('appends a new rule when the selector is not found', async () => {
		const cssPath = '/project/styles.css';
		const fileService = createMemoryFileService({ [cssPath]: '.other { color: black; }' });

		const delta = await generateDiff({
			filePath: cssPath,
			selector: '.missing',
			originalStyles: {},
			modifiedStyles: { color: 'red' }
		}, fileService);

		assert.ok(delta.modifiedContent.includes('.other { color: black; }'), 'original kept');
		assert.ok(delta.modifiedContent.includes('.missing {'), 'new rule appended');
	});

	test('createBackup writes a timestamped copy with the same content', async () => {
		const filePath = '/project/index.html';
		const content = '<html><body>hello</body></html>';
		const fileService = createMemoryFileService({ [filePath]: content });

		const backupUri = await createBackup(URI.file(filePath), fileService);

		assert.ok(backupUri.fsPath.includes('.codecanvas-backup-'));
		const backupContent = (await fileService.readFile(backupUri)).value.toString();
		assert.strictEqual(backupContent, content);
	});
});
