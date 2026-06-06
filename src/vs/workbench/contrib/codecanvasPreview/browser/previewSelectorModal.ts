/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/previewSelectorModal.css';
import { $, append, addDisposableListener, EventType, clearNode } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { timeout } from '../../../../base/common/async.js';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IBrowserViewCDPService, IBrowserViewModel, IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { createShinyText } from './shinyText.js';
import { CDPRequest, CDPResponse } from '../../../../platform/browserView/common/cdp/types.js';
import { ILogService } from '../../../../platform/log/common/log.js';

const THUMBNAIL_LOAD_TIMEOUT = 5000;
const THUMBNAIL_PAINT_TIMEOUT = 4000;
const THUMBNAIL_SETTLE_DELAY = 550;
const THUMBNAIL_NAVIGATION_DELAY = 120;
const THUMBNAIL_CAPTURE_ATTEMPTS = 3;
const THUMBNAIL_RETRY_ROUNDS = 4;
const THUMBNAIL_RETRY_DELAY = 450;
const COMPONENT_IGNORE_DIRS = new Set(['node_modules', 'out', 'dist', 'build', '.git', '.next', '.cache']);

// What the modal resolves with once the user picks a file (and optionally a section).
export interface IPreviewSelectorResult {
	readonly uri: URI;
	readonly anchor?: string;
	readonly componentFile?: string;
	readonly action: 'preview' | 'edit' | 'code';
}

interface ISectionModel {
	readonly anchor: string;          // "#hero" or a tag name like "footer"
	readonly name: string;            // friendly label, e.g. "Hero principal"
	readonly description: string;
	component?: string;               // best-effort component name (data-component / class)
	componentFile?: string;
	componentImportedIn?: string;
	componentDependencies?: string;
	readonly order: number;
}

interface IRouteModel {
	readonly href: string;
	readonly label: string;
}

interface IPageModel {
	readonly uri: URI;
	readonly rel: string;             // path relative to root, e.g. "src/index.html"
	readonly name: string;            // file name, e.g. "index.html"
	readonly dir: string;             // parent dir, e.g. "src/"
	parsed: boolean;
	sections: ISectionModel[];
	routes: IRouteModel[];
	thumbnailDataUrl?: string;
	readError?: string;
}

// Friendly Spanish labels inferred from a section id/class keyword.
const SECTION_LABELS: { readonly match: RegExp; readonly label: string }[] = [
	{ match: /hero|intro|banner/i, label: localize('cc.ps.sec.hero', "Hero principal") },
	{ match: /feature|benefit|beneficio/i, label: localize('cc.ps.sec.features', "Beneficios") },
	{ match: /template|plantilla/i, label: localize('cc.ps.sec.templates', "Plantillas") },
	{ match: /pric|precio|plan/i, label: localize('cc.ps.sec.pricing', "Precios") },
	{ match: /testimonial|review|opinion/i, label: localize('cc.ps.sec.testimonials', "Testimonios") },
	{ match: /faq|pregunta/i, label: localize('cc.ps.sec.faq', "Preguntas frecuentes") },
	{ match: /contact|contacto/i, label: localize('cc.ps.sec.contact', "Contacto") },
	{ match: /about|acerca|nosotros/i, label: localize('cc.ps.sec.about', "Acerca de") },
	{ match: /gallery|galer/i, label: localize('cc.ps.sec.gallery', "Galer\u00eda") },
	{ match: /cta|call.?to.?action|footer-cta/i, label: localize('cc.ps.sec.cta', "CTA final") },
	{ match: /footer|pie/i, label: localize('cc.ps.sec.footer', "Pie de p\u00e1gina") },
	{ match: /nav|header|menu/i, label: localize('cc.ps.sec.nav', "Navegaci\u00f3n") },
];

function friendlyName(anchor: string, headingText: string): string {
	for (const { match, label } of SECTION_LABELS) {
		if (match.test(anchor)) {
			return label;
		}
	}
	if (headingText) {
		return headingText.length > 40 ? headingText.slice(0, 40) + '\u2026' : headingText;
	}
	const bare = anchor.replace(/^#/, '');
	return bare.charAt(0).toUpperCase() + bare.slice(1);
}

function normalizeComponentName(value: string): string {
	return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
}

export class PreviewSelectorModal extends Disposable {

	private readonly modalDisposables = this._register(new DisposableStore());
	private overlay!: HTMLElement;
	private gridEl!: HTMLElement;
	private contextEl!: HTMLElement;
	private searchEl!: HTMLInputElement;
	private titleEl!: HTMLElement;

	private pages: IPageModel[] = [];
	private root: URI | undefined;
	private selected: IPageModel | undefined;
	private resolveFn: ((value: IPreviewSelectorResult | undefined) => void) | undefined;
	private disposedForOpen = false;
	private closing = false;
	private galleryCaptureInterrupted = false;
	private readonly thumbnailEls = new Map<string, HTMLElement[]>();
	private readonly sectionPreviewDataUrls = new Map<string, string>();
	private captureQueue = Promise.resolve();
	private readonly captureBrowserId = `codecanvas-preview-thumb-${Date.now()}`;
	private readonly sectionCaptureBrowserId = `codecanvas-preview-section-${Date.now()}`;
	private readonly activeCaptureInputs = new Set<BrowserEditorInput>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IBrowserViewCDPService private readonly browserViewCDPService: IBrowserViewCDPService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	open(pages: URI[], root: URI): Promise<IPreviewSelectorResult | undefined> {
		this.root = root;
		this.pages = pages.map(uri => this.toPageModel(uri, root));
		this.disposedForOpen = false;
		this.galleryCaptureInterrupted = false;
		this.thumbnailEls.clear();
		this.sectionPreviewDataUrls.clear();
		return new Promise<IPreviewSelectorResult | undefined>(resolve => {
			this.resolveFn = resolve;
			this.render();
			void this.capturePageThumbnails();
		});
	}

	private toPageModel(uri: URI, root: URI): IPageModel {
		const rel = uri.path.slice(root.path.length).replace(/^\/+/, '');
		const name = rel.split('/').pop() ?? rel;
		const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : './';
		return { uri, rel, name, dir, parsed: false, sections: [], routes: [] };
	}

	private render(): void {
		const container = this.layoutService.activeContainer;
		const workbenchBody = container.ownerDocument.body;
		workbenchBody.classList.add('cc-ps-selector-open');
		this.modalDisposables.add({ dispose: () => workbenchBody.classList.remove('cc-ps-selector-open') });

		this.overlay = append(container, $('.cc-ps-overlay'));
		this.modalDisposables.add({ dispose: () => this.overlay.remove() });

		const modal = append(this.overlay, $('.cc-ps-modal'));

		// Header: icon + title + subtitle + search + close.
		const header = append(modal, $('.cc-ps-header'));
		const heading = append(header, $('.cc-ps-heading'));
		append(heading, $(ThemeIcon.asCSSSelector(Codicon.sparkle) + '.cc-ps-heading-icon'));
		const headingText = append(heading, $('.cc-ps-heading-text'));
		this.titleEl = append(headingText, $('h2.cc-ps-title'));
		append(headingText, $('p.cc-ps-subtitle')).textContent =
			localize('cc.ps.subtitle', "Elige el archivo correcto viendo cada p\u00e1gina en vivo antes de abrirla.");

		const search = append(header, $('.cc-ps-search'));
		append(search, $(ThemeIcon.asCSSSelector(Codicon.search) + '.cc-ps-search-icon'));
		this.searchEl = append(search, $('input.cc-ps-search-input')) as HTMLInputElement;
		this.searchEl.type = 'text';
		this.searchEl.placeholder = localize('cc.ps.searchPlaceholder', "Filtrar previews\u2026");
		this.modalDisposables.add(addDisposableListener(this.searchEl, EventType.INPUT, () => this.filterCards()));

		const close = append(header, $('button.cc-ps-close'));
		append(close, $(ThemeIcon.asCSSSelector(Codicon.close)));
		const closeModal = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			void this.cancel();
		};
		this.modalDisposables.add(addDisposableListener(close, EventType.MOUSE_DOWN, e => {
			e.preventDefault();
			e.stopPropagation();
		}));
		this.modalDisposables.add(addDisposableListener(close, EventType.CLICK, closeModal));

		// Toolbar: tabs + count badge.
		const toolbar = append(modal, $('.cc-ps-toolbar'));
		const tab = append(toolbar, $('.cc-ps-tab.cc-ps-tab-active'));
		append(tab, $('span')).textContent = localize('cc.ps.tabFiles', "Archivos de entrada");
		append(tab, $('span.cc-ps-badge')).textContent = String(this.pages.length);

		// Body: grid (left) + context panel (right).
		const body = append(modal, $('.cc-ps-body'));
		this.gridEl = append(body, $('.cc-ps-grid'));
		this.contextEl = append(body, $('.cc-ps-context'));

		this.updateTitle();
		this.renderCards();
		this.renderEmptyContext();

		// Dismiss on backdrop click or Escape.
		this.modalDisposables.add(addDisposableListener(this.overlay, EventType.MOUSE_DOWN, e => {
			if (e.target === this.overlay) {
				void this.cancel();
			}
		}));
		this.modalDisposables.add(addDisposableListener(this.overlay, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				if (this.selected) {
					this.backToFiles();
				} else {
					void this.cancel();
				}
			}
		}));

		this.overlay.tabIndex = -1;
		this.overlay.focus();
	}

	private updateTitle(): void {
		this.titleEl.textContent = localize(
			'cc.ps.title', "Se detectaron {0} archivos de entrada en tu proyecto", this.pages.length);
	}

	private renderCards(): void {
		clearNode(this.gridEl);
		for (const page of this.pages) {
			const card = append(this.gridEl, $('.cc-ps-card'));
			card.setAttribute('data-name', page.name.toLowerCase());

			const thumb = append(card, $('.cc-ps-thumb'));
			const imgLayer = append(thumb, $('.cc-ps-thumb-img'));
			this.registerThumbnailElement(page, imgLayer);
			const loading = append(thumb, $('.cc-ps-thumb-loading'));
			loading.appendChild(createShinyText(page.name, { speed: 2.2, color: '#9fb3d6', shineColor: '#ffffff' }));
			const live = append(thumb, $('.cc-ps-live'));
			append(live, $('span.cc-ps-live-dot'));
			append(live, $('span')).textContent = localize('cc.ps.live', "Live");

			const footer = append(card, $('.cc-ps-card-footer'));
			const meta = append(footer, $('.cc-ps-card-meta'));
			append(meta, $('span.cc-ps-card-name')).textContent = page.name;
			append(meta, $('span.cc-ps-card-path')).textContent = `${page.dir} \u00b7 1280 \u00d7 800`;
			append(footer, $(ThemeIcon.asCSSSelector(Codicon.ellipsis) + '.cc-ps-card-more'));

			this.modalDisposables.add(addDisposableListener(card, EventType.CLICK, () => this.selectPage(page, card)));
		}
	}

	private filterCards(): void {
		const term = this.searchEl.value.trim().toLowerCase();
		for (const card of this.gridEl.children) {
			const name = (card as HTMLElement).getAttribute('data-name') ?? '';
			(card as HTMLElement).classList.toggle('cc-ps-hidden', !!term && !name.includes(term));
		}
	}

	private async selectPage(page: IPageModel, card: HTMLElement): Promise<void> {
		this.selected = page;
		// The grid reflows when the context panel opens, so stop the gallery capture and hide
		// its view at once; otherwise it keeps painting over stale card positions ("in the sky").
		this.galleryCaptureInterrupted = true;
		this.hideActiveCaptureSurfaces();
		for (const c of this.gridEl.children) {
			c.classList.toggle('cc-ps-card-selected', c === card);
		}
		this.overlay.classList.add('cc-ps-has-context');
		if (!page.parsed) {
			await this.parsePage(page);
		}
		this.renderSections(page);
	}

	private async parsePage(page: IPageModel): Promise<void> {
		let text = '';
		page.readError = undefined;
		try {
			text = await this.readPageText(page.uri);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			page.readError = message;
			this.logService.error(`[PreviewSelectorModal] Failed to read preview page ${page.uri.toString()}: ${message}`);
		}

		const sections: ISectionModel[] = [];
		const routes: IRouteModel[] = [];

		// Prefer DOM parsing, but never let a DOMParser failure skip the text fallback.
		try {
			const doc = new DOMParser().parseFromString(text, 'text/html');
			const seen = new Set<string>();
			// eslint-disable-next-line no-restricted-syntax
			doc.querySelectorAll('section, header, footer, main, nav, [id]').forEach(el => {
				const tag = el.tagName.toLowerCase();
				if (['script', 'style', 'meta', 'link', 'head'].includes(tag)) {
					return;
				}
				const id = el.getAttribute('id') ?? '';
				const anchor = id ? `#${id}` : tag;
				if (seen.has(anchor)) {
					return;
				}
				seen.add(anchor);
				// eslint-disable-next-line no-restricted-syntax
				const heading = el.querySelector('h1, h2, h3')?.textContent?.trim() ?? '';
				// eslint-disable-next-line no-restricted-syntax
				const paragraph = el.querySelector('p')?.textContent?.trim() ?? '';
				sections.push({
					anchor,
					name: friendlyName(anchor || tag, heading),
					description: paragraph ? (paragraph.length > 60 ? paragraph.slice(0, 60) + '\u2026' : paragraph) : tag,
					component: el.getAttribute('data-component') ?? undefined,
					order: sections.length + 1,
				});
			});

			const seenHref = new Set<string>();
			// eslint-disable-next-line no-restricted-syntax
			doc.querySelectorAll('a[href]').forEach(a => {
				const href = a.getAttribute('href') ?? '';
				if (!href || /^(https?:|mailto:|tel:)/i.test(href) || seenHref.has(href)) {
					return;
				}
				seenHref.add(href);
				routes.push({ href, label: (a.textContent?.trim() || href).slice(0, 40) });
			});
		} catch {
			// DOMParser unavailable in this context; covered by the text fallbacks below.
		}

		// Text-based fallback: runs whenever DOM parsing threw or found nothing.
		if (sections.length === 0) {
			sections.push(...this.detectSectionsFromText(text));
		}
		if (routes.length === 0) {
			routes.push(...this.detectRoutesFromText(text));
		}

		page.sections = sections.slice(0, 12);
		page.routes = routes.slice(0, 12);

		try {
			await this.enrichSectionsWithComponents(page);
		} catch {
			// Component metadata is optional; keep the detected sections.
		}
		page.parsed = true;
	}

	private detectRoutesFromText(text: string): IRouteModel[] {
		const routes: IRouteModel[] = [];
		const seen = new Set<string>();
		for (const match of text.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
			const href = match[1];
			if (!href || /^(https?:|mailto:|tel:)/i.test(href) || seen.has(href)) {
				continue;
			}
			seen.add(href);
			const label = stripTags(match[2] ?? '').trim() || href;
			routes.push({ href, label: label.slice(0, 40) });
		}
		return routes;
	}

	private async readPageText(uri: URI): Promise<string> {
		try {
			return (await this.fileService.readFile(uri)).value.toString();
		} catch {
			const response = await fetch(uri.toString());
			if (!response.ok) {
				throw new Error(`Unable to read preview page: ${uri.toString()}`);
			}
			return response.text();
		}
	}

	private detectSectionsFromText(text: string): ISectionModel[] {
		const sections: ISectionModel[] = [];
		const seen = new Set<string>();
		const pattern = /<([a-z][\w:-]*)\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
		for (const match of text.matchAll(pattern)) {
			const tag = match[1].toLowerCase();
			if (['script', 'style', 'meta', 'link', 'head'].includes(tag)) {
				continue;
			}
			const id = match[2];
			if (!id || seen.has(id)) {
				continue;
			}
			seen.add(id);
			const body = match[3] ?? '';
			const heading = stripTags(body.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ?? '').trim();
			const paragraph = stripTags(body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '').trim();
			const anchor = `#${id}`;
			sections.push({
				anchor,
				name: friendlyName(anchor, heading),
				description: paragraph ? (paragraph.length > 60 ? paragraph.slice(0, 60) + '\u2026' : paragraph) : tag,
				order: sections.length + 1,
			});
		}
		return sections;
	}

	private async enrichSectionsWithComponents(page: IPageModel): Promise<void> {
		if (!this.root) {
			return;
		}
		for (const section of page.sections) {
			if (!section.anchor.startsWith('#') || section.componentFile) {
				continue;
			}
			const component = await this.findComponentForSection(this.root, section.anchor.slice(1));
			if (!component) {
				continue;
			}
			section.component = section.component ?? component.name;
			section.componentFile = component.rel;
			section.componentImportedIn = component.importedIn;
			section.componentDependencies = component.dependencies;
		}
	}

	private async findComponentForSection(root: URI, id: string): Promise<{ name: string; rel: string; importedIn?: string; dependencies?: string } | undefined> {
		const src = URI.joinPath(root, 'src');
		if (!await this.fileService.exists(src)) {
			return undefined;
		}

		const normalizedId = normalizeComponentName(id);
		const candidates = await this.findComponentCandidates(src, normalizedId);
		if (candidates.length !== 1) {
			return undefined;
		}

		const component = candidates[0];
		const rel = component.path.slice(root.path.length).replace(/^\/+/, '');
		let text: string;
		try {
			const content = await this.fileService.readFile(component);
			text = content.value.toString();
		} catch {
			return undefined;
		}
		const dependencies = this.extractImportDependencies(text);
		const importedIn = await this.findImporter(src, component, root);
		return {
			name: component.path.split('/').pop()?.replace(/\.[jt]sx$/, '') ?? id,
			rel,
			importedIn,
			dependencies
		};
	}

	private async findComponentCandidates(root: URI, normalizedId: string): Promise<URI[]> {
		const matches: URI[] = [];
		const queue: URI[] = [root];
		while (queue.length > 0) {
			const current = queue.shift()!;
			let stat;
			try {
				stat = await this.fileService.resolve(current);
			} catch {
				continue;
			}
			for (const child of stat.children ?? []) {
				if (child.isDirectory) {
					if (!COMPONENT_IGNORE_DIRS.has(child.name)) {
						queue.push(child.resource);
					}
					continue;
				}
				if (!/\.[jt]sx$/.test(child.name)) {
					continue;
				}
				const base = child.name.replace(/\.[jt]sx$/, '');
				if (normalizeComponentName(base) === normalizedId) {
					matches.push(child.resource);
				}
			}
		}
		return matches;
	}

	private async findImporter(src: URI, component: URI, root: URI): Promise<string | undefined> {
		const basename = component.path.split('/').pop()?.replace(/\.[jt]sx$/, '');
		if (!basename) {
			return undefined;
		}
		const queue: URI[] = [src];
		while (queue.length > 0) {
			const current = queue.shift()!;
			let stat;
			try {
				stat = await this.fileService.resolve(current);
			} catch {
				continue;
			}
			for (const child of stat.children ?? []) {
				if (child.isDirectory) {
					if (!COMPONENT_IGNORE_DIRS.has(child.name)) {
						queue.push(child.resource);
					}
					continue;
				}
				if (child.resource.toString() === component.toString() || !/\.[jt]sx$/.test(child.name)) {
					continue;
				}
				let text: string;
				try {
					text = (await this.fileService.readFile(child.resource)).value.toString();
				} catch {
					continue;
				}
				if (new RegExp(`from\\s+['"][^'"]*${escapeRegExp(basename)}['"]`).test(text)) {
					return child.resource.path.slice(root.path.length).replace(/^\/+/, '');
				}
			}
		}
		return undefined;
	}

	private extractImportDependencies(text: string): string | undefined {
		const deps = new Set<string>();
		for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
			const dep = match[1];
			if (!dep.startsWith('.')) {
				deps.add(dep);
			}
		}
		return deps.size > 0 ? Array.from(deps).slice(0, 4).join(', ') : undefined;
	}

	private renderEmptyContext(): void {
		clearNode(this.contextEl);
		const empty = append(this.contextEl, $('.cc-ps-context-empty'));
		append(empty, $(ThemeIcon.asCSSSelector(Codicon.listSelection) + '.cc-ps-context-empty-icon'));
		append(empty, $('p')).textContent =
			localize('cc.ps.pickFile', "Selecciona un archivo para ver sus secciones.");
	}

	// Step 2: file selected -> show its sections / routes.
	private renderSections(page: IPageModel): void {
		clearNode(this.contextEl);

		const head = append(this.contextEl, $('.cc-ps-ctx-head'));
		const back = append(head, $('button.cc-ps-back'));
		append(back, $(ThemeIcon.asCSSSelector(Codicon.arrowLeft)));
		append(back, $('span')).textContent = localize('cc.ps.back', "Volver a archivos");
		this.modalDisposables.add(addDisposableListener(back, EventType.CLICK, () => this.backToFiles()));

		append(head, $('h3.cc-ps-ctx-title')).textContent = page.name;
		append(head, $('p.cc-ps-ctx-path')).textContent = page.rel;
		append(head, $('p.cc-ps-ctx-step')).textContent =
			localize('cc.ps.step2', "Paso 2 de 2 \u2014 elige qu\u00e9 quieres abrir");

		const tabs = append(this.contextEl, $('.cc-ps-ctx-tabs'));
		const secTab = append(tabs, $('.cc-ps-ctx-tab.cc-ps-ctx-tab-active'));
		append(secTab, $('span')).textContent = localize('cc.ps.tabSections', "Secciones");
		append(secTab, $('span.cc-ps-badge')).textContent = String(page.sections.length);
		const routeTab = append(tabs, $('.cc-ps-ctx-tab'));
		append(routeTab, $('span')).textContent = localize('cc.ps.tabRoutes', "Rutas");
		append(routeTab, $('span.cc-ps-badge')).textContent = String(page.routes.length);

		const list = append(this.contextEl, $('.cc-ps-ctx-list'));
		const renderSecList = () => {
			clearNode(list);
			if (page.readError) {
				append(list, $('p.cc-ps-ctx-note')).textContent =
					localize('cc.ps.readError', "No se pudo leer este archivo. Revisa que siga existiendo y vuelve a intentarlo.");
				return;
			}
			if (page.sections.length === 0) {
				append(list, $('p.cc-ps-ctx-note')).textContent =
					localize('cc.ps.noSections', "No se detectaron secciones en este archivo.");
				return;
			}
			for (const section of page.sections) {
				const item = append(list, $('.cc-ps-sec'));
				const sthumb = append(item, $('.cc-ps-sec-thumb'));
				this.registerThumbnailElement(page, sthumb);
				const info = append(item, $('.cc-ps-sec-info'));
				const top = append(info, $('.cc-ps-sec-top'));
				append(top, $('span.cc-ps-sec-anchor')).textContent = section.anchor;
				append(top, $('span.cc-ps-sec-name')).textContent = section.name;
				append(info, $('span.cc-ps-sec-desc')).textContent = section.description;
				const open = append(item, $('button.cc-ps-sec-open'));
				open.textContent = localize('cc.ps.view', "Ver");
				this.modalDisposables.add(addDisposableListener(item, EventType.CLICK, () => this.renderSectionDetail(page, section)));
			}
		};
		const renderRouteList = () => {
			clearNode(list);
			if (page.readError) {
				append(list, $('p.cc-ps-ctx-note')).textContent =
					localize('cc.ps.readErrorRoutes', "No se pudieron leer las rutas de este archivo.");
				return;
			}
			if (page.routes.length === 0) {
				append(list, $('p.cc-ps-ctx-note')).textContent =
					localize('cc.ps.noRoutes', "No se detectaron rutas internas en este archivo.");
				return;
			}
			for (const route of page.routes) {
				const item = append(list, $('.cc-ps-route'));
				append(item, $(ThemeIcon.asCSSSelector(Codicon.link) + '.cc-ps-route-icon'));
				const info = append(item, $('.cc-ps-sec-info'));
				append(info, $('span.cc-ps-sec-name')).textContent = route.label;
				append(info, $('span.cc-ps-sec-desc')).textContent = route.href;
			}
		};
		renderSecList();

		this.modalDisposables.add(addDisposableListener(secTab, EventType.CLICK, () => {
			secTab.classList.add('cc-ps-ctx-tab-active');
			routeTab.classList.remove('cc-ps-ctx-tab-active');
			renderSecList();
		}));
		this.modalDisposables.add(addDisposableListener(routeTab, EventType.CLICK, () => {
			routeTab.classList.add('cc-ps-ctx-tab-active');
			secTab.classList.remove('cc-ps-ctx-tab-active');
			renderRouteList();
		}));
	}

	// Step 3: section selected -> detail with a larger preview, actions and metadata.
	private renderSectionDetail(page: IPageModel, section: ISectionModel): void {
		clearNode(this.contextEl);

		const head = append(this.contextEl, $('.cc-ps-ctx-head'));
		const back = append(head, $('button.cc-ps-back'));
		append(back, $(ThemeIcon.asCSSSelector(Codicon.arrowLeft)));
		append(back, $('span')).textContent = localize('cc.ps.backSections', "Volver a secciones");
		this.modalDisposables.add(addDisposableListener(back, EventType.CLICK, () => this.renderSections(page)));

		append(head, $('h3.cc-ps-ctx-title')).textContent = section.name;
		append(head, $('p.cc-ps-ctx-path')).textContent = section.anchor;
		if (section.component) {
			append(head, $('p.cc-ps-ctx-comp')).textContent = section.component;
		}

		const big = append(this.contextEl, $('.cc-ps-detail-preview'));
		const bigImg = append(big, $('.cc-ps-thumb-img'));
		const bigLoading = append(big, $('.cc-ps-thumb-loading'));
		bigLoading.appendChild(createShinyText(localize('cc.ps.loadingSection', "Generando vista"), { speed: 2.2, color: '#9fb3d6', shineColor: '#ffffff' }));
		const sectionPreview = this.sectionPreviewDataUrls.get(this.sectionPreviewKey(page, section));
		if (sectionPreview) {
			this.applyThumbnail(bigImg, sectionPreview);
		} else {
			void this.captureSectionPreview(page, section, bigImg);
		}

		const actions = append(this.contextEl, $('.cc-ps-detail-actions'));
		const addAction = (icon: ThemeIcon, label: string, primary: boolean, run: () => void) => {
			const btn = append(actions, $(`button.cc-ps-action${primary ? '.cc-ps-action-primary' : ''}`));
			append(btn, $(ThemeIcon.asCSSSelector(icon)));
			append(btn, $('span')).textContent = label;
			this.modalDisposables.add(addDisposableListener(btn, EventType.CLICK, run));
		};
		addAction(Codicon.eye, localize('cc.ps.openPreview', "Abrir en preview"), true,
			() => void this.finish({ uri: page.uri, anchor: section.anchor.startsWith('#') ? section.anchor : undefined, action: 'preview' }));
		addAction(Codicon.edit, localize('cc.ps.editSection', "Editar secci\u00f3n"), false,
			() => void this.finish({ uri: page.uri, anchor: section.anchor.startsWith('#') ? section.anchor : undefined, action: 'edit' }));
		addAction(Codicon.code, localize('cc.ps.goToCode', "Ir al c\u00f3digo"), false,
			() => void this.finish({ uri: page.uri, anchor: section.anchor.startsWith('#') ? section.anchor : undefined, componentFile: section.componentFile, action: 'code' }));
		addAction(Codicon.link, localize('cc.ps.copyLink', "Copiar enlace"), false,
			() => this.copyLink(page, section));

		// Metadata block.
		const meta = append(this.contextEl, $('.cc-ps-detail-meta'));
		const addMeta = (key: string, value: string) => {
			const row = append(meta, $('.cc-ps-meta-row'));
			append(row, $('span.cc-ps-meta-key')).textContent = key;
			append(row, $('span.cc-ps-meta-val')).textContent = value;
		};
		addMeta(localize('cc.ps.metaFile', "Archivo"), page.rel);
		addMeta(localize('cc.ps.metaDom', "ID en el DOM"), section.anchor);
		addMeta(localize('cc.ps.metaOrder', "Orden en la p\u00e1gina"), `${section.order} / ${page.sections.length}`);
		if (section.component) {
			addMeta(localize('cc.ps.metaComponent', "Componente"), section.component);
		}
		if (section.componentFile) {
			addMeta(localize('cc.ps.metaComponentFile', "Archivo de componente"), section.componentFile);
		}
		if (section.componentImportedIn) {
			addMeta(localize('cc.ps.metaImportedIn', "Importada en"), section.componentImportedIn);
		}
		if (section.componentDependencies) {
			addMeta(localize('cc.ps.metaDependencies', "Dependencias"), section.componentDependencies);
		}
	}

	private registerThumbnailElement(page: IPageModel, element: HTMLElement): void {
		const key = page.uri.toString();
		const elements = this.thumbnailEls.get(key) ?? [];
		elements.push(element);
		this.thumbnailEls.set(key, elements);
		if (page.thumbnailDataUrl) {
			this.applyThumbnail(element, page.thumbnailDataUrl);
		}
	}

	private applyThumbnail(element: HTMLElement, dataUrl: string): void {
		// The registered element is the image layer; fade it in and hide the loading screen.
		element.style.backgroundImage = `url("${dataUrl}")`;
		element.classList.add('cc-ps-img-ready');
		element.parentElement?.classList.add('cc-ps-thumb-loaded');
	}

	private sectionPreviewKey(page: IPageModel, section: ISectionModel): string {
		return `${page.uri.toString()}${section.anchor}`;
	}

	private enqueueCapture<T>(task: () => Promise<T>): Promise<T> {
		const next = this.captureQueue.then(task, task);
		this.captureQueue = next.then(() => undefined, () => undefined);
		return next;
	}

	private async capturePageThumbnails(): Promise<void> {
		void this.enqueueCapture(async () => {
			if (this.disposedForOpen || this.pages.length === 0) {
				return;
			}
			const input = this.browserViewWorkbenchService.getOrCreateLazy(this.captureBrowserId, {
				title: localize('cc.ps.thumbBrowserTitle', "Capturas de previews")
			});
			this.activeCaptureInputs.add(input);
			try {
				const model = await input.resolve();
				// First pass: capture every card in order.
				for (const page of this.pages) {
					if (this.disposedForOpen || this.galleryCaptureInterrupted) {
						return;
					}
					await this.capturePageInto(input.id, model, page);
				}
				// Second pass: retry any card that did not get a thumbnail (e.g. a page that
				// had not painted yet on the first try). This is what makes the last card reliable.
				for (const page of this.pages) {
					if (this.disposedForOpen || this.galleryCaptureInterrupted) {
						return;
					}
					if (!page.thumbnailDataUrl) {
						await this.capturePageInto(input.id, model, page);
					}
				}
				// Later passes: by this point the modal/grid has finished its first paint. This
				// catches the occasional card whose WebContentsView did navigate but did not
				// produce a bitmap during the immediate passes.
				for (let round = 0; round < THUMBNAIL_RETRY_ROUNDS; round++) {
					const pending = this.pages.filter(page => !page.thumbnailDataUrl);
					if (pending.length === 0 || this.disposedForOpen || this.galleryCaptureInterrupted) {
						return;
					}
					await timeout(THUMBNAIL_RETRY_DELAY * (round + 1));
					for (const page of pending) {
						if (this.disposedForOpen || this.galleryCaptureInterrupted) {
							return;
						}
						await this.capturePageInto(input.id, model, page);
					}
				}

			} catch (error) {
				this.logService.warn('[PreviewSelectorModal] Could not create thumbnail capture view.', error);
			} finally {
				await this.disposeCaptureInput(input);
				this.activeCaptureInputs.delete(input);
			}
		});
	}

	// Capture a single page into its card. Safe to call again to retry a card that failed.
	private async capturePageInto(browserId: string, model: IBrowserViewModel, page: IPageModel): Promise<boolean> {
		if (this.disposedForOpen || this.galleryCaptureInterrupted || page.thumbnailDataUrl) {
			return false;
		}
		const card = this.thumbnailEls.get(page.uri.toString())?.[0];
		if (!card) {
			return false;
		}

		let lastError: unknown;
		for (let attempt = 1; attempt <= THUMBNAIL_CAPTURE_ATTEMPTS; attempt++) {
			try {
				if (this.disposedForOpen || this.galleryCaptureInterrupted || page.thumbnailDataUrl) {
					return false;
				}
				if (!await this.layoutCaptureOver(model, card)) {
					return false;
				}
				await this.navigateForCapture(model, this.toCaptureUrl(page.uri), attempt > 1);
				if (this.disposedForOpen || this.galleryCaptureInterrupted) {
					return false;
				}
				await timeout(THUMBNAIL_NAVIGATION_DELAY * attempt);
				const dataUrl = await this.captureVisiblePage(browserId, model, 60);
				page.thumbnailDataUrl = dataUrl;
				for (const element of this.thumbnailEls.get(page.uri.toString()) ?? []) {
					this.applyThumbnail(element, dataUrl);
				}
				return true;
			} catch (error) {
				lastError = error;
				await timeout(THUMBNAIL_RETRY_DELAY * attempt);
			}
		}

		this.logService.warn('[PreviewSelectorModal] Failed to capture preview thumbnail.', lastError);
		return false;
	}

	private async captureSectionPreview(page: IPageModel, section: ISectionModel, element: HTMLElement): Promise<void> {
		if (!section.anchor.startsWith('#')) {
			return;
		}
		const key = this.sectionPreviewKey(page, section);
		void this.enqueueCapture(async () => {
			if (this.disposedForOpen) {
				return;
			}
			const input = this.browserViewWorkbenchService.getOrCreateLazy(this.sectionCaptureBrowserId, {
				title: localize('cc.ps.thumbBrowserTitle', "Capturas de previews")
			});
			this.activeCaptureInputs.add(input);
			try {
				const model = await input.resolve();
				if (!await this.layoutCaptureOver(model, element)) {
					return;
				}
				await this.navigateForCapture(model, this.toCaptureUrl(page.uri));
				if (this.disposedForOpen) {
					return;
				}
				const dataUrl = await this.captureElementByIdWithCDP(input.id, section.anchor.slice(1));
				this.sectionPreviewDataUrls.set(key, dataUrl);
				this.applyThumbnail(element, dataUrl);
			} catch (error) {
				this.logService.warn('[PreviewSelectorModal] Failed to capture section preview.', error);
			} finally {
				await this.disposeCaptureInput(input);
				this.activeCaptureInputs.delete(input);
			}
		});
	}

	// Force-hide and dispose any capture views still alive, even if their task is stuck
	// awaiting, so no native BrowserView lingers over the workbench after the modal closes.
	private async stopCaptures(): Promise<void> {
		await Promise.all([...this.activeCaptureInputs].map(input => this.disposeCaptureInput(input)));
		this.activeCaptureInputs.clear();

		// The capture queue may still contain tasks that were already scheduled before the
		// user clicked an action. Wait briefly so their finally blocks can run and remove
		// any WebContentsView before the real preview/code view is shown.
		await Promise.race([
			this.captureQueue,
			timeout(1500)
		]).catch(() => { });
	}

	private async disposeCaptureInput(input: BrowserEditorInput): Promise<void> {
		let model = input.model;
		if (!model && !input.isDisposed()) {
			try {
				model = await Promise.race([
					input.resolve(),
					timeout(750).then(() => undefined)
				]);
			} catch {
				// The model may be mid-dispose or fail to resolve during shutdown.
			}
		}

		if (model) {
			try {
				await model.setVisible(false);
			} catch {
				// ignore
			}

			const closed = Event.toPromise(model.onDidClose).catch(() => undefined);
			try {
				input.dispose(true);
			} catch {
				// ignore
			}
			await Promise.race([
				closed,
				timeout(750)
			]).catch(() => { });
			return;
		}

		try {
			input.dispose(true);
		} catch {
			// ignore
		}
	}

	private async navigateForCapture(model: IBrowserViewModel, url: string, forceReload = false): Promise<void> {
		const didNavigate = Event.toPromise(Event.filter(model.onDidNavigate, event => this.isSameCaptureUrl(event.url, url)));
		try {
			if (forceReload && this.isSameCaptureUrl(model.url, url)) {
				await model.reload(true);
			} else {
				await model.loadURL(url);
			}
		} catch (error) {
			if (!this.isExpectedNavigationAbort(error)) {
				throw error;
			}
		}
		if (!this.isSameCaptureUrl(model.url, url)) {
			await Promise.race([
				didNavigate,
				timeout(THUMBNAIL_LOAD_TIMEOUT).then(() => { throw new Error(`Timed out navigating preview capture to ${url}`); })
			]);
		}
		await timeout(THUMBNAIL_NAVIGATION_DELAY);
		await this.waitForPageIdle(model);
	}

	private isExpectedNavigationAbort(error: unknown): boolean {
		return error instanceof Error && error.message.includes('ERR_ABORTED');
	}

	private isSameCaptureUrl(actual: string, expected: string): boolean {
		return actual === expected || actual.toLocaleLowerCase() === expected.toLocaleLowerCase();
	}

	private toCaptureUrl(uri: URI): string {
		if (uri.scheme !== 'file') {
			return uri.toString();
		}
		const normalizedPath = uri.fsPath.replace(/\\/g, '/');
		const encodedPath = normalizedPath
			.replace(/#/g, '%23')
			.replace(/\?/g, '%3F')
			.replace(/ /g, '%20');
		return `file:///${encodedPath}`;
	}

	// Position the (necessarily visible) capture view exactly over a target element so it
	// renders the live page INSIDE that card/preview slot instead of as a floating box.
	// A fully off-screen view does not paint (captures black), so it must overlap the slot.
	private async layoutCaptureOver(model: IBrowserViewModel, element: HTMLElement): Promise<boolean> {
		const host = this.layoutService.activeContainer.getBoundingClientRect();
		const rect = element.getBoundingClientRect();
		if (rect.width < 2 || rect.height < 2) {
			return false;
		}
		await model.layout({
			windowId: mainWindow.vscodeWindowId,
			x: Math.round(rect.left - host.left),
			y: Math.round(rect.top - host.top),
			width: Math.max(1, Math.round(rect.width)),
			height: Math.max(1, Math.round(rect.height)),
			zoomFactor: 1,
			cornerRadius: 0
		});
		await model.setVisible(true);
		return true;
	}

	private async captureVisiblePage(browserId: string, model: IBrowserViewModel, quality: number): Promise<string> {
		try {
			const screenshot = await Promise.race([
				model.captureScreenshot({ format: 'jpeg', quality, awaitNextPaint: true }),
				timeout(THUMBNAIL_PAINT_TIMEOUT).then(() => { throw new Error('Thumbnail paint capture timed out.'); })
			]);
			return `data:image/jpeg;base64,${encodeBase64(screenshot)}`;
		} catch (firstError) {
			await timeout(THUMBNAIL_SETTLE_DELAY);
			try {
				const screenshot = await model.captureScreenshot({ format: 'jpeg', quality });
				return `data:image/jpeg;base64,${encodeBase64(screenshot)}`;
			} catch (secondError) {
				try {
					return await this.captureViewportWithCDP(browserId, quality);
				} catch (thirdError) {
					throw new Error(`Thumbnail capture failed after retry: ${firstError instanceof Error ? firstError.message : String(firstError)}; ${secondError instanceof Error ? secondError.message : String(secondError)}; ${thirdError instanceof Error ? thirdError.message : String(thirdError)}`);
				}
			}
		}
	}

	private async captureViewportWithCDP(browserId: string, quality: number): Promise<string> {
		return this.withPageSession(browserId, async send => {
			const captured = await send<{ data: string }>('Page.captureScreenshot', {
				format: 'jpeg',
				quality,
				captureBeyondViewport: false
			});
			return `data:image/jpeg;base64,${captured.data}`;
		});
	}

	private async captureElementByIdWithCDP(browserId: string, elementId: string): Promise<string> {
		return this.withPageSession(browserId, async send => {
			const expression = `
				(() => {
					const element = document.getElementById(${JSON.stringify(elementId)});
					if (!element) { return undefined; }
					element.scrollIntoView({ block: 'center', inline: 'nearest' });
					const rect = element.getBoundingClientRect();
					return {
						x: rect.left + window.scrollX,
						y: rect.top + window.scrollY,
						width: rect.width,
						height: rect.height
					};
				})()
			`;
			type EvaluateResult = { result?: { value?: { x: number; y: number; width: number; height: number } } };
			const evaluated = await send<EvaluateResult>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
			const rect = evaluated.result?.value;
			if (!rect || rect.width <= 0 || rect.height <= 0) {
				throw new Error('Element rect is empty.');
			}
			const captured = await send<{ data: string }>('Page.captureScreenshot', {
				format: 'jpeg',
				quality: 70,
				captureBeyondViewport: true,
				clip: {
					x: Math.max(0, rect.x - 24),
					y: Math.max(0, rect.y - 24),
					width: Math.max(1, rect.width + 48),
					height: Math.max(1, rect.height + 48),
					scale: 1
				}
			});
			return `data:image/jpeg;base64,${captured.data}`;
		});
	}

	private async withPageSession<T>(browserId: string, run: (send: <V>(method: string, params?: unknown) => Promise<V>) => Promise<T>): Promise<T> {
		const groupId = await this.browserViewCDPService.createSessionGroup(browserId);
		let nextId = 1;
		let sessionId: string | undefined;
		try {
			const onMessage = this.browserViewCDPService.onCDPMessage(groupId);
			const sendRaw = async <V>(method: string, params?: unknown, targetSessionId?: string): Promise<V> => {
				const id = nextId++;
				const response = Event.toPromise(Event.filter(onMessage, (message): message is CDPResponse => {
					return 'id' in message && message.id === id;
				}));
				const request: CDPRequest = { id, method, params, sessionId: targetSessionId };
				await this.browserViewCDPService.sendCDPMessage(groupId, request);
				const result = await Promise.race([
					response,
					timeout(THUMBNAIL_LOAD_TIMEOUT).then(() => { throw new Error(`CDP command timed out: ${method}`); })
				]) as CDPResponse;
				if (result.error) {
					throw new Error(result.error.message);
				}
				return result.result as V;
			};

			type TargetResult = { targetInfos?: readonly { targetId: string; type: string }[] };
			const targets = await sendRaw<TargetResult>('Target.getTargets');
			const target = targets.targetInfos?.find(info => info.type === 'page') ?? targets.targetInfos?.[0];
			if (!target) {
				throw new Error('No CDP target available for preview capture.');
			}
			const attached = await sendRaw<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
			sessionId = attached.sessionId;
			const send = <V>(method: string, params?: unknown) => sendRaw<V>(method, params, sessionId);
			return await run(send);
		} finally {
			if (sessionId) {
				await this.browserViewCDPService.sendCDPMessage(groupId, {
					id: nextId++,
					method: 'Target.detachFromTarget',
					params: { sessionId }
				}).catch(() => { });
			}
			await this.browserViewCDPService.destroySessionGroup(groupId).catch(() => { });
		}
	}

	private async waitForPageIdle(model: { readonly loading: boolean; readonly onDidChangeLoadingState: Event<{ readonly loading: boolean }> }): Promise<void> {
		if (model.loading) {
			await Promise.race([
				Event.toPromise(Event.filter(model.onDidChangeLoadingState, e => !e.loading)),
				timeout(THUMBNAIL_LOAD_TIMEOUT)
			]);
		}
		await timeout(THUMBNAIL_SETTLE_DELAY);
	}

	private async copyLink(page: IPageModel, section: ISectionModel): Promise<void> {
		const link = section.anchor.startsWith('#') ? `${page.rel}${section.anchor}` : page.rel;
		await this.clipboardService.writeText(link);
	}

	private backToFiles(): void {
		this.selected = undefined;
		this.overlay.classList.remove('cc-ps-has-context');
		for (const c of this.gridEl.children) {
			c.classList.remove('cc-ps-card-selected');
		}
		this.renderEmptyContext();
		// Back in the gallery: resume capturing any thumbnails that did not finish.
		this.galleryCaptureInterrupted = false;
		if (!this.disposedForOpen && this.pages.some(page => !page.thumbnailDataUrl)) {
			void this.capturePageThumbnails();
		}
	}

	private hideActiveCaptureSurfaces(): void {
		for (const input of this.activeCaptureInputs) {
			void input.model?.setVisible(false);
		}
	}

	private async finish(result: IPreviewSelectorResult): Promise<void> {
		if (this.closing) {
			return;
		}
		this.closing = true;
		this.disposedForOpen = true;
		await this.stopCaptures();
		this.modalDisposables.clear();
		this.resolveFn?.(result);
		this.resolveFn = undefined;
	}

	private async cancel(): Promise<void> {
		if (this.closing) {
			return;
		}
		this.closing = true;
		this.disposedForOpen = true;
		await this.stopCaptures();
		this.modalDisposables.clear();
		this.resolveFn?.(undefined);
		this.resolveFn = undefined;
	}

	override dispose(): void {
		this.disposedForOpen = true;
		this.modalDisposables.clear();
		void this.stopCaptures();
		super.dispose();
	}
}
