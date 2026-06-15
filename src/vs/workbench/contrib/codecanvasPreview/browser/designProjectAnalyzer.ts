/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { STACK_RULES } from './stackRules.js';

export interface AnalyzedAppPage {
	readonly name: string;
	readonly path: string;
}

export interface AnalyzedApp {
	readonly name: string;
	readonly rootUri: URI;
	readonly framework: 'nextjs' | 'vite' | 'cra' | 'remix' | 'astro' | 'nuxtjs' | 'sveltekit' | 'html' | 'unsupported';
	readonly stack: string[];
	readonly devCommand: string | null;
	readonly devPort: number | null;
	readonly editable: boolean;
	readonly pages: AnalyzedAppPage[];
	readonly reason?: string;
}

export interface ProjectAnalysis {
	readonly apps: AnalyzedApp[];
	readonly analyzedAt: number;
	readonly workspaceId: string;
}

interface PackageJson {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
	workspaces?: string[] | { packages?: string[] };
}

export const IGNORED_DIRS = new Set([
	'node_modules', '.git', 'dist', 'out', '.next', 'build', 'coverage',
	'.vscode', '.idea', '__pycache__', 'venv', '.venv', '.husky', '.github',
	'storybook-static', '.turbo', 'playwright-report', 'test-results',
	// VS Code / fork internals -- not user projects
	'.build', 'extensions', 'test', 'tests', 'remote', 'scripts', 'cli',
	// CodeCanvas Design editor's own source -- not a user app. The built bundle under
	// resources/app/design-editor is excluded separately (see isInternalStaticAppUri).
	'design-editor-src',
]);

const APP_ROUTER_PATHS = ['src/app', 'app'];
const PAGES_ROUTER_PATHS = ['src/pages', 'pages'];
const ALLOWED_PAGE_EXTS = ['.tsx', '.ts', '.jsx', '.js'];

/** Carpetas donde buscamos JSX/TSX para determinar "editable". */
const JSX_SEARCH_ROOTS = ['src', 'app', 'pages', 'components'];
/** Max profundidad al buscar JSX. */
const JSX_MAX_DEPTH = 3;
/** Max archivos que revisamos antes de rendirnos. */
const JSX_MAX_FILES = 60;
/** Max profundidad de escaneo de carpetas. */
const SCAN_MAX_DEPTH = 5;

const WEB_FRAMEWORKS = new Set(['nextjs', 'vite', 'cra', 'remix', 'astro', 'nuxtjs', 'sveltekit']);
const WEB_DEV_INDICATORS = ['vite', 'next', 'react', 'astro', 'nuxt', 'remix', 'svelte', 'webpack', 'parcel', 'rollup', 'serve'];
const INTERNAL_STATIC_APP_PATHS = [
	'/resources/app/design-editor',
];

function isPackageJson(name: string): boolean {
	return name === 'package.json';
}

function parseJsonSafe(content: string): PackageJson | undefined {
	try {
		return JSON.parse(content) as PackageJson;
	} catch {
		return undefined;
	}
}

function inferPort(framework: string, scripts: Record<string, string>): number | null {
	const devScript = scripts['dev'] || scripts['start'] || '';
	// Cubre "--port 3000", "--port=3000", "-p 3000" y "-p3000".
	const portMatch = devScript.match(/(?:--port|-p)[=\s]?(\d+)/);
	if (portMatch) {
		return parseInt(portMatch[1], 10);
	}
	if (framework === 'nextjs') { return 3000; }
	if (framework === 'vite') { return 5173; }
	if (framework === 'remix') { return 3000; }
	if (framework === 'astro') { return 4321; }
	if (framework === 'nuxtjs') { return 3000; }
	if (framework === 'sveltekit') { return 5173; }
	if (framework === 'cra') { return 3000; }
	return null;
}

function detectFramework(stack: string[]): AnalyzedApp['framework'] {
	if (stack.includes('nextjs')) { return 'nextjs'; }
	if (stack.includes('remixrun')) { return 'remix'; }
	if (stack.includes('nuxtjs')) { return 'nuxtjs'; }
	if (stack.includes('sveltekit')) { return 'sveltekit'; }
	if (stack.includes('astro')) { return 'astro'; }
	if (stack.includes('cra')) { return 'cra'; }
	if (stack.includes('vite')) { return 'vite'; }
	return 'unsupported';
}

function getWorkspaceId(ctx: IWorkspaceContextService): string {
	const folders = ctx.getWorkspace().folders;
	return folders.map(f => f.uri.toString()).join('|');
}

function isInternalStaticAppUri(uri: URI): boolean {
	const path = uri.path.toLowerCase();
	return INTERNAL_STATIC_APP_PATHS.some(internalPath => path.endsWith(internalPath));
}

/**
 * Decide si un package.json representa una app web real que merece aparecer
 * en el panel de Design, o si es un paquete auxiliar / libreria / test / etc.
 */
function isCandidateApp(
	_pkg: PackageJson,
	_stack: string[],
	scripts: Record<string, string>,
	_isWorkspaceRoot: boolean,
): boolean {
	// Tiene framework web reconocido
	const hasWebFramework = _stack.some(s => WEB_FRAMEWORKS.has(s));
	if (hasWebFramework) {
		return true;
	}

	// Tiene script dev/start que parezca dev server web
	const devScript = scripts['dev'] || scripts['start'];
	if (devScript && typeof devScript === 'string') {
		const low = devScript.toLowerCase();
		if (WEB_DEV_INDICATORS.some(ind => low.includes(ind))) {
			return true;
		}
	}

	return false;
}

export class DesignProjectAnalyzer {
	private cache: ProjectAnalysis | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	async analyze(): Promise<ProjectAnalysis> {
		const currentWorkspaceId = getWorkspaceId(this.workspaceContextService);
		if (this.cache && this.cache.workspaceId === currentWorkspaceId) {
			return this.cache;
		}

		const apps: AnalyzedApp[] = [];
		const seenUris = new Set<string>();
		const seenAppUris = new Set<string>();
		const folders = this.workspaceContextService.getWorkspace().folders;

		for (const folder of folders) {
			await this.scanFolder(folder.uri, seenUris, seenAppUris, apps);
		}

		// Filtrar apps HTML que estan anidadas dentro de otra app ya detectada
		const filteredApps = apps.filter(app => {
			if (app.framework !== 'html') {
				return true;
			}
			const appPath = app.rootUri.toString();
			return !apps.some(other => {
				if (other === app) {
					return false;
				}
				const otherPath = other.rootUri.toString();
				return appPath.startsWith(otherPath + '/');
			});
		});

		this.cache = { apps: filteredApps, analyzedAt: Date.now(), workspaceId: currentWorkspaceId };
		return this.cache;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	isStale(): boolean {
		if (!this.cache) {
			return true;
		}
		return this.cache.workspaceId !== getWorkspaceId(this.workspaceContextService);
	}

	private async scanFolder(root: URI, seenUris: Set<string>, seenAppUris: Set<string>, apps: AnalyzedApp[]): Promise<void> {
		await this.scanFolderRecursive(root, seenUris, seenAppUris, apps, 0, true);
	}

	private async scanFolderRecursive(
		dir: URI,
		seenUris: Set<string>,
		seenAppUris: Set<string>,
		apps: AnalyzedApp[],
		depth: number,
		isWorkspaceRoot: boolean,
		insideStaticHtmlApp: boolean = false,
	): Promise<void> {
		if (depth > SCAN_MAX_DEPTH) {
			return;
		}

		const dirKey = dir.toString();
		if (seenUris.has(dirKey)) {
			return;
		}
		seenUris.add(dirKey);

		let children;
		try {
			const stat = await this.fileService.resolve(dir);
			children = stat.children ?? [];
		} catch {
			return;
		}

		let hasPackageJson = false;
		let addedApp = false;
		let indexHtmlResource: URI | undefined;
		let workspacePaths: string[] = [];

		for (const child of children) {
			if (child.isFile && isPackageJson(child.name)) {
				hasPackageJson = true;
				// Leer y parsear una sola vez: sirve para el analisis y los workspaces.
				let pkg: PackageJson | undefined;
				try {
					const file = await this.fileService.readFile(child.resource);
					pkg = parseJsonSafe(file.value.toString());
				} catch {
					pkg = undefined;
				}
				if (pkg && typeof pkg === 'object') {
					const app = await this.analyzePackageJson(dir, isWorkspaceRoot, pkg);
					if (app) {
						addedApp = true;
						const appKey = app.rootUri.toString();
						if (!seenAppUris.has(appKey)) {
							seenAppUris.add(appKey);
							apps.push(app);
						}
					}
					// Workspaces para monorepos
					if (pkg.workspaces) {
						if (Array.isArray(pkg.workspaces)) {
							workspacePaths = pkg.workspaces;
						} else if (Array.isArray(pkg.workspaces.packages)) {
							workspacePaths = pkg.workspaces.packages;
						}
					}
				}
			}
			if (child.isFile && child.name.toLowerCase() === 'index.html') {
				indexHtmlResource = child.resource;
			}
		}

		// Si no se detecto app desde package.json, pero hay index.html, registrar como HTML estatico.
		// Solo si NO estamos ya dentro de una app HTML: las subcarpetas con su propio index.html son
		// PAGINAS de la app raiz (las recoge analyzeStaticHtml), no apps separadas.
		let registeredHtmlApp = false;
		if (!addedApp && indexHtmlResource && !isInternalStaticAppUri(dir) && !insideStaticHtmlApp) {
			const app = await this.analyzeStaticHtml(dir, indexHtmlResource);
			if (app) {
				const appKey = app.rootUri.toString();
				if (!seenAppUris.has(appKey)) {
					seenAppUris.add(appKey);
					apps.push(app);
					registeredHtmlApp = true;
				}
			}
		}

		// Escaneo de subcarpetas - SIEMPRE seguimos, incluso si hay package.json,
		// para detectar apps anidadas como design-editor-src.
		const subdirs: URI[] = [];
		for (const child of children) {
			if (child.isDirectory && !IGNORED_DIRS.has(child.name)) {
				subdirs.push(child.resource);
			}
		}

		// Si el package.json tenia workspaces, priorizamos esas rutas.
		if (hasPackageJson && workspacePaths.length > 0) {
			for (const wsPath of workspacePaths) {
				const cleanPath = wsPath.replace(/\/\*$/, '');
				if (!cleanPath.includes('*')) {
					subdirs.push(URI.joinPath(dir, cleanPath));
				} else {
					const base = cleanPath.substring(0, cleanPath.lastIndexOf('/'));
					if (base) {
						subdirs.push(URI.joinPath(dir, base));
					}
				}
			}
		}

		for (const subdir of subdirs) {
			await this.scanFolderRecursive(subdir, seenUris, seenAppUris, apps, depth + 1, false, insideStaticHtmlApp || registeredHtmlApp);
		}
	}

	private async analyzePackageJson(dir: URI, isWorkspaceRoot: boolean, pkg: PackageJson): Promise<AnalyzedApp | null> {
		const deps: Record<string, string> = {
			...(pkg.dependencies ?? {}),
			...(pkg.devDependencies ?? {}),
		};
		const depNames = Object.keys(deps);
		const scripts: Record<string, string> = pkg.scripts ?? {};

		const stack: string[] = [];
		for (const rule of STACK_RULES) {
			const hasDep = rule.dependencies.some(d => depNames.includes(d));
			const hasFile = rule.files.length > 0 ? await this.hasAnyFile(dir, rule.files) : false;
			if (hasDep || hasFile) {
				stack.push(rule.tech);
			}
		}

		// Filtrar: solo apps web reales, no librerias/tests/tooling
		if (!isCandidateApp(pkg, stack, scripts, isWorkspaceRoot)) {
			return null;
		}

		const framework = detectFramework(stack);
		const devCommand = scripts['dev'] ?? scripts['start'] ?? null;
		const devPort = inferPort(framework, scripts);
		const hasReact = stack.includes('react');
		const hasJsxFiles = await this.hasJsxFiles(dir);
		const editable = hasReact && hasJsxFiles;

		let pages: AnalyzedAppPage[] = [];
		if (framework === 'nextjs') {
			pages = await this.scanNextPages(dir);
		} else {
			pages = [{ name: 'index', path: '/' }];
		}

		const reason = editable
			? undefined
			: (!hasReact ? 'No usa React' : !hasJsxFiles ? 'No encontro archivos JSX/TSX editables' : 'Framework no soportado');

		return {
			name: pkg.name || dir.path.split('/').pop() || 'app',
			rootUri: dir,
			framework,
			stack,
			devCommand,
			devPort,
			editable,
			pages,
			reason,
		};
	}

	private async hasAnyFile(dir: URI, files: string[]): Promise<boolean> {
		for (const name of files) {
			try {
				await this.fileService.resolve(URI.joinPath(dir, name));
				return true;
			} catch {
				// no-op
			}
		}
		return false;
	}

	private async hasJsxFiles(dir: URI): Promise<boolean> {
		for (const rootName of JSX_SEARCH_ROOTS) {
			const rootUri = URI.joinPath(dir, rootName);
			const found = await this.hasJsxFilesRecursive(rootUri, 0, { count: 0 });
			if (found) {
				return true;
			}
		}
		return false;
	}

	private async hasJsxFilesRecursive(dir: URI, depth: number, state: { count: number }): Promise<boolean> {
		if (depth > JSX_MAX_DEPTH || state.count > JSX_MAX_FILES) {
			return false;
		}

		let children;
		try {
			const stat = await this.fileService.resolve(dir);
			children = stat.children ?? [];
		} catch {
			return false;
		}

		for (const child of children) {
			if (state.count > JSX_MAX_FILES) {
				return false;
			}
			if (child.isDirectory) {
				if (IGNORED_DIRS.has(child.name)) {
					continue;
				}
				const found = await this.hasJsxFilesRecursive(child.resource, depth + 1, state);
				if (found) {
					return true;
				}
			} else if (child.isFile) {
				state.count++;
				const low = child.name.toLowerCase();
				if (low.endsWith('.tsx') || low.endsWith('.jsx')) {
					return true;
				}
			}
		}
		return false;
	}

	private async scanNextPages(dir: URI): Promise<AnalyzedAppPage[]> {
		const router = await this.detectRouterConfig(dir);
		if (!router) {
			return [{ name: 'index', path: '/' }];
		}
		if (router.type === 'app') {
			return this.scanAppRouter(dir, router.basePath);
		}
		return this.scanPagesRouter(dir, router.basePath);
	}

	private async detectRouterConfig(dir: URI): Promise<{ type: 'app' | 'pages'; basePath: string } | null> {
		for (const appPath of APP_ROUTER_PATHS) {
			try {
				const stat = await this.fileService.resolve(URI.joinPath(dir, appPath));
				const children = stat.children ?? [];
				const hasLayout = children.some(
					c => c.isFile && c.name.startsWith('layout.') && ALLOWED_PAGE_EXTS.some(ext => c.name.endsWith(ext))
				);
				if (hasLayout) {
					return { type: 'app', basePath: appPath };
				}
			} catch {
				// no-op
			}
		}
		for (const pagesPath of PAGES_ROUTER_PATHS) {
			try {
				const stat = await this.fileService.resolve(URI.joinPath(dir, pagesPath));
				const children = stat.children ?? [];
				const hasIndex = children.some(
					c => c.isFile && c.name.startsWith('index.') && ALLOWED_PAGE_EXTS.some(ext => c.name.endsWith(ext))
				);
				if (hasIndex) {
					return { type: 'pages', basePath: pagesPath };
				}
			} catch {
				// no-op
			}
		}
		return null;
	}

	private async scanAppRouter(dir: URI, basePath: string): Promise<AnalyzedAppPage[]> {
		const pages: AnalyzedAppPage[] = [];
		await this.scanAppRouterRecursive(dir, basePath, '', pages);
		return pages.length ? pages : [{ name: 'index', path: '/' }];
	}

	private async scanAppRouterRecursive(dir: URI, basePath: string, relativePath: string, pages: AnalyzedAppPage[]): Promise<void> {
		const currentDir = relativePath ? URI.joinPath(dir, basePath, relativePath) : URI.joinPath(dir, basePath);
		let children;
		try {
			const stat = await this.fileService.resolve(currentDir);
			children = stat.children ?? [];
		} catch {
			return;
		}

		const hasPage = children.some(
			c => c.isFile && c.name.startsWith('page.') && ALLOWED_PAGE_EXTS.some(ext => c.name.endsWith(ext))
		);

		if (hasPage) {
			const parts = relativePath.split('/').filter(Boolean);
			const last = parts[parts.length - 1] ?? '';
			const isDynamic = last.startsWith('[') && last.endsWith(']');
			const cleanPath = relativePath ? '/' + relativePath.replace(/\\/g, '/') : '/';
			pages.push({
				name: isDynamic ? last : (last || 'Home'),
				path: cleanPath,
			});
		}

		for (const child of children) {
			if (child.isDirectory && !['api', 'components', 'lib', 'utils', 'node_modules', 'hooks', 'types', 'context', 'store', 'services'].includes(child.name)) {
				const nextRelative = relativePath ? `${relativePath}/${child.name}` : child.name;
				await this.scanAppRouterRecursive(dir, basePath, nextRelative, pages);
			}
		}
	}

	private async scanPagesRouter(dir: URI, basePath: string): Promise<AnalyzedAppPage[]> {
		const pages: AnalyzedAppPage[] = [];
		await this.scanPagesRouterRecursive(dir, basePath, '', pages);
		return pages.length ? pages : [{ name: 'index', path: '/' }];
	}

	private async scanPagesRouterRecursive(dir: URI, basePath: string, relativePath: string, pages: AnalyzedAppPage[]): Promise<void> {
		const currentDir = relativePath ? URI.joinPath(dir, basePath, relativePath) : URI.joinPath(dir, basePath);
		let children;
		try {
			const stat = await this.fileService.resolve(currentDir);
			children = stat.children ?? [];
		} catch {
			return;
		}

		for (const child of children) {
			if (child.isDirectory && !['api', 'components', 'lib', 'utils', 'node_modules', 'hooks', 'types', 'context', 'store', 'services'].includes(child.name)) {
				const nextRelative = relativePath ? `${relativePath}/${child.name}` : child.name;
				await this.scanPagesRouterRecursive(dir, basePath, nextRelative, pages);
			}
		}

		for (const child of children) {
			if (!child.isDirectory) {
				const baseName = child.name.substring(0, child.name.lastIndexOf('.'));
				if (!baseName || !ALLOWED_PAGE_EXTS.some(ext => child.name.endsWith(ext))) {
					continue;
				}
				let cleanPath: string;
				if (baseName === 'index') {
					cleanPath = relativePath ? '/' + relativePath.replace(/\\/g, '/') : '/';
				} else {
					const rel = relativePath ? `${relativePath}/${baseName}` : baseName;
					cleanPath = '/' + rel.replace(/\\/g, '/');
				}
				pages.push({
					name: baseName === 'index' ? (relativePath ? relativePath.split('/').pop() || 'index' : 'Home') : baseName,
					path: cleanPath,
				});
			}
		}
	}

	private async analyzeStaticHtml(dir: URI, indexHtmlResource: URI): Promise<AnalyzedApp | null> {
		try {
			await this.fileService.resolve(indexHtmlResource);
		} catch {
			return null;
		}

		const stack: string[] = ['html'];
		if (await this.hasCssFiles(dir)) {
			stack.push('css');
		}

		const name = dir.path.split('/').pop() || 'app';

		// Real pages: every index.html (root + subfolders) plus standalone *.html files become
		// pages of THIS app. A folder of static HTML often has /index.html, /nav/index.html, etc.
		const pages: AnalyzedAppPage[] = [];
		await this.scanStaticHtmlPages(dir, '', 0, pages);
		// Root first ('/'), then alphabetical by path. Always keep at least Home.
		pages.sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path)));

		return {
			name,
			rootUri: dir,
			framework: 'html',
			stack,
			devCommand: null,
			devPort: null,
			editable: true,
			pages: pages.length ? pages : [{ name: 'Home', path: '/' }],
		};
	}

	/** Recursively collects static HTML pages: each index.html maps to its folder path, and other
	 *  *.html files map to their own path. Respects IGNORED_DIRS and a reasonable depth. */
	private async scanStaticHtmlPages(dir: URI, relativePath: string, depth: number, pages: AnalyzedAppPage[]): Promise<void> {
		if (depth > SCAN_MAX_DEPTH) {
			return;
		}
		let children;
		try {
			children = (await this.fileService.resolve(dir)).children ?? [];
		} catch {
			return;
		}

		for (const child of children) {
			if (!child.isFile) {
				continue;
			}
			const lower = child.name.toLowerCase();
			if (!lower.endsWith('.html')) {
				continue;
			}
			if (lower === 'index.html') {
				// index.html => the folder itself is a page.
				const path = relativePath === '' ? '/' : `/${relativePath}/`;
				const pageName = relativePath === '' ? 'Home' : this.prettyPageName(relativePath.split('/').pop() || 'page');
				pages.push({ name: pageName, path });
			} else {
				// e.g. about.html => its own page.
				const rel = relativePath === '' ? child.name : `${relativePath}/${child.name}`;
				pages.push({ name: this.prettyPageName(child.name.replace(/\.html$/i, '')), path: `/${rel}` });
			}
		}

		for (const child of children) {
			if (child.isDirectory && !IGNORED_DIRS.has(child.name) && !child.name.startsWith('.')) {
				const rel = relativePath === '' ? child.name : `${relativePath}/${child.name}`;
				await this.scanStaticHtmlPages(child.resource, rel, depth + 1, pages);
			}
		}
	}

	private prettyPageName(raw: string): string {
		const cleaned = raw.replace(/[-_]+/g, ' ').trim();
		if (!cleaned) {
			return 'Page';
		}
		return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}

	private async hasCssFiles(dir: URI): Promise<boolean> {
		try {
			const stat = await this.fileService.resolve(dir);
			const children = stat.children ?? [];
			for (const child of children) {
				if (child.isFile && child.name.toLowerCase().endsWith('.css')) {
					return true;
				}
			}
			// Buscar un nivel mas abajo
			for (const child of children) {
				if (child.isDirectory && !IGNORED_DIRS.has(child.name)) {
					try {
						const subStat = await this.fileService.resolve(child.resource);
						const subChildren = subStat.children ?? [];
						for (const sub of subChildren) {
							if (sub.isFile && sub.name.toLowerCase().endsWith('.css')) {
								return true;
							}
						}
					} catch {
						// no-op
					}
				}
			}
		} catch {
			// no-op
		}
		return false;
	}
}
