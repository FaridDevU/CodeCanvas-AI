// Format-preserving HTML writer. Applies edits as surgical range patches over the original source
// (parse5 sourceCodeLocation + magic-string) instead of re-serializing the whole document, so the
// Code panel keeps the user's formatting/comments and diffs stay small.
//
// Every function returns the new source string, or null when it cannot safely locate the range
// (missing source locations, void-element text edit, etc.). The caller (html-writeback) then falls
// back to the DOMParser + outerHTML writer, so behaviour is never worse than before.

import { parse } from 'parse5';
import MagicString from 'magic-string';

// Keep this list identical to html-writeback.editableElements so positional ids line up.
const NON_EDITABLE_TAGS = new Set([
    'html', 'head', 'body', 'script', 'style', 'template', 'meta', 'link', 'base', 'title', 'noscript',
]);
const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
    'track', 'wbr',
]);
const CC_ID_ATTR = 'data-cc-id';
const ONLOOK_ATTR_RE = /^data-o(id|iid|did|cname|nlook)/i;

// parse5 default-tree-adapter nodes are plain objects; we access them loosely.
type P5Node = any;
type Loc = { startOffset: number; endOffset: number };

function isElement(node: P5Node): boolean {
    return !!node && typeof node.tagName === 'string';
}

function getAttr(node: P5Node, name: string): string | undefined {
    const a = (node.attrs as Array<{ name: string; value: string }> | undefined)?.find((x) => x.name === name);
    return a?.value;
}

function findBody(doc: P5Node): P5Node | null {
    let found: P5Node | null = null;
    const walk = (n: P5Node) => {
        if (found) return;
        if (isElement(n) && n.tagName === 'body') {
            found = n;
            return;
        }
        for (const c of n.childNodes ?? []) walk(c);
    };
    walk(doc);
    return found;
}

/** Editable elements under <body>, preorder, excluding non-content tags (matches DOMParser walk). */
function collectEditable(doc: P5Node): P5Node[] {
    const body = findBody(doc);
    if (!body) return [];
    const out: P5Node[] = [];
    const walk = (n: P5Node) => {
        for (const c of n.childNodes ?? []) {
            if (isElement(c)) {
                if (!NON_EDITABLE_TAGS.has(c.tagName)) out.push(c);
                walk(c);
            }
        }
    };
    walk(body);
    return out;
}

function elementChildren(node: P5Node): P5Node[] {
    return (node.childNodes ?? []).filter((c: P5Node) => isElement(c));
}

interface ParsedSource {
    doc: P5Node;
    editable: P5Node[];
}

function parseSource(source: string): ParsedSource | null {
    try {
        const doc = parse(source, { sourceCodeLocationInfo: true });
        return { doc, editable: collectEditable(doc) };
    } catch (err) {
        console.warn('[html-source-writer] parse failed, will fall back:', err);
        return null;
    }
}

function findNode(parsed: ParsedSource, oid: string | undefined): P5Node | null {
    if (!oid) return null;
    if (/^c[a-z0-9]+$/.test(oid)) {
        const byCc = parsed.editable.find((n) => getAttr(n, CC_ID_ATTR) === oid);
        if (byCc) return byCc;
    }
    const idx = Number(oid);
    if (Number.isInteger(idx)) return parsed.editable[idx] ?? null;
    return null;
}

function escapeAttr(v: string): string {
    return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
function escapeText(v: string): string {
    return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Offset just after `<tagname` in the start tag, where a new attribute can be inserted. */
function afterTagName(node: P5Node): number | null {
    const startTag: Loc | undefined = node.sourceCodeLocation?.startTag;
    if (!startTag) return null;
    return startTag.startOffset + 1 + node.tagName.length;
}

function newCcId(used: Set<string>): string {
    let id: string;
    do {
        id = 'c' + Math.random().toString(36).slice(2, 9);
    } while (used.has(id));
    used.add(id);
    return id;
}

/** Patches the start tag of every editable element lacking a data-cc-id, in place on `s`. */
function migrateCcIds(parsed: ParsedSource, s: MagicString): void {
    const used = new Set<string>();
    for (const n of parsed.editable) {
        const v = getAttr(n, CC_ID_ATTR);
        if (v) used.add(v);
    }
    for (const n of parsed.editable) {
        if (getAttr(n, CC_ID_ATTR)) continue;
        const at = afterTagName(n);
        if (at == null) continue;
        s.appendLeft(at, ` ${CC_ID_ATTR}="${newCcId(used)}"`);
    }
}

/** Writes one attribute on `node` (overwrite existing range or insert a new attribute). */
function setAttr(node: P5Node, name: string, value: string, s: MagicString): boolean {
    const loc: Loc | undefined = node.sourceCodeLocation?.attrs?.[name];
    if (loc) {
        s.update(loc.startOffset, loc.endOffset, `${name}="${escapeAttr(value)}"`);
        return true;
    }
    const at = afterTagName(node);
    if (at == null) return false;
    s.appendLeft(at, ` ${name}="${escapeAttr(value)}"`);
    return true;
}

function removeAttr(node: P5Node, name: string, s: MagicString): void {
    const loc: Loc | undefined = node.sourceCodeLocation?.attrs?.[name];
    if (!loc) return;
    // Remove the attribute and one leading space if present.
    const start = loc.startOffset > 0 ? loc.startOffset - 1 : loc.startOffset;
    s.remove(start, loc.endOffset);
}

// --- Public range-writer ops (return new source, or null to fall back) ----------------------

export function writeAttrEdit(
    source: string,
    oid: string | undefined,
    attributes: Record<string, string | null>,
): string | null {
    const parsed = parseSource(source);
    if (!parsed) return null;
    const node = findNode(parsed, oid);
    if (!node) return null;
    const s = new MagicString(source);
    for (const [k, v] of Object.entries(attributes)) {
        if (ONLOOK_ATTR_RE.test(k)) continue;
        if (v === null) {
            removeAttr(node, k, s); // null = drop the attribute (e.g. revert to static)
        } else if (!setAttr(node, k, v, s)) {
            return null;
        }
    }
    migrateCcIds(parsed, s);
    return s.toString();
}

export type StyleWriteChange = { value: string; remove?: boolean };

function parseStyle(value: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const decl of value.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        const prop = decl.slice(0, i).trim();
        const val = decl.slice(i + 1).trim();
        if (prop) map.set(prop, val);
    }
    return map;
}
function serializeStyle(map: Map<string, string>): string {
    return Array.from(map, ([k, v]) => `${k}: ${v}`).join('; ');
}

export function writeStyleEdit(
    source: string,
    oid: string | undefined,
    styleUpdates: Record<string, StyleWriteChange>,
): string | null {
    const parsed = parseSource(source);
    if (!parsed) return null;
    const node = findNode(parsed, oid);
    if (!node) return null;
    const map = parseStyle(getAttr(node, 'style') ?? '');
    for (const [prop, change] of Object.entries(styleUpdates)) {
        const kebab = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        if (change.remove || change.value === '') map.delete(kebab);
        else map.set(kebab, change.value);
    }
    const s = new MagicString(source);
    const styleStr = serializeStyle(map);
    if (styleStr === '') {
        removeAttr(node, 'style', s);
    } else if (!setAttr(node, 'style', styleStr, s)) {
        return null;
    }
    migrateCcIds(parsed, s);
    return s.toString();
}

export function writeTextEdit(source: string, oid: string | undefined, newText: string): string | null {
    const parsed = parseSource(source);
    if (!parsed) return null;
    const node = findNode(parsed, oid);
    if (!node) return null;
    // Only text-only elements, and only when we have both tag boundaries.
    if (elementChildren(node).length > 0) return null;
    const startTag: Loc | undefined = node.sourceCodeLocation?.startTag;
    const endTag: Loc | undefined = node.sourceCodeLocation?.endTag;
    if (!startTag || !endTag) return null;
    const s = new MagicString(source);
    const start = startTag.endOffset;
    const end = endTag.startOffset;
    if (start === end) {
        s.appendLeft(start, escapeText(newText)); // empty element: nothing to overwrite
    } else {
        s.update(start, end, escapeText(newText));
    }
    migrateCcIds(parsed, s);
    return s.toString();
}

export function writeRemove(source: string, oid: string | undefined): string | null {
    const parsed = parseSource(source);
    if (!parsed) return null;
    const node = findNode(parsed, oid);
    if (!node) return null;
    const loc = node.sourceCodeLocation as (Loc & { endTag?: Loc }) | undefined;
    if (!loc) return null;
    const s = new MagicString(source);
    s.remove(loc.startOffset, loc.endOffset);
    return s.toString();
}

export interface InsertSpec {
    tagName: string;
    attributes: Record<string, string>;
    styles: Record<string, string>;
    textContent?: string | null;
}

function buildElementHtml(spec: InsertSpec, ccId: string): string {
    const attrs: string[] = [];
    for (const [k, v] of Object.entries(spec.attributes)) {
        if (ONLOOK_ATTR_RE.test(k) || k === 'style' || k === CC_ID_ATTR) continue;
        attrs.push(`${k}="${escapeAttr(v)}"`);
    }
    // Merge the inline `style` attribute (undo of a delete carries geometry there) with spec.styles;
    // spec.styles entries come last so they win on conflicts.
    const stylePieces: string[] = [];
    const rawStyle = spec.attributes['style']?.trim().replace(/;\s*$/, '');
    if (rawStyle) stylePieces.push(rawStyle);
    for (const [k, v] of Object.entries(spec.styles)) {
        if (v) stylePieces.push(`${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${v}`);
    }
    const styleStr = stylePieces.join('; ');
    if (styleStr) attrs.push(`style="${escapeAttr(styleStr)}"`);
    attrs.push(`${CC_ID_ATTR}="${ccId}"`);
    const tag = spec.tagName.toLowerCase();
    const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
    if (VOID_TAGS.has(tag)) return `<${tag}${attrStr} />`;
    const text = spec.textContent ? escapeText(spec.textContent) : '';
    return `<${tag}${attrStr}>${text}</${tag}>`;
}

/** Offset where a child should be inserted inside `container` for a given location. */
function insertOffsetIn(container: P5Node, location: { type: string; index?: number }): number | null {
    const startTag: Loc | undefined = container.sourceCodeLocation?.startTag;
    const endTag: Loc | undefined = container.sourceCodeLocation?.endTag;
    if (!startTag) return null;
    if (location.type === 'prepend') return startTag.endOffset;
    if (location.type === 'index' && typeof location.index === 'number') {
        const kids = elementChildren(container);
        const ref = kids[location.index];
        if (ref?.sourceCodeLocation) return (ref.sourceCodeLocation as Loc).startOffset;
        // index past the end -> before closing tag / end of container
    }
    // 'append' and fallback: just before the closing tag, or end of start tag for void-ish.
    return endTag ? endTag.startOffset : startTag.endOffset;
}

export function writeInsert(
    source: string,
    spec: InsertSpec,
    location: { type: string; targetOid?: string | null; index?: number },
): string | null {
    const parsed = parseSource(source);
    if (!parsed) return null;
    const container = (location.targetOid && findNode(parsed, location.targetOid)) || findBody(parsed.doc);
    if (!container) return null;
    const offset = insertOffsetIn(container, location);
    if (offset == null) return null;
    const used = new Set<string>();
    for (const n of parsed.editable) {
        const v = getAttr(n, CC_ID_ATTR);
        if (v) used.add(v);
    }
    // Reuse the supplied id (undo/redo identity) when free; otherwise mint a fresh one.
    const explicitId = spec.attributes[CC_ID_ATTR];
    const ccId = explicitId && !used.has(explicitId) ? explicitId : newCcId(used);
    const html = buildElementHtml(spec, ccId);
    const s = new MagicString(source);
    s.appendLeft(offset, indentedInsert(source, offset, html, location.type));
    migrateCcIds(parsed, s);
    return s.toString();
}

/**
 * Builds the text to insert at `offset` so the new element always lands on its OWN line with
 * sensible indentation, even when the surrounding markup is already glued onto one line (which is
 * common once a file has accumulated inserts). `atLineStart` tells us whether `offset` already sits
 * after a line's indentation (the clean case) or in the middle of glued content (needs a leading
 * newline to break out).
 */
function indentedInsert(source: string, offset: number, html: string, type: string): string {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    const before = source.slice(lineStart, offset);
    const atLineStart = /^[ \t]*$/.test(before);
    // The line's base indentation (only meaningful when we're at line start; otherwise unknown -> '').
    const baseIndent = atLineStart ? before : '';
    const childIndent = '    '; // one nesting level past the container/sibling

    if (type === 'prepend') {
        // offset is right after the container's start tag: always open a fresh, deeper line.
        return `\n${baseIndent}${childIndent}${html}`;
    }
    if (type === 'index') {
        // offset is the reference sibling's start. When clean, its indent already precedes offset,
        // so just emit + push the sibling down; when glued, break onto a new line first.
        return atLineStart ? `${html}\n${baseIndent}` : `\n${baseIndent}${childIndent}${html}`;
    }
    // append: offset is the container's closing tag. When clean, the tag's own indent already
    // precedes offset (so only add the extra nesting level); when glued, prepend a newline so the
    // new element isn't jammed onto the previous one, and drop the closing tag onto its own line.
    return atLineStart
        ? `${childIndent}${html}\n${baseIndent}`
        : `\n${baseIndent}${childIndent}${html}\n${baseIndent}`;
}

type MoveTarget = { noop: boolean; offset: number };

/**
 * Like insertOffsetIn but for MOVING an existing node: the destination index is computed over the
 * container's children EXCLUDING `movingNode` (it still sits among them until moved), so moving
 * forward in the same container isn't off-by-one. Also reports a real no-op.
 */
function moveOffsetIn(
    container: P5Node,
    movingNode: P5Node,
    location: { type: string; index?: number },
): MoveTarget | null {
    const startTag: Loc | undefined = container.sourceCodeLocation?.startTag;
    const endTag: Loc | undefined = container.sourceCodeLocation?.endTag;
    if (!startTag) return null;
    const endOffset = endTag ? endTag.startOffset : startTag.endOffset;
    const allKids = elementChildren(container);
    const sameContainer = movingNode.parentNode === container;

    if (location.type === 'append') {
        if (sameContainer && allKids[allKids.length - 1] === movingNode) return { noop: true, offset: 0 };
        return { noop: false, offset: endOffset };
    }
    if (location.type === 'prepend') {
        if (sameContainer && allKids[0] === movingNode) return { noop: true, offset: 0 };
        return { noop: false, offset: startTag.endOffset };
    }
    // index: position among children that excludes the moving node.
    const kids = allKids.filter((c) => c !== movingNode);
    const index = typeof location.index === 'number' ? location.index : 0;
    const ref = kids[index] ?? null;
    if (sameContainer) {
        const myIdx = allKids.indexOf(movingNode);
        const myNext = allKids[myIdx + 1] ?? null; // current next element sibling
        if (ref === myNext) return { noop: true, offset: 0 }; // already in place
    }
    if (ref?.sourceCodeLocation) return { noop: false, offset: (ref.sourceCodeLocation as Loc).startOffset };
    return { noop: false, offset: endOffset }; // index past the end -> before the closing tag
}

export function writeMove(
    source: string,
    oid: string | undefined,
    location: { type: string; targetOid?: string | null; index?: number },
): string | null {
    const parsed = parseSource(source);
    if (!parsed) return null;
    const node = findNode(parsed, oid);
    if (!node) return null;
    const container = (location.targetOid && findNode(parsed, location.targetOid)) || findBody(parsed.doc);
    if (!container) return null;
    // Don't move into self/descendant.
    let p: P5Node | null = container;
    while (p) {
        if (p === node) return null;
        p = p.parentNode ?? null;
    }
    const loc = node.sourceCodeLocation as Loc | undefined;
    if (!loc) return null;
    const target = moveOffsetIn(container, node, location);
    if (target == null) return null;
    if (target.noop) return source; // already in place: no change
    // Safety: never move into the node's own range.
    if (target.offset >= loc.startOffset && target.offset <= loc.endOffset) return source;
    const s = new MagicString(source);
    s.move(loc.startOffset, loc.endOffset, target.offset);
    migrateCcIds(parsed, s);
    return s.toString();
}
