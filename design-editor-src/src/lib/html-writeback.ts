// Static-HTML write-back: reflects visual edits into the real .html source files.
//
// Onlook persists edits through a JSX/oid pipeline (data-oid baked into JSX at build time). Static
// HTML has none of that, so this module provides the HTML equivalent and is used instead of the
// JSX pipeline when the open project's framework is 'html'.
//
// Writer strategy: the PRIMARY path is the format-preserving range writer (html-source-writer.ts,
// parse5 sourceCodeLocation + magic-string), which patches only the changed bytes so the Code panel
// keeps the user's formatting/comments and diffs stay small. The DOMParser + outerHTML logic in this
// file is the FALLBACK, used only when the range writer can't safely locate the range.
//
// Element identity: the inspector proxy assigns `data-oid="<n>"` = the element's durable data-cc-id
// when present, else its position among editable elements (see editableElements). Both the range
// writer and the fallback resolve cc-id first, then positional index. Writes go through the
// workbench filesystem so the Code editor reflects them immediately.

import { debugLog } from '@/lib/debug';
import type { ActionLocation } from '@onlook/models/actions';
import { getActiveProjectRoot } from '@/lib/design-session';
import { workbench } from '@/lib/workbench-bridge';
import {
    writeAttrEdit as rangeAttrEdit,
    writeInsert as rangeInsert,
    writeMove as rangeMove,
    writeRemove as rangeRemove,
    writeStyleEdit as rangeStyleEdit,
    writeTextEdit as rangeTextEdit,
} from '@/lib/html-source-writer';

// Tags that are not user-editable content and must never get an oid / be selectable for editing.
const NON_EDITABLE_TAGS = new Set([
    'html', 'head', 'body', 'script', 'style', 'template', 'meta', 'link', 'base', 'title', 'noscript',
]);

// Durable, source-persisted element identity. Survives insert/move/delete (unlike a positional
// index). The proxy prefers this as the oid once a page has been instrumented with it.
const CC_ID_ATTR = 'data-cc-id';
// Persistent marker stamped on elements Design INSERTS (media/box/text). Lets the editor offer free
// move/resize only for things Design created — never for original flow content. Not an Onlook attr
// (doesn't match ONLOOK_ATTR_RE below), so the writer keeps it in the user's source.
export const CC_CREATED_ATTR = 'data-cc-created';
export const CC_CREATED_VALUE = 'design';
// Marker stamped on ORIGINAL HTML elements the user explicitly "converts to free editing" (flow ->
// absolute). Same effect as CC_CREATED for the Moveable gate, but semantically "user opted this
// original element in". Also a data-c* attribute, so the writer preserves it.
export const CC_EDITABLE_ATTR = 'data-cc-editable';
export const CC_EDITABLE_VALUE = 'free';
// Onlook editor attributes that must never be written into the user's source.
const ONLOOK_ATTR_RE = /^data-o(id|iid|did|cname|nlook)/i;

/**
 * The editable elements of a document, in document order: everything inside <body> except scripts,
 * styles and other non-content tags. Used by BOTH the proxy (to assign data-oid) and the write-back
 * (to resolve an oid), so the positional index is consistent.
 */
export function editableElements(doc: Document): Element[] {
    const body = doc.body;
    if (!body) return [];
    return Array.from(body.querySelectorAll('*')).filter(
        (el) => !NON_EDITABLE_TAGS.has(el.tagName.toLowerCase()),
    );
}

/** The durable id of an element, if any. */
export function ccIdOf(el: Element): string | null {
    return el.getAttribute(CC_ID_ATTR);
}

function newCcId(used: Set<string>): string {
    let id: string;
    do {
        id = 'c' + Math.random().toString(36).slice(2, 9);
    } while (used.has(id));
    used.add(id);
    return id;
}

/** Assigns a durable data-cc-id to every editable element that lacks one. Returns true if changed. */
function ensureCcIds(doc: Document): boolean {
    const els = editableElements(doc);
    const used = new Set<string>();
    for (const el of els) {
        const v = el.getAttribute(CC_ID_ATTR);
        if (v) used.add(v);
    }
    let changed = false;
    for (const el of els) {
        if (!el.getAttribute(CC_ID_ATTR)) {
            el.setAttribute(CC_ID_ATTR, newCcId(used));
            changed = true;
        }
    }
    return changed;
}

/** Joins a project-relative path onto the active project root (same convention as bridge-provider). */
function abs(rootPath: string, relPath: string): string {
    const clean = relPath.replace(/\\/g, '/').replace(/^\.?\//, '');
    const root = rootPath.replace(/\\/g, '/');
    return clean ? `${root}/${clean}` : root;
}

/** Maps a frame URL pathname to the source HTML file. '/' -> index.html, '/nav/' -> nav/index.html. */
export function pageFileForPathname(pathname: string): string {
    const p = (pathname || '/').split('?')[0].split('#')[0].replace(/^\//, '');
    if (p === '') return 'index.html';
    if (p.endsWith('/')) return `${p}index.html`;
    if (p.endsWith('.html') || p.endsWith('.htm')) return p;
    return `${p}/index.html`;
}

export type HtmlWriteReason = 'no-root' | 'read-fail' | 'write-fail' | 'not-found' | 'has-children';
// `changed: false` means the op was a valid no-op (nothing written), so callers can skip the reload.
export type HtmlWriteResult = { ok: boolean; reason?: HtmlWriteReason; changed?: boolean };

interface LoadedDoc {
    doc: Document;
    els: Element[];
    path: string;
    html: string;
}

async function loadDoc(pageFile: string): Promise<LoadedDoc | { error: HtmlWriteReason }> {
    const rootPath = getActiveProjectRoot();
    if (!rootPath) {
        console.warn('[html-writeback] no active project root');
        return { error: 'no-root' };
    }
    const path = abs(rootPath, pageFile);
    let html: string;
    try {
        const res = await workbench.readFile(path, 'utf8');
        html = res.content;
    } catch (err) {
        console.warn('[html-writeback] failed to read', path, err);
        return { error: 'read-fail' };
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return { doc, els: editableElements(doc), path, html };
}

/** Writes a raw source string (the format-preserving path's output). */
async function writeRaw(path: string, content: string): Promise<HtmlWriteResult> {
    try {
        await workbench.writeFile(path, content, 'utf8');
        return { ok: true, changed: true };
    } catch (err) {
        console.warn('[html-writeback] failed to write', path, err);
        return { ok: false, reason: 'write-fail' };
    }
}

function serialize(doc: Document): string {
    const doctype = doc.doctype ? '<!DOCTYPE html>\n' : '';
    return doctype + doc.documentElement.outerHTML;
}

function elementForOid(doc: Document, oid: string | undefined): HTMLElement | null {
    if (oid === undefined || oid === null || oid === '') return null;
    // Durable id first (only matches our [a-z0-9] ids, so the selector is safe).
    if (/^c[a-z0-9]+$/.test(oid)) {
        const byCc = doc.querySelector(`[${CC_ID_ATTR}="${oid}"]`);
        if (byCc instanceof HTMLElement) return byCc;
    }
    // Legacy positional index (pages not yet instrumented with cc-ids).
    const index = Number(oid);
    if (Number.isInteger(index)) {
        const el = editableElements(doc)[index];
        if (el instanceof HTMLElement) return el;
    }
    return null;
}

async function writeDoc(path: string, doc: Document): Promise<HtmlWriteResult> {
    try {
        await workbench.writeFile(path, serialize(doc), 'utf8');
        return { ok: true };
    } catch (err) {
        console.warn('[html-writeback] failed to write', path, err);
        return { ok: false, reason: 'write-fail' };
    }
}

export type StyleWriteChange = { value: string; remove?: boolean };

/** Applies inline-style changes to the source element identified by `oid`. */
export async function applyHtmlStyleEdit(
    oid: string | undefined,
    styleUpdates: Record<string, StyleWriteChange>,
    pageFile: string,
): Promise<HtmlWriteResult> {
    const loaded = await loadDoc(pageFile);
    if ('error' in loaded) {
        debugLog('[CC-WRITEBACK] style', { oid, pageFile, ok: false, reason: loaded.error });
        return { ok: false, reason: loaded.error };
    }

    // Format-preserving range writer first; fall back to DOMParser + outerHTML if it can't locate.
    const patched = rangeStyleEdit(loaded.html, oid, styleUpdates);
    if (patched != null) {
        debugLog('[CC-WRITEBACK] style', { oid, pageFile, path: 'range', ok: true, updates: styleUpdates });
        return writeRaw(loaded.path, patched);
    }

    const el = elementForOid(loaded.doc, oid);
    if (!el) {
        console.warn('[html-writeback] no source element for oid', oid, 'in', pageFile);
        debugLog('[CC-WRITEBACK] style', { oid, pageFile, path: 'none', ok: false, reason: 'not-found' });
        return { ok: false, reason: 'not-found' };
    }
    debugLog('[CC-WRITEBACK] style', { oid, pageFile, path: 'fallback', ok: true, updates: styleUpdates });
    for (const [prop, change] of Object.entries(styleUpdates)) {
        const kebab = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        if (change.remove || change.value === '') {
            el.style.removeProperty(kebab);
        } else {
            el.style.setProperty(kebab, change.value);
        }
    }
    if (el.getAttribute('style') === '') {
        el.removeAttribute('style');
    }
    ensureCcIds(loaded.doc); // migrate the page to durable ids on first edit of any kind
    return writeDoc(loaded.path, loaded.doc);
}

/** Sets attributes (e.g. src/alt) on the source element identified by `oid`. */
export async function applyHtmlAttrEdit(
    oid: string | undefined,
    attributes: Record<string, string>,
    pageFile: string,
): Promise<HtmlWriteResult> {
    const loaded = await loadDoc(pageFile);
    if ('error' in loaded) return { ok: false, reason: loaded.error };

    const patched = rangeAttrEdit(loaded.html, oid, attributes);
    if (patched != null) return writeRaw(loaded.path, patched);

    const el = elementForOid(loaded.doc, oid);
    if (!el) {
        console.warn('[html-writeback] no source element for oid', oid, 'in', pageFile);
        return { ok: false, reason: 'not-found' };
    }
    for (const [k, v] of Object.entries(attributes)) {
        if (ONLOOK_ATTR_RE.test(k)) continue;
        el.setAttribute(k, v);
    }
    ensureCcIds(loaded.doc);
    return writeDoc(loaded.path, loaded.doc);
}

/**
 * Replaces the text of the source element identified by `oid`. Only safe when the element has no
 * element children: otherwise `textContent =` would delete inner markup (icons, spans, links), so we
 * refuse and report 'has-children' for the caller to surface a non-destructive notice.
 */
export async function applyHtmlTextEdit(
    oid: string | undefined,
    newText: string,
    pageFile: string,
): Promise<HtmlWriteResult> {
    const loaded = await loadDoc(pageFile);
    if ('error' in loaded) return { ok: false, reason: loaded.error };

    // Find first so we can report has-children (a real refusal) vs a range-writer miss (fallback).
    const el = elementForOid(loaded.doc, oid);
    if (!el) {
        console.warn('[html-writeback] no source element for oid', oid, 'in', pageFile);
        return { ok: false, reason: 'not-found' };
    }
    if (el.childElementCount > 0) {
        console.warn('[html-writeback] refusing text edit: element has child elements', oid);
        return { ok: false, reason: 'has-children' };
    }

    const patched = rangeTextEdit(loaded.html, oid, newText);
    if (patched != null) return writeRaw(loaded.path, patched);

    el.textContent = newText;
    ensureCcIds(loaded.doc); // migrate the page to durable ids on first edit of any kind
    return writeDoc(loaded.path, loaded.doc);
}

// --- Insert (image / video / element) -------------------------------------------------------

const ASSETS_DIR = 'assets';

function sanitizeAssetName(fileName: string): string {
    const base = (fileName || 'asset').split(/[\\/]/).pop() || 'asset';
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[-.]+/, '');
    return cleaned || 'asset';
}

function withSuffix(name: string, n: number): string {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return `${name}-${n}`;
    return `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
}

/**
 * Saves a (base64 or data-URL) asset into the project's /assets folder with a safe, collision-free
 * name. If `content` is empty, falls back to reading the existing project file at `originPath`.
 * Returns the project-relative path (e.g. "assets/photo.png"), or null if it could not be saved
 * (e.g. nothing readable) so the caller can warn instead of writing an empty file.
 */
export async function saveAsset(
    fileName: string,
    content: string | undefined,
    originPath?: string,
): Promise<string | null> {
    const rootPath = getActiveProjectRoot();
    debugLog('[CC-DROP] saveAsset', { fileName, hasContent: !!content, contentLen: content?.length ?? 0, originPath, rootPath });
    if (!rootPath) return null;
    let base64 = content?.startsWith('data:') ? content.slice(content.indexOf(',') + 1) : content;
    if (!base64 && originPath) {
        try {
            const res = await workbench.readFile(abs(rootPath, originPath), 'base64');
            base64 = res.content;
        } catch (err) {
            console.warn('[html-writeback] failed to read origin asset', originPath, err);
        }
    }
    if (!base64) {
        console.warn('[html-writeback] empty asset content, not saving', fileName);
        return null;
    }
    try {
        await workbench.mkdir(abs(rootPath, ASSETS_DIR));
    } catch {
        /* may already exist */
    }
    const safe = sanitizeAssetName(fileName);
    let finalName = safe;
    let i = 1;
    let resolved = true;
    try {
        while (await workbench.exists(abs(rootPath, `${ASSETS_DIR}/${finalName}`))) {
            if (i > 1000) {
                // Ran out of free suffixes: bail instead of breaking out and overwriting the file
                // that `finalName` still points at (which exists — that's why we're in the loop).
                resolved = false;
                break;
            }
            finalName = withSuffix(safe, i++);
        }
    } catch {
        /* exists check failed; proceed with safe name */
    }
    if (!resolved) {
        console.warn('[html-writeback] too many asset-name collisions, not saving', safe);
        return null;
    }
    const rel = `${ASSETS_DIR}/${finalName}`;
    try {
        await workbench.writeFile(abs(rootPath, rel), base64, 'base64');
        return rel;
    } catch (err) {
        console.warn('[html-writeback] failed to save asset', rel, err);
        return null;
    }
}

/** Rewrites a project-root-relative asset path to be relative to the given page file's folder. */
export function assetSrcForPage(assetRelPath: string, pageFile: string): string {
    const depth = pageFile.split('/').length - 1; // index.html -> 0, nav/index.html -> 1
    return `${'../'.repeat(depth)}${assetRelPath}`;
}

export interface InsertSpec {
    tagName: string;
    attributes: Record<string, string>;
    styles: Record<string, string>;
    textContent?: string | null;
}

function insertAt(container: Element, el: Element, location: ActionLocation): void {
    if (location.type === 'prepend') {
        container.insertBefore(el, container.firstElementChild);
    } else if (location.type === 'index') {
        const ref = container.children[location.index] ?? null;
        container.insertBefore(el, ref);
    } else {
        container.appendChild(el); // 'append' and fallback
    }
}

/**
 * Moves an EXISTING element into `container` at `location`. Unlike insertAt, the destination index
 * is computed ignoring `el` itself (it still counts among the container's children until moved), so
 * moving forward within the same container isn't off-by-one. Returns false when it's already in the
 * destination (no DOM change), so the caller can skip the write/reload.
 */
function moveAt(container: Element, el: Element, location: ActionLocation): boolean {
    if (location.type === 'append') {
        if (el.parentElement === container && el === container.lastElementChild) return false;
        container.appendChild(el);
        return true;
    }
    const index = location.type === 'index' ? location.index : 0; // 'prepend' -> 0
    const children = Array.from(container.children).filter((child) => child !== el);
    const ref = children[index] ?? null;
    if (ref === el.nextElementSibling) return false; // already in place
    container.insertBefore(el, ref);
    return true;
}

/**
 * Inserts a new element (img/video/div/...) into the source HTML at `location`, persisting a durable
 * cc-id on it and on existing editable elements. If the target container can't be resolved, falls
 * back to the end of <body>.
 */
export async function applyHtmlInsert(
    spec: InsertSpec,
    location: ActionLocation,
    pageFile: string,
): Promise<HtmlWriteResult> {
    const loaded = await loadDoc(pageFile);
    if ('error' in loaded) return { ok: false, reason: loaded.error };

    const patched = rangeInsert(loaded.html, spec, location);
    if (patched != null) return writeRaw(loaded.path, patched);

    const { doc } = loaded;
    if (!doc.body) return { ok: false, reason: 'not-found' };

    // Give existing editable elements durable ids so future edits are index-independent.
    ensureCcIds(doc);

    const el = doc.createElement(spec.tagName);
    for (const [k, v] of Object.entries(spec.attributes)) {
        if (ONLOOK_ATTR_RE.test(k)) continue; // never write Onlook editor attributes to source
        if (k === 'style') continue; // styles handled below
        el.setAttribute(k, v);
    }
    for (const [prop, value] of Object.entries(spec.styles)) {
        const kebab = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        if (value) el.style.setProperty(kebab, value);
    }
    if (spec.textContent) el.textContent = spec.textContent;

    // Durable id for the new element too.
    const used = new Set<string>();
    for (const e of editableElements(doc)) {
        const v = e.getAttribute(CC_ID_ATTR);
        if (v) used.add(v);
    }
    el.setAttribute(CC_ID_ATTR, newCcId(used));

    const container = (location.targetOid && elementForOid(doc, location.targetOid)) || doc.body;
    insertAt(container, el, location);

    return writeDoc(loaded.path, doc);
}

/** Removes the source element identified by `oid`. */
export async function applyHtmlRemove(oid: string | undefined, pageFile: string): Promise<HtmlWriteResult> {
    const loaded = await loadDoc(pageFile);
    if ('error' in loaded) return { ok: false, reason: loaded.error };

    const patched = rangeRemove(loaded.html, oid);
    if (patched != null) return writeRaw(loaded.path, patched);

    const el = elementForOid(loaded.doc, oid);
    if (!el) {
        console.warn('[html-writeback] no source element to remove for oid', oid, 'in', pageFile);
        return { ok: false, reason: 'not-found' };
    }
    ensureCcIds(loaded.doc);
    el.remove();
    return writeDoc(loaded.path, loaded.doc);
}

/** Moves the source element identified by `oid` into `location`'s container at its index. */
export async function applyHtmlMove(
    oid: string | undefined,
    location: ActionLocation,
    pageFile: string,
): Promise<HtmlWriteResult> {
    const loaded = await loadDoc(pageFile);
    if ('error' in loaded) return { ok: false, reason: loaded.error };

    const patched = rangeMove(loaded.html, oid, location);
    if (patched != null) {
        if (patched === loaded.html) return { ok: true, changed: false }; // no-op
        return writeRaw(loaded.path, patched);
    }

    const { doc } = loaded;
    const el = elementForOid(doc, oid);
    if (!el) {
        console.warn('[html-writeback] no source element to move for oid', oid, 'in', pageFile);
        return { ok: false, reason: 'not-found' };
    }
    const container = (location.targetOid && elementForOid(doc, location.targetOid)) || doc.body;
    // Never move an element into itself or one of its descendants.
    if (container === el || el.contains(container)) {
        console.warn('[html-writeback] refusing to move element into itself', oid);
        return { ok: false, reason: 'not-found' };
    }
    const moved = moveAt(container, el, location);
    if (!moved) {
        return { ok: true, changed: false }; // already in place: skip needless write/reload
    }
    ensureCcIds(doc);
    return writeDoc(loaded.path, doc);
}
