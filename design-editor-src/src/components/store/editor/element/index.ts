import { debugLog } from '@/lib/debug';
import type { CoreElementType, DomElement, DynamicType } from '@onlook/models';
import type { RemoveElementAction } from '@onlook/models/actions';
import { toast } from '@onlook/ui/sonner';
import { makeAutoObservable } from 'mobx';
import { getActiveProject } from '@/lib/design-session';
import {
    applyHtmlAttrEdit,
    applyHtmlReparentToBody,
    CC_CREATED_ATTR,
    CC_CREATED_VALUE,
    CC_EDITABLE_ATTR,
    CC_EDITABLE_VALUE,
    CC_LOCKED_ATTR,
    CC_LOCKED_VALUE,
    pageFileForPathname,
} from '@/lib/html-writeback';
import type { EditorEngine } from '../engine';
import type { FrameData } from '../frames';
import { adaptRectToCanvas } from '../overlay/utils';

// Tags that are not user content and must never be converted to free-positioned editing.
const NON_CONVERTIBLE_TAGS = new Set([
    'html', 'head', 'body', 'script', 'style', 'template', 'meta', 'link', 'base', 'title', 'noscript',
]);

// Mid-point for z-order. "Traer al frente" climbs above it, "enviar al fondo" sinks below it but never
// below 1 — staying positive so an element can't disappear behind an opaque card's white background
// (a negative z-index paints behind the page content = the element vanishes). Word-like layering only.
const Z_BASE = 1000;

// Reads the REAL z-index extent of positioned elements in the live preview (same-origin iframe), so
// z-order is computed against what's actually on the page instead of a blind per-session counter (which
// failed when an element already outranked the counter — e.g. an image stuck behind a box that had a
// higher z). Returns the max/min explicit z among positioned elements other than `excludeDomId`;
// falls back to Z_BASE when nothing carries an explicit z.
function readFrameZExtent(view: any, excludeDomId?: string): { max: number; min: number } | null {
    try {
        const doc: Document | undefined = view?.contentDocument;
        const win = doc?.defaultView;
        if (!doc || !win) return null;
        let max = -Infinity;
        let min = Infinity;
        doc.querySelectorAll<HTMLElement>('body *').forEach((node) => {
            if (excludeDomId && node.getAttribute('data-odid') === excludeDomId) return;
            const cs = win.getComputedStyle(node);
            if (cs.position === 'static') return; // z-index has no effect on in-flow boxes
            const z = parseInt(cs.zIndex, 10);
            if (!Number.isFinite(z)) return; // 'auto' / unset
            if (z > max) max = z;
            if (z < min) min = z;
        });
        return {
            max: Number.isFinite(max) ? max : Z_BASE,
            min: Number.isFinite(min) ? min : Z_BASE,
        };
    } catch {
        return null;
    }
}

// Apply a z-index straight to the live element (same-origin iframe) so it reorders immediately without a
// reload — mirrors the Moveable layer's direct inline patch.
function applyZIndexDirect(view: any, domId: string, z: number): boolean {
    try {
        const doc: Document | undefined = view?.contentDocument;
        if (!doc) return false;
        const node = doc.querySelector(`[data-odid="${domId}"]`) as HTMLElement | null;
        if (!node) return false;
        node.style.setProperty('z-index', String(z));
        return true;
    } catch {
        return false;
    }
}

export class ElementsManager {
    private _hovered: DomElement | undefined;
    private _selected: DomElement[] = [];
    // True when the single selected element was created by Design (img/video, or any element carrying
    // the persistent `data-cc-created="design"` marker). Drives the Moveable gate so original flow
    // content (hero/card/h1/p) never becomes freely movable. Resolved async (getActionElement reads
    // the live attribute) since DomElement doesn't carry arbitrary attributes.
    selectedIsDesignCreated = false;
    // True when the single selected element is an ORIGINAL converted to free editing (data-cc-editable),
    // as opposed to a Design-created insert (media/box/text). Only these can be reverted to static.
    selectedIsConverted = false;
    // True when the single selected element is freely-editable BUT pinned in place (data-cc-locked):
    // it keeps its absolute geometry and Moveable releases it. Drives the "static" half of the toggle.
    selectedIsLocked = false;
    // Oids pinned-in-place this session (mirrors locallyEditableOids for the lock state).
    private lockedOids = new Set<string>();
    // Highest z-index handed out this session by "traer al frente". Climbs above Z_BASE so each call
    // tops everything previously fronted. ponytail: per-session counter, not a true sibling max — re-
    // click "al frente" if a value persisted from a past session outranks it.
    private zTop = Z_BASE;
    // Lowest z-index handed out by "enviar al fondo". Sinks below Z_BASE (floored at 1, never negative)
    // so each call goes under everything previously sent back without vanishing behind opaque content.
    private zBottom = Z_BASE;
    // Oids of ORIGINAL elements converted to free editing this session. Lets the Moveable gate light up
    // immediately after a conversion (no reload), while the persistent data-cc-editable marker (written
    // to the source) is what survives across sessions.
    private locallyEditableOids = new Set<string>();
    // Subset of locallyEditableOids that are CONVERTED ORIGINALS (data-cc-editable), so "Volver a
    // estático" is offered for them but never for inserted media/box/text.
    private convertedOids = new Set<string>();

    constructor(private editorEngine: EditorEngine) {
        makeAutoObservable(this);
    }

    /** Computed position of the single selection ('static' for flow elements). */
    private get selectedPosition(): string | undefined {
        const el = this._selected.length === 1 ? this._selected[0] : null;
        return el?.styles?.computed?.position;
    }

    /** Whether the selection is taken out of flow (Moveable can only drive absolute/fixed boxes). */
    private get selectedIsAbsolute(): boolean {
        const p = this.selectedPosition;
        return p === 'absolute' || p === 'fixed';
    }

    /** Whether the (single) selected element is currently movable/resizable by Moveable. Requires it to
     *  be out of flow (absolute/fixed): a flow img/video can't be dragged until it's pinned. Locked
     *  elements keep their geometry but are NOT movable, so they read as static here. */
    get selectedIsFreelyEditable(): boolean {
        const el = this._selected.length === 1 ? this._selected[0] : null;
        if (!el) return false;
        if (this.selectedIsLocked) return false;
        if (!this.selectedIsAbsolute) return false;
        const tag = el.tagName?.toLowerCase();
        if (tag === 'img' || tag === 'video') return true;
        return this.selectedIsDesignCreated;
    }

    /** A static (in-flow) element that can be PINNED absolute to make it movable — originals AND media.
     *  Excludes elements already out of flow (those are either movable or locked, handled elsewhere). */
    private get selectedCanPin(): boolean {
        const el = this._selected.length === 1 ? this._selected[0] : null;
        if (!el) return false;
        if (this.selectedIsAbsolute) return false; // already positioned
        const tag = el.tagName?.toLowerCase();
        if (!tag || NON_CONVERTIBLE_TAGS.has(tag)) return false;
        const rect = el.rect as { width?: number; height?: number } | undefined;
        return !!rect && (rect.width ?? 0) >= 1 && (rect.height ?? 0) >= 1;
    }

    /** Whether "Convertir a edición libre" should be offered: a static element that can become movable
     *  — either a locked one (unlock in place) or a flow element (pin absolute). */
    get selectedCanConvertToEditable(): boolean {
        if (this.selectedIsFreelyEditable) return false;
        return this.selectedIsLocked || this.selectedCanPin;
    }

    /** Whether "Volver a estático" should be offered: any freely-movable element (media, insert, or
     *  converted original) — making it static pins it in place (keeps geometry, releases Moveable). */
    get selectedCanRevertToStatic(): boolean {
        return this.selectedIsFreelyEditable;
    }

    /** Whether z-order ("traer al frente" / "enviar al fondo") applies: any positioned element (free or
     *  pinned). z-index only affects out-of-flow boxes that can overlap. */
    get selectedCanReorder(): boolean {
        return this._selected.length === 1 && (this.selectedIsAbsolute || this.selectedIsLocked);
    }

    // Arrow-field methods (same pattern as HistoryManager.push / OverlayManager.undebouncedRefresh):
    // makeAutoObservable turns these into bound actions, so setting the observable from the async
    // continuation is safe and never throws during engine construction.
    private setSelectedIsDesignCreated = (value: boolean) => {
        this.selectedIsDesignCreated = value;
    };

    private setSelectedIsConverted = (value: boolean) => {
        this.selectedIsConverted = value;
    };

    private setSelectedIsLocked = (value: boolean) => {
        this.selectedIsLocked = value;
    };

    private resolveDesignCreated = async (domEl: DomElement | null) => {
        if (!domEl) {
            this.setSelectedIsDesignCreated(false);
            this.setSelectedIsConverted(false);
            this.setSelectedIsLocked(false);
            return;
        }
        const tag = domEl.tagName?.toLowerCase();
        const localLocked = !!domEl.oid && this.lockedOids.has(domEl.oid);
        if (tag === 'img' || tag === 'video') {
            this.setSelectedIsDesignCreated(true);
            this.setSelectedIsConverted(false); // media inserts aren't "convertible originals"
            this.setSelectedIsLocked(localLocked);
            return;
        }
        // Converted this session -> recognized immediately (the source marker may not be live yet).
        if (domEl.oid && this.locallyEditableOids.has(domEl.oid)) {
            this.setSelectedIsDesignCreated(true);
            this.setSelectedIsConverted(this.convertedOids.has(domEl.oid));
            this.setSelectedIsLocked(localLocked);
            return;
        }
        try {
            const view = this.editorEngine.frames.get(domEl.frameId)?.view;
            const actionEl = (await view?.getActionElement(domEl.domId)) as
                | { attributes?: Record<string, string> }
                | undefined;
            const attrs = actionEl?.attributes ?? {};
            const isLocked = attrs[CC_LOCKED_ATTR] === CC_LOCKED_VALUE || localLocked;
            if (isLocked && domEl.oid) this.lockedOids.add(domEl.oid);
            this.setSelectedIsLocked(isLocked);
            const isConverted = attrs[CC_EDITABLE_ATTR] === CC_EDITABLE_VALUE;
            const isEditable = attrs[CC_CREATED_ATTR] === CC_CREATED_VALUE || isConverted;
            // Cache the durable recognition into the session set so later re-selections (and click()'s
            // synchronous fast-path) don't have to re-read the attribute and won't flicker the gate.
            if (isEditable && domEl.oid) this.locallyEditableOids.add(domEl.oid);
            if (isConverted && domEl.oid) this.convertedOids.add(domEl.oid);
            this.setSelectedIsDesignCreated(isEditable);
            this.setSelectedIsConverted(isConverted);
        } catch {
            this.setSelectedIsDesignCreated(false);
            this.setSelectedIsConverted(false);
            this.setSelectedIsLocked(localLocked);
        }
    };

    /**
     * Converts the selected ORIGINAL flow element into a freely movable/resizable one, WITHOUT
     * reparenting or touching its classes/children. Pins it where it currently sits by writing inline
     * position:absolute + left/top/width/height (left/top relative to its offset parent = the
     * containing block once absolute, so it doesn't jump) and stamps the persistent data-cc-editable
     * marker. The Moveable gate then activates via the local set (immediately) and the source marker
     * (future sessions). Heavily guarded: never html/body/etc., media, zero-size, or already-movable.
     */
    convertSelectedToEditable = async () => {
        const el = this._selected.length === 1 ? this._selected[0] : null;
        if (!el) return;
        try {
            // A locked (pinned-in-place) element just gets released — keep its geometry, no re-pinning.
            if (this.selectedIsLocked) {
                await this.unlockSelected(el);
                return;
            }
            if (!this.selectedCanPin) {
                toast.warning('Este elemento no se puede convertir a edición libre.');
                return;
            }
            await this.convertOriginalToEditable(el);
        } catch (err) {
            // Surface the failure instead of swallowing the rejected promise (the old `void` path made
            // a broken convert look like "nothing happened" with no toast and no log).
            console.error('[CC] convertSelectedToEditable failed', err);
            toast.error('No se pudo convertir a edición libre.');
        }
    };

    // Reads the element's CURRENT computed typography/color and returns them as inline styles, so they
    // survive the move out of its parent: inherited color/font and descendant-selector rules (e.g.
    // `.hero h1 { color:#fff }`) don't follow the node to <body>. Best-effort; on failure the element
    // keeps editing but may restyle.
    private capturePreservedStyles = async (el: DomElement): Promise<Record<string, string>> => {
        const out: Record<string, string> = {};
        try {
            const view = this.editorEngine.frames.get(el.frameId)?.view;
            const cs = (await view?.getComputedStyleByDomId(el.domId)) as Record<string, string> | null;
            if (!cs) return out;
            const read = (camel: string, kebab: string) => cs[camel] ?? cs[kebab];
            // [outputKey (camelCase, the writer kebab-cases it), computedCamel, computedKebab]
            const props: Array<[string, string, string]> = [
                ['color', 'color', 'color'],
                ['fontFamily', 'fontFamily', 'font-family'],
                ['fontSize', 'fontSize', 'font-size'],
                ['fontWeight', 'fontWeight', 'font-weight'],
                ['fontStyle', 'fontStyle', 'font-style'],
                ['lineHeight', 'lineHeight', 'line-height'],
                ['letterSpacing', 'letterSpacing', 'letter-spacing'],
                ['textAlign', 'textAlign', 'text-align'],
                ['textTransform', 'textTransform', 'text-transform'],
            ];
            for (const [outKey, camel, kebab] of props) {
                const v = read(camel, kebab);
                // Always keep color/fonts; skip pure-default values for the optional ones to avoid clutter.
                if (!v) continue;
                if ((v === 'normal' || v === 'none' || v === 'start') && outKey !== 'color') continue;
                out[outKey] = v;
            }
        } catch {
            /* best-effort: appearance may shift if computed styles aren't reachable */
        }
        return out;
    };

    // Converts an ORIGINAL flow element to free editing by LIFTING it to the shared <body> canvas layer
    // (reparent) and pinning it absolute at its current DOCUMENT position. Reparenting is what lets every
    // freed object share ONE stacking context, so z-order and free movement work globally instead of the
    // element being trapped inside its card's stacking context. Source-only mutation + reload: the file
    // is the source of truth and the live DOM re-renders from it (no fragile cross-parent live surgery).
    private convertOriginalToEditable = async (el: DomElement) => {
        const rect = el.rect as { left: number; top: number; width: number; height: number } | undefined;
        if (!rect) return;

        // Document-space coords (rect is in frame/document space; <body> is the offset parent at 0,0), so
        // the element stays exactly where it sits visually after the move to body.
        const left = Math.round(rect.left);
        const top = Math.round(rect.top);
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));

        if (el.oid) {
            this.locallyEditableOids.add(el.oid);
            this.convertedOids.add(el.oid);
        }
        this.setSelectedIsDesignCreated(true);
        this.setSelectedIsConverted(true);

        const frame = this.editorEngine.frames.get(el.frameId)?.frame;
        let pathname = '/';
        try {
            if (frame?.url) pathname = new URL(frame.url).pathname;
        } catch {
            /* keep default */
        }

        // Snapshot inherited/parent-dependent appearance (color, fonts) so the element doesn't restyle
        // when it leaves its parent (e.g. `.hero h1`'s white color won't follow it to <body>).
        const preserved = await this.capturePreservedStyles(el);

        // Bring it to the front as it lands on the canvas, so it's visible above existing positioned
        // siblings (a converted element with no z would otherwise hide behind a z-indexed card/hero).
        this.zTop += 1;

        // Reparent to <body> + pin absolute + stamp the marker, all in the source. Awaited so the reload
        // below reads the moved node.
        const result = await applyHtmlReparentToBody(
            el.oid ?? undefined,
            {
                ...preserved,
                position: 'absolute',
                left: `${left}px`,
                top: `${top}px`,
                width: `${width}px`,
                height: `${height}px`,
                zIndex: String(this.zTop),
            },
            pageFileForPathname(pathname),
        );
        // Don't claim success (or reload) if the source write failed: roll the optimistic state back so
        // the menu still offers "convertir" instead of a half-converted element that can't be fixed.
        if (!result.ok) {
            if (el.oid) {
                this.locallyEditableOids.delete(el.oid);
                this.convertedOids.delete(el.oid);
            }
            this.setSelectedIsDesignCreated(false);
            this.setSelectedIsConverted(false);
            console.error('[CC] reparent-to-body failed', result);
            toast.error('No se pudo convertir a edición libre.');
            return;
        }

        // Reload so the live DOM rebuilds from the corrected source. The element's domId regenerates, so
        // selection clears (the user re-clicks); the overlay refresh keeps the canvas in sync.
        const view = this.editorEngine.frames.get(el.frameId)?.view;
        try {
            view?.reload();
        } catch {
            /* best-effort */
        }
        void this.editorEngine.overlay.refresh();
        toast.success('Elemento convertido a edición libre (en el lienzo).');
    };

    /**
     * "Volver a estático" = PIN IN PLACE. Keeps the element's current absolute geometry but stamps
     * data-cc-locked so Moveable releases it — it stays exactly where the user dropped it instead of
     * jumping back to flow (the old strip-geometry behavior). Works for media, inserts, and converted
     * originals alike. Reverse of unlockSelected.
     */
    convertSelectedToStatic = async () => {
        const el = this._selected.length === 1 ? this._selected[0] : null;
        if (!el || !this.selectedCanRevertToStatic) return;
        try {
            if (el.oid) this.lockedOids.add(el.oid);
            this.setSelectedIsLocked(true);
            await applyHtmlAttrEdit(
                el.oid ?? undefined,
                { [CC_LOCKED_ATTR]: CC_LOCKED_VALUE },
                this.pageFileFor(el),
            );
            void this.editorEngine.overlay.refresh();
            toast.success('Elemento fijado en su lugar.');
        } catch (err) {
            console.error('[CC] convertSelectedToStatic failed', err);
            toast.error('No se pudo fijar el elemento.');
        }
    };

    // Releases a pinned (data-cc-locked) element back to free editing, keeping its geometry. Throws are
    // handled by the public caller (convertSelectedToEditable).
    private unlockSelected = async (el: DomElement) => {
        if (el.oid) this.lockedOids.delete(el.oid);
        this.setSelectedIsLocked(false);
        await applyHtmlAttrEdit(el.oid ?? undefined, { [CC_LOCKED_ATTR]: null }, this.pageFileFor(el));
        void this.editorEngine.overlay.refresh();
        toast.success('Elemento liberado para edición libre.');
    };

    // Resolves the source .html file backing the element's current page (frame URL -> pathname).
    private pageFileFor = (el: DomElement): string => {
        const frame = this.editorEngine.frames.get(el.frameId)?.frame;
        let pathname = '/';
        try {
            if (frame?.url) pathname = new URL(frame.url).pathname;
        } catch {
            /* keep default */
        }
        return pageFileForPathname(pathname);
    };

    /** True when the element is a DIRECT child of <body> (the shared canvas stacking layer). An element
     *  freed INSIDE a card stays trapped in that card's stacking context, so z-order can't lift it above
     *  sibling cards until it's reparented to body. */
    private isBodyChild = async (el: DomElement): Promise<boolean> => {
        const view = this.editorEngine.frames.get(el.frameId)?.view;
        const parent = (await view?.getParentElement(el.domId)) as DomElement | null;
        return parent?.tagName?.toLowerCase() === 'body';
    };

    /** Reparents the element to <body> at its CURRENT document position with the given z-index (source +
     *  reload). Used so reordering a trapped (nested-free) element lifts it onto the shared canvas layer,
     *  where z-order is global. Mirrors convertOriginalToEditable's reparent. Returns false on write fail. */
    private reparentToBodyAtCurrentPos = async (el: DomElement, zIndex: number): Promise<boolean> => {
        const rect = el.rect as { left: number; top: number; width: number; height: number } | undefined;
        if (!rect) return false;
        const left = Math.round(rect.left);
        const top = Math.round(rect.top);
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        const frame = this.editorEngine.frames.get(el.frameId)?.frame;
        let pathname = '/';
        try {
            if (frame?.url) pathname = new URL(frame.url).pathname;
        } catch {
            /* keep default */
        }
        const preserved = await this.capturePreservedStyles(el);
        const result = await applyHtmlReparentToBody(
            el.oid ?? undefined,
            {
                ...preserved,
                position: 'absolute',
                left: `${left}px`,
                top: `${top}px`,
                width: `${width}px`,
                height: `${height}px`,
                zIndex: String(zIndex),
            },
            pageFileForPathname(pathname),
        );
        if (!result.ok) {
            console.error('[CC] reparent-for-reorder failed', result);
            return false;
        }
        try {
            this.editorEngine.frames.get(el.frameId)?.view?.reload();
        } catch {
            /* best-effort */
        }
        void this.editorEngine.overlay.refresh();
        return true;
    };

    /** "Traer al frente": z-index above every positioned element actually on the page. A nested-free
     *  element is reparented to <body> first so the z-order is global, not trapped in its card. */
    bringSelectedToFront = async () => {
        const el = this._selected.length === 1 ? this._selected[0] : null;
        if (!el || !this.selectedCanReorder) return;
        try {
            const view = this.editorEngine.frames.get(el.frameId)?.view;
            const extent = readFrameZExtent(view, el.domId);
            // Top the REAL max on the page, and never below our session high-water mark.
            const target = Math.max(this.zTop, extent?.max ?? Z_BASE) + 1;
            this.zTop = target;
            if (!(await this.isBodyChild(el))) {
                const ok = await this.reparentToBodyAtCurrentPos(el, target);
                toast[ok ? 'success' : 'error'](ok ? 'Traído al frente.' : 'No se pudo traer al frente.');
                return;
            }
            await this.editorEngine.style.updateMultiple({ zIndex: String(target) });
            applyZIndexDirect(view, el.domId, target);
            toast.success('Traído al frente.');
        } catch (err) {
            console.error('[CC] bringSelectedToFront failed', err);
            toast.error('No se pudo traer al frente.');
        }
    };

    /** "Enviar al fondo": z-index below every positioned element on the page, floored at 1 so it never
     *  vanishes behind page content. A nested-free element is reparented to <body> first. */
    sendSelectedToBack = async () => {
        const el = this._selected.length === 1 ? this._selected[0] : null;
        if (!el || !this.selectedCanReorder) return;
        try {
            const view = this.editorEngine.frames.get(el.frameId)?.view;
            const extent = readFrameZExtent(view, el.domId);
            const target = Math.max(1, Math.min(this.zBottom, extent?.min ?? Z_BASE) - 1);
            this.zBottom = target;
            if (!(await this.isBodyChild(el))) {
                const ok = await this.reparentToBodyAtCurrentPos(el, target);
                toast[ok ? 'success' : 'error'](ok ? 'Enviado al fondo.' : 'No se pudo enviar al fondo.');
                return;
            }
            await this.editorEngine.style.updateMultiple({ zIndex: String(target) });
            applyZIndexDirect(view, el.domId, target);
            toast.success('Enviado al fondo.');
        } catch (err) {
            console.error('[CC] sendSelectedToBack failed', err);
            toast.error('No se pudo enviar al fondo.');
        }
    };

    /** Marks an oid as freely editable for this session (used after re-selection so oid drift across
     *  a write/reload doesn't drop the Moveable gate). No-op for empty oids. */
    markOidEditable = (oid: string | undefined) => {
        if (oid) this.locallyEditableOids.add(oid);
    };

    get hovered() {
        return this._hovered;
    }

    get selected() {
        return this._selected;
    }

    set selected(elements: DomElement[]) {
        this._selected = elements;
    }

    mouseover(domEl: DomElement) {
        const frameData = this.editorEngine.frames.get(domEl.frameId);
        if (!frameData?.view) {
            console.error('No frame view found');
            return;
        }
        if (this._hovered?.domId && this._hovered.domId === domEl.domId) {
            return;
        }

        const frameEl: DomElement = {
            ...domEl,
            frameId: frameData.frame.id,
        };
        const { view } = frameData;
        const adjustedRect = adaptRectToCanvas(frameEl.rect, view);
        const isComponent = !!domEl.instanceId;
        this.editorEngine.overlay.state.updateHoverRect(adjustedRect, isComponent);
        this.setHoveredElement(frameEl);
    }

    shiftClick(domEl: DomElement) {
        const selectedEls = this.selected;
        const isAlreadySelected = selectedEls.some((el) => el.domId === domEl.domId);
        let newSelectedEls: DomElement[] = [];
        if (isAlreadySelected) {
            newSelectedEls = selectedEls.filter((el) => el.domId !== domEl.domId);
        } else {
            newSelectedEls = [...selectedEls, domEl];
        }
        this.click(newSelectedEls);
    }

    click(domEls: DomElement[]) {
        this.editorEngine.overlay.state.removeClickRects();
        this.clearSelectedElements();

        for (const domEl of domEls) {
            const frameData = this.editorEngine.frames.get(domEl.frameId);
            if (!frameData) {
                console.error('Frame data not found');
                continue;
            }
            const { view } = frameData;
            if (!view) {
                console.error('No frame view found');
                continue;
            }
            const adjustedRect = adaptRectToCanvas(domEl.rect, view);
            const isComponent = !!domEl.instanceId;
            this.editorEngine.overlay.state.addClickRect(
                adjustedRect,
                domEl.styles,
                isComponent,
                domEl.domId,
            );
            this._selected.push(domEl);
        }

        // Resolve the Design-created marker for the (single) selection so the Moveable gate can decide
        // whether to attach handles. Multi-selection or none -> not movable.
        const single = this._selected.length === 1 ? this._selected[0] : null;
        // SYNCHRONOUS fast-path: for the cases we can decide without a round-trip (media, or an element
        // already known editable this session), set the flag NOW. clearSelectedElements() just reset it
        // to false; without this, the gate would flicker off for a frame after a move/resize re-select
        // and the legacy red overlay would flash over the element until the async resolve lands.
        if (single) {
            const tag = single.tagName?.toLowerCase();
            if (tag === 'img' || tag === 'video' || (single.oid && this.locallyEditableOids.has(single.oid))) {
                this.selectedIsDesignCreated = true;
                this.selectedIsConverted = !!single.oid && this.convertedOids.has(single.oid);
            }
            this.selectedIsLocked = !!single.oid && this.lockedOids.has(single.oid);
        }
        // Still resolve async to cover the cross-session case (attribute read via getActionElement).
        void this.resolveDesignCreated(single);
    }

    setHoveredElement(element: DomElement) {
        this._hovered = element;
    }

    clearHoveredElement() {
        this._hovered = undefined;
    }

    emitError(error: string) {
        console.error(error);
        toast.error('Cannot delete element', { description: error });
    }

    async delete() {
        const selected = this.selected;
        if (selected.length === 0) {
            return;
        }

        for (const selectedEl of selected) {
            const frameId = selectedEl.frameId;
            const frameData = this.editorEngine.frames.get(frameId);
            if (!frameData?.view) {
                console.error('No frame view found');
                return;
            }
            const { shouldDelete, error } = await this.shouldDelete(selectedEl, frameData);

            if (!shouldDelete) {
                this.emitError(error ?? 'Unknown error');
                return;
            }

            const removeAction: RemoveElementAction | null = await frameData.view.getRemoveAction(
                selectedEl.domId,
                frameId,
            );

            if (!removeAction) {
                this.emitError('Remove action not found. Try refreshing the page.');
                return;
            }
            const oid = selectedEl.instanceId ?? selectedEl.oid;
            debugLog('[CC-DELETE] selected id', { domId: selectedEl.domId, oid, tag: selectedEl.tagName });
            if (!oid) {
                this.emitError('OID not found. Try refreshing the page.');
                return;
            }

            // Static HTML projects have no JSX/oid metadata pipeline. The remove-element action is
            // persisted by applyHtmlRemove via the element's data-cc-id (target.oid), so we must NOT
            // require a JSX code block here (that requirement made Delete silently no-op on HTML).
            const isHtml = getActiveProject()?.framework === 'html';
            if (!isHtml) {
                const branchData = this.editorEngine.branches.getBranchDataById(selectedEl.branchId);
                if (!branchData) {
                    this.emitError(`Branch data not found for branchId: ${selectedEl.branchId}. Try refreshing the page.`);
                    return;
                }

                const metadata = await branchData.codeEditor.getJsxElementMetadata(oid);

                if (!metadata?.code) {
                    this.emitError('Code block not found. Try refreshing the page.');
                    return;
                }

                removeAction.codeBlock = metadata.code;
            }

            this.editorEngine.action.run(removeAction)
                .then(() => debugLog('[CC-DELETE] writeback result: action dispatched', { oid }))
                .catch((err) => {
                    console.error('[CC-DELETE] Error deleting element', err);
                });
        }
    }

    private async shouldDelete(
        selectedEl: DomElement,
        frameData: FrameData,
    ): Promise<{
        shouldDelete: boolean;
        error?: string;
    }> {
        const instanceId = selectedEl.instanceId;

        if (!instanceId) {
            if (!frameData.view) {
                console.error('No frame view found');
                return {
                    shouldDelete: false,
                    error: 'No frame view found',
                };
            }

            const result = await frameData.view.getElementType(selectedEl.domId);
            const { dynamicType, coreType } = result;

            if (coreType) {
                const CORE_ELEMENTS_MAP: Record<CoreElementType, string> = {
                    'component-root': 'Component Root',
                    'body-tag': 'Body Tag',
                };

                return {
                    shouldDelete: false,
                    error: `This is a ${CORE_ELEMENTS_MAP[coreType]} and cannot be deleted`,
                };
            }

            if (dynamicType) {
                const DYNAMIC_TYPES_MAP: Record<DynamicType, string> = {
                    array: 'Array',
                    conditional: 'Conditional',
                    unknown: 'Unknown',
                };

                return {
                    shouldDelete: false,
                    error: `This element is a(n) ${DYNAMIC_TYPES_MAP[dynamicType]} and cannot be deleted`,
                };
            }
        }

        return {
            shouldDelete: true,
        };
    }

    clear() {
        this.clearHoveredElement();
        this.clearSelectedElements();
    }

    private clearSelectedElements() {
        this.selected = [];
        this.selectedIsDesignCreated = false;
        this.selectedIsConverted = false;
        this.selectedIsLocked = false;
    }
}
