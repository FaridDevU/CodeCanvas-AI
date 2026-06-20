// Moveable-based transform layer for the Design canvas.
//
// This is NOT a second editor: it is only the visual interaction layer (drag + resize handles) for
// the currently selected element, replacing the brittle legacy MoveManager/ResizeHandles path. The
// real element lives inside the preview iframe, so Moveable targets a lightweight PROXY <div>
// positioned over it (the same screen-space rect the overlay already computes).
//
// CRITICAL — React must NOT own the proxy's geometry. Moveable writes left/top/width/height/transform
// straight onto its target during a gesture; if React also drove those inline styles the two fought:
// clearing them on gesture end collapsed the proxy to a point, and a leftover transform detached the
// control box from the element. So the proxy is sized/positioned IMPERATIVELY here (useLayoutEffect)
// when idle, and Moveable owns it outright during a gesture. The real element + HTML are updated once
// on gesture END via the existing pipeline: style.updateMultiple -> update-style -> applyHtmlStyleEdit.
//
// Scope/safety: only single-selection, absolutely-positioned elements (the media/text Design inserts)
// get handles. Hidden in Preview/text-edit and while a right-click context menu is open.

import { debugLog, debugWarn } from '@/lib/debug';
import { ccLog } from '@/lib/cc-moveable-debug';
import { useEditorEngine } from '@/components/store/editor';
import { RightClickMenu } from '../../right-click-menu';
import { EditorMode } from '@onlook/models';
import { StyleChangeType } from '@onlook/models/style';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Moveable from 'react-moveable';

function num(value: string | undefined, fallback = 0): number {
    const n = parseFloat(value ?? '');
    return Number.isFinite(n) ? n : fallback;
}

// camelCase -> kebab-case for CSSStyleDeclaration.setProperty (left/top/width/height pass through).
function toKebab(prop: string): string {
    return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

// Apply inline styles straight onto the real element inside the SAME-ORIGIN preview iframe, found by
// its durable dom id (data-odid). This is the live visual update that lets a normal move/resize skip
// the reload fallback: setting element.style.* wins over the element's own inline geometry, which the
// preload's stylesheet-based updateStyle could not override. Returns false (so the caller keeps the
// reload safety net) if the document/element isn't reachable.
function applyInlineStyleDirect(
    view: any,
    domId: string,
    styles: Record<string, string>,
): boolean {
    try {
        const doc: Document | undefined = view?.contentDocument;
        if (!doc) return false;
        const node = doc.querySelector(`[data-odid="${domId}"]`) as HTMLElement | null;
        if (!node) return false;
        for (const [key, value] of Object.entries(styles)) {
            node.style.setProperty(toKebab(key), value);
        }
        return true;
    } catch {
        // Cross-origin or detached document: fall back to the reload path.
        return false;
    }
}

// Reads the element's CURRENT geometry (CSS px; left/top in offset-parent space, the same space we
// persist) straight from the same-origin preview iframe. Used so a NEW gesture captures a fresh base
// even when the previous gesture's async reselect hasn't refreshed the cached DomElement yet — without
// this, a quick second drag started from a stale position and the element jumped or didn't move.
function readLiveGeom(
    view: any,
    domId: string,
): { left: number | null; top: number | null; width: number; height: number } | null {
    try {
        const doc: Document | undefined = view?.contentDocument;
        if (!doc) return null;
        const node = doc.querySelector(`[data-odid="${domId}"]`) as HTMLElement | null;
        const win = doc.defaultView;
        if (!node || !win) return null;
        const cs = win.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const left = parseFloat(cs.left);
        const top = parseFloat(cs.top);
        return {
            left: Number.isFinite(left) ? left : null,
            top: Number.isFinite(top) ? top : null,
            width: rect.width,
            height: rect.height,
        };
    } catch {
        return null;
    }
}

export const MoveableSelectionLayer = observer(() => {
    const editorEngine = useEditorEngine();
    const overlay = editorEngine.overlay.state;
    // react-moveable's typings are loose across versions; treat the ref/events as any locally.
    const moveableRef = useRef<any>(null);
    const [proxy, setProxy] = useState<HTMLDivElement | null>(null);

    // Baseline element-space values (CSS px, for persisting to the real element) captured at gesture
    // start, plus the canvas scale at that moment.
    const base = useRef({ left: 0, top: 0, width: 0, height: 0 });
    // Baseline SCREEN-space rect of the proxy at gesture start (overlay coords = element rect * scale).
    // Used to reconcile the proxy imperatively at gesture end without waiting for the async overlay
    // refresh (which races the live DOM update and would otherwise leave a stale transform behind).
    const baseScreen = useRef({ left: 0, top: 0, width: 0, height: 0 });
    const scaleRef = useRef(1);
    // True only between onDragStart/onResizeStart and the matching End: Moveable owns the proxy then,
    // so the idle sync below must not overwrite the geometry Moveable is mid-applying.
    const gesturing = useRef(false);
    // DIAGNOSTIC: count onDrag/onResize ticks so we can tell from the log whether events fire at all.
    const dragTicks = useRef(0);
    const resizeTicks = useRef(0);

    const selected = editorEngine.elements.selected;
    const el = selected.length === 1 ? selected[0] : null;
    // IDENTITY MATCH (critical): only ever use the click rect whose id is the SELECTED element's domId.
    // `addClickRect` stores `id = domId` for both selection (`click()`) and overlay refresh, so this is
    // exact. Using `clickRects[0]` blindly mounted Moveable on a leftover/other-element rect during the
    // async gap between selecting and the overlay refresh -> the box was offset / didn't track the
    // element. If there's no rect for THIS element yet, mount nothing (a refresh will produce it).
    const clickRect = el ? (overlay.clickRects.find((r) => r.id === el.domId) ?? null) : null;
    const position = clickRect?.styles?.computed?.position;
    const isAbsolute = position === 'absolute' || position === 'fixed';
    // Degenerate (collapsed) rects belong to orphaned/zero-size elements (e.g. an image that wrote
    // width:0). Don't attach handles to them: resizing from a 0x0 box produces garbage and creates
    // more orphans. Require a real, measurable box.
    const hasRealSize = !!clickRect && clickRect.width >= 1 && clickRect.height >= 1;
    // SAFETY GATE: free move/resize is ONLY for things Design created — media (img/video, always
    // absolute-anchored) OR any element stamped with the persistent `data-cc-created="design"` marker
    // (inserted boxes/text). Original flow content (hero, card, h1, p, containers) must NEVER enter the
    // move system — even if a past corrupt op left it position:absolute — or its layout breaks. The
    // marker is read async (elements.selectedIsDesignCreated, via getActionElement) since DomElement
    // carries no attributes.
    const tag = el?.tagName?.toLowerCase();
    const isMovableMedia = tag === 'img' || tag === 'video';
    const isDesignCreated = editorEngine.elements.selectedIsDesignCreated;
    // Pinned-in-place ("static") elements keep their geometry but must NOT get Moveable handles.
    const isLocked = editorEngine.elements.selectedIsLocked;
    const active = !!(
        el &&
        clickRect &&
        hasRealSize &&
        isAbsolute &&
        (isMovableMedia || isDesignCreated) &&
        !isLocked &&
        editorEngine.state.editorMode === EditorMode.DESIGN &&
        !editorEngine.text.isEditing
        // NOTE: do NOT gate on rightClickMenuOpen here. This layer now hosts its OWN context menu
        // (right-click on the box); gating on it would unmount the layer the instant the menu opens,
        // closing it. Handles staying visible behind the open menu is harmless.
    );

    // If the selected element has no matching click rect yet (just selected / overlay not refreshed),
    // request a refresh so the correct rect is produced by identity — instead of mounting on a wrong
    // one. Fires once per (element, missing-rect) state; never loops (deps don't change if no rect
    // appears because the element is gone).
    useEffect(() => {
        if (el && !clickRect && !gesturing.current) {
            void editorEngine.overlay.refresh();
        }
    }, [el?.domId, clickRect]);

    // DIAGNOSTIC: log every transition of `active` with all gate inputs, so the log shows whether
    // Moveable mounts, why it would unmount, and (critically) if it unmounts MID-GESTURE.
    useEffect(() => {
        ccLog('active-change', {
            active,
            midGesture: gesturing.current,
            domId: el?.domId,
            oid: el?.oid,
            tag,
            hasClickRect: !!clickRect,
            clickRectId: clickRect?.id,
            clickRectCount: overlay.clickRects.length,
            position,
            isAbsolute,
            hasRealSize,
            isMovableMedia,
            isDesignCreated,
            mode: editorEngine.state.editorMode,
            textEditing: editorEngine.text.isEditing,
        });
        if (!active && gesturing.current) {
            ccLog('UNMOUNT-DURING-GESTURE', { domId: el?.domId });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    // Single source of truth for the proxy geometry while idle. Runs before paint so Moveable always
    // measures a correctly-sized target (and re-glues after a gesture once the overlay rect refreshes).
    useLayoutEffect(() => {
        if (gesturing.current || !proxy || !clickRect) return;
        proxy.style.left = `${clickRect.left}px`;
        proxy.style.top = `${clickRect.top}px`;
        proxy.style.width = `${clickRect.width}px`;
        proxy.style.height = `${clickRect.height}px`;
        proxy.style.transform = '';
        moveableRef.current?.updateRect();
        const r = proxy.getBoundingClientRect();
        debugLog('[CC-MOVEABLE] target rect', {
            left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height),
        });
    }, [proxy, clickRect?.left, clickRect?.top, clickRect?.width, clickRect?.height, active]);

    if (!active || !clickRect || !el) {
        return null;
    }

    const px = (n: number) => `${Math.round(n)}px`;

    // Keep moved/resized elements inside the building frame so they can't be dragged off-screen and
    // lost. Clamps element-space left/top to [0, frameW-w] x [0, frameH-h]; if the element is bigger
    // than the frame, pins to 0 (never NaN). Applies to media, inserted boxes/text and freed blocks.
    const frameDim = editorEngine.frames.get(el.frameId)?.frame.dimension;
    const clampToFrame = (left: number, top: number, width: number, height: number) => {
        if (!frameDim || !Number.isFinite(left) || !Number.isFinite(top)) {
            return { left, top };
        }
        const maxLeft = Math.max(0, frameDim.width - (Number.isFinite(width) ? width : 0));
        const maxTop = Math.max(0, frameDim.height - (Number.isFinite(height) ? height : 0));
        return {
            left: Math.min(Math.max(0, left), maxLeft),
            top: Math.min(Math.max(0, top), maxTop),
        };
    };

    const captureBase = () => {
        const c = el.styles?.computed ?? {};
        const rect = el.rect as { left?: number; top?: number; width?: number; height?: number } | undefined;
        const scale = editorEngine.canvas.scale || 1;
        // Read the live element first so consecutive drags start from the REAL current position (the
        // cached snapshot lags the async reselect). Fall back to the cached values if the live read
        // fails (e.g. proxy/iframe not reachable).
        const view = editorEngine.frames.get(el.frameId)?.view;
        const live = readLiveGeom(view, el.domId);
        base.current = {
            left: live?.left ?? num(c.left, rect?.left ?? 0),
            top: live?.top ?? num(c.top, rect?.top ?? 0),
            width: live?.width ?? num(c.width, rect?.width ?? clickRect.width / scale),
            height: live?.height ?? num(c.height, rect?.height ?? clickRect.height / scale),
        };
        baseScreen.current = {
            left: clickRect.left,
            top: clickRect.top,
            width: clickRect.width,
            height: clickRect.height,
        };
        scaleRef.current = scale;
    };

    // Glue the proxy to a final SCREEN-space rect and drop any transform Moveable left on it, then
    // re-measure so the control box snaps onto it. Done synchronously at gesture end so the box never
    // collapses to a point or drifts while the async overlay refresh catches up.
    const reconcileProxy = (screen: { left: number; top: number; width: number; height: number }) => {
        if (!proxy) return;
        proxy.style.left = `${screen.left}px`;
        proxy.style.top = `${screen.top}px`;
        proxy.style.width = `${screen.width}px`;
        proxy.style.height = `${screen.height}px`;
        proxy.style.transform = '';
        moveableRef.current?.updateRect();
    };

    // Persist the final geometry. A LIVE DOM patch (penpal updateStyle on the selected element's domId)
    // moves/resizes the real element so the canvas updates without a reload, then the change is written
    // to the HTML file + history (the file is the source of truth). Re-selection afterwards is done by
    // IDENTITY (domId/oid), never by coordinates.
    const persist = async (styles: Record<string, string>) => {
        ccLog('persist-start', { domId: el.domId, oid: el.oid, tag: el.tagName, styles });
        debugLog('[CC-MOVEABLE] selected', {
            domId: el.domId,
            oid: el.oid,
            tagName: el.tagName,
            computed: {
                left: el.styles?.computed?.left,
                top: el.styles?.computed?.top,
                width: el.styles?.computed?.width,
                height: el.styles?.computed?.height,
                position: el.styles?.computed?.position,
            },
        });
        debugLog('[CC-MOVEABLE] persist start', {
            domId: el.domId,
            oid: el.oid,
            ...styles,
            scale: scaleRef.current,
        });

        const change = {
            updated: Object.fromEntries(
                Object.entries(styles).map(([key, value]) => [
                    key,
                    { value, type: StyleChangeType.Value },
                ]),
            ),
            original: Object.fromEntries(
                Object.entries(styles).map(([key]) => [
                    key,
                    {
                        value:
                            el.styles?.defined?.[key] ??
                            el.styles?.computed?.[key] ??
                            '',
                        type: StyleChangeType.Value,
                    },
                ]),
            ),
        };

        // 1. Persist to the HTML file + history FIRST.
        //
        // Do not move this after the live DOM patch. Moveable manipulates a visual proxy and the iframe
        // DOM can be patched before the source HTML is written. If the user immediately inserts text,
        // box or media during that gap, the insert reads the old source, writes it, then reloads the
        // frame. Visually that looks like the page reverted to an older checkpoint. Writing the source
        // first makes the HTML the committed state before any following insert/reload can happen.
        const action = {
            type: 'update-style' as const,
            targets: [
                {
                    frameId: el.frameId,
                    branchId: el.branchId,
                    domId: el.domId,
                    oid: el.oid,
                    change,
                },
            ],
        };
        try {
            await editorEngine.history.push(action as any);
            ccLog('persist-result', { domId: el.domId, ok: true });
            debugLog('[CC-MOVEABLE] persist result', { ok: true });
        } catch (error) {
            ccLog('persist-result', { domId: el.domId, ok: false, error: String(error) });
            debugLog('[CC-MOVEABLE] persist result', { ok: false, error: String(error) });
        }

        // 2. Live patch + verify it (a) is the SAME element by identity and (b) really moved/resized.
        // Identity must be confirmed: if updateStyle somehow returned a different element, accepting it
        // would re-select and then keep editing the wrong element. So require liveDomEl.oid === el.oid.
        const view = editorEngine.frames.get(el.frameId)?.view;
        let liveDomEl: any = null;
        if (view) {
            try {
                liveDomEl = await view.updateStyle(el.domId, JSON.parse(JSON.stringify(change)));
            } catch (err) {
                debugWarn('[CC-MOVEABLE] live updateStyle threw', err);
            }
        }

        // 1b. DIRECT INLINE PATCH (the real fix for the reload flicker).
        // WHY this exists: the Onlook preload's `view.updateStyle` applies geometry through a generated
        // stylesheet rule, but our inserted media/text carry left/top/width/height as INLINE styles
        // (higher specificity). The rule can't override inline, so the real element never actually
        // moved/resized — `view.updateStyle` still reported found:true/sameIdentity:true, the verify
        // step saw the element "stuck", and we fell back to a full frame reload on EVERY gesture (the
        // pantallazo). The preview iframe is SAME-ORIGIN, so we reach its document directly and set
        // element.style.* ourselves — that DOES win over inline and moves the real node, so the normal
        // path needs no reload. The reload below stays as a safety net for the rare case this fails.
        const directApplied = applyInlineStyleDirect(view, el.domId, styles);
        ccLog('direct-inline-patch', { domId: el.domId, applied: directApplied, styles });
        const oldRect: any = el.rect;
        const r: any = liveDomEl?.rect;
        const sameIdentity = !!(liveDomEl && el.oid && liveDomEl.oid === el.oid);
        const rectChanged = !!(
            r &&
            oldRect &&
            (Math.abs(r.left - oldRect.left) > 1 ||
                Math.abs(r.top - oldRect.top) > 1 ||
                Math.abs(r.width - oldRect.width) > 1 ||
                Math.abs(r.height - oldRect.height) > 1)
        );
        const liveApplied = sameIdentity && rectChanged;
        ccLog('live-update', {
            domId: el.domId, oid: el.oid, liveOid: liveDomEl?.oid,
            found: !!liveDomEl, sameIdentity, rectChanged, applied: liveApplied,
            oldRect: oldRect && { l: Math.round(oldRect.left), t: Math.round(oldRect.top), w: Math.round(oldRect.width), h: Math.round(oldRect.height) },
            newRect: r && { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        });
        debugLog('[CC-MOVEABLE] live update', {
            domId: el.domId, oid: el.oid, liveOid: liveDomEl?.oid,
            found: !!liveDomEl, sameIdentity, rectChanged, applied: liveApplied,
        });

        // 3. VERIFY the live DOM actually reached the requested geometry — this applies to BOTH resize
        // (width/height) AND move (left/top). LEARNING (this bug bit us repeatedly): Moveable only drives
        // a VISUAL PROXY in the parent doc; the real element lives in the iframe and `view.updateStyle`
        // sometimes does NOT apply the inline change to it (notably <img>). And `persist-result ok:true`
        // only means the change reached the FILE — it does NOT guarantee the live rect changed. So always
        // re-read the element's TRUE rect by domId and confirm it actually moved/resized.
        const reqW = styles.width != null ? parseFloat(styles.width) : null;
        const reqH = styles.height != null ? parseFloat(styles.height) : null;
        const reqL = styles.left != null ? parseFloat(styles.left) : null;
        const reqT = styles.top != null ? parseFloat(styles.top) : null;
        const TOL = 2;

        let fresh: any = null;
        if (view) {
            try {
                fresh = await view.getElementByDomId(el.domId, true);
            } catch (err) {
                debugWarn('[CC-MOVEABLE] reselect getElementByDomId threw', err);
            }
        }
        const fr: any = fresh?.rect;
        // Detect "stuck at OLD geometry" (live patch silently didn't take) rather than an exact match:
        // an exact match false-negatives for content-box els with padding (hero: border-box = style+64),
        // and requested left/top are offset-parent-relative while the rect is document-relative — so we
        // compare the fresh rect against the OLD rect (same coordinate space) and treat "didn't change"
        // as the failure. Covers width/height (resize) and left/top (move) identically.
        const wStuck =
            reqW != null && !!fr && !!oldRect &&
            Math.abs(fr.width - reqW) > TOL && Math.abs(fr.width - oldRect.width) <= TOL;
        const hStuck =
            reqH != null && !!fr && !!oldRect &&
            Math.abs(fr.height - reqH) > TOL && Math.abs(fr.height - oldRect.height) <= TOL;
        // Was a MOVE actually requested? A resize anchored at the top-left re-sends the SAME left/top
        // as before, so "the rect's left/top didn't change" is the CORRECT result, not a stuck patch.
        // Comparing the requested left/top to the element's own current (offset-parent-space) left/top
        // tells us whether a real move was asked for. Without this, every resize false-positived as
        // posStuck and forced a needless reload (the flicker). reqL/reqT are offset-parent-relative,
        // so we compare them against computed.left/top (same space), NOT against the document rect.
        const oldStyleLeft = num(el.styles?.computed?.left, NaN);
        const oldStyleTop = num(el.styles?.computed?.top, NaN);
        const moveRequested =
            (reqL != null && Number.isFinite(oldStyleLeft) && Math.abs(reqL - oldStyleLeft) > TOL) ||
            (reqT != null && Number.isFinite(oldStyleTop) && Math.abs(reqT - oldStyleTop) > TOL);
        const posStuck =
            moveRequested && !!fr && !!oldRect &&
            Math.abs(fr.left - oldRect.left) <= TOL && Math.abs(fr.top - oldRect.top) <= TOL;
        const needsReload = wStuck || hStuck || posStuck;
        ccLog('geom-check', {
            domId: el.domId,
            reqW, reqH, reqL, reqT,
            freshW: fr ? Math.round(fr.width) : null,
            freshH: fr ? Math.round(fr.height) : null,
            freshL: fr ? Math.round(fr.left) : null,
            freshT: fr ? Math.round(fr.top) : null,
            oldL: oldRect ? Math.round(oldRect.left) : null,
            oldT: oldRect ? Math.round(oldRect.top) : null,
            moveRequested, wStuck, hStuck, posStuck, needsReload,
        });

        if (fresh && !needsReload) {
            // Live DOM took the change (moved/resized toward the request): reselect by IDENTITY (never
            // clickRects[0], never coordinates), no reload (no flicker).
            editorEngine.elements.markOidEditable(el.oid ?? undefined);
            editorEngine.elements.markOidEditable(fresh.oid);
            editorEngine.elements.click([{ ...fresh, frameId: el.frameId }]);
            void editorEngine.overlay.refresh();
            ccLog('reselect-live-ok', { domId: el.domId, oid: fresh.oid });
            return;
        }

        // 3b. SAFETY NET (should now be rare): the live element stayed put even after the direct inline
        // patch (1b) — e.g. document not reachable, or a stylesheet !important winning. LEARNING: a
        // persist-result ok:true only confirms the change reached the FILE, NOT that the live DOM moved;
        // that's why this reload exists. In the normal path the direct inline patch already moved the real
        // node, so we never get here and there is no flicker. We keep the reload ONLY as a fallback: the
        // change IS in the file (persist-result ok), so re-render the frame from source, then reselect the
        // SAME element by OID (durable data-cc-id) — identity-verified, never grabs a different one.
        ccLog('geom-mismatch-reload', {
            domId: el.domId, oid: el.oid, reqW, reqH, reqL, reqT,
            freshW: fr ? Math.round(fr.width) : null, freshH: fr ? Math.round(fr.height) : null,
        });
        try {
            view?.reload();
        } catch (err) {
            debugWarn('[CC-MOVEABLE] frame reload failed', err);
        }
        // New center in FRAME coords (absolute els in <body> => style left/top ≈ document coords).
        const cx = (reqL ?? oldRect?.left ?? 0) + (reqW ?? fr?.width ?? oldRect?.width ?? 0) / 2;
        const cy = (reqT ?? oldRect?.top ?? 0) + (reqH ?? fr?.height ?? oldRect?.height ?? 0) / 2;
        await reselectByOidAfterReload(cx, cy, el.oid);
    };

    // After a reload (domId is reassigned, so getElementByDomId can't be used) re-select the SAME
    // element by OID. getElementAtLoc is only a LOCATOR here: we accept the hit ONLY if its oid equals
    // the expected one, so it can never grab a different element. If the identity never matches we leave
    // the selection as-is rather than select something wrong.
    const reselectByOidAfterReload = async (cx: number, cy: number, oid: string | undefined) => {
        if (!oid) {
            ccLog('reselect-after-reload-skip', { reason: 'no-oid' });
            return;
        }
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 150));
            const v = editorEngine.frames.get(el.frameId)?.view;
            if (!v) continue;
            try {
                const domEl: any = await v.getElementAtLoc(cx, cy, true);
                if (domEl && domEl.oid === oid) {
                    editorEngine.elements.markOidEditable(domEl.oid);
                    editorEngine.elements.click([domEl]);
                    void editorEngine.overlay.refresh();
                    ccLog('reselect-after-reload-ok', { oid, domId: domEl.domId, w: Math.round(domEl.rect?.width ?? 0), h: Math.round(domEl.rect?.height ?? 0) });
                    return;
                }
            } catch {
                /* frame still reloading; keep polling */
            }
        }
        ccLog('reselect-after-reload-timeout', { oid, cx: Math.round(cx), cy: Math.round(cy) });
    };

    return (
        // Wrapped in RightClickMenu so a right-click ON the Moveable box opens the same context menu
        // (Eliminar / Editar texto) as right-clicking the element directly. The control box sits on top
        // of the iframe, so without this the contextmenu never reached the gesture layer's menu.
        <RightClickMenu>
            {/* Zero-size wrapper (no footprint). It must NOT set pointer-events:none — Moveable's
                handles rely on the initial (auto) value and a `none` ancestor suppressed hit-testing. */}
            <div className="absolute top-0 left-0 h-0 w-0">
                {/* Geometry is set imperatively (see useLayoutEffect); React only fixes position/pointer. */}
                <div ref={setProxy} style={{ position: 'absolute', pointerEvents: 'none' }} />
            {proxy && (
                <Moveable
                    ref={moveableRef}
                    target={proxy}
                    draggable={true}
                    resizable={true}
                    // keepRatio MUST be off: with it on, an edge/middle handle keeps the aspect ratio,
                    // so it changes BOTH width and height and shifts position — i.e. a side handle drags
                    // like a corner. Off, each handle is independent (Moveable's drag.beforeTranslate
                    // already encodes the correct anchor per direction).
                    keepRatio={false}
                    origin={false}
                    throttleDrag={0}
                    throttleResize={0}
                    // The proxy is pointer-events:none (so it never blocks the iframe), and for a single
                    // target Moveable fires drags ON the target itself. With no clickable target there is
                    // nothing to start a center-drag from — handles still work (own pointer-events) but the
                    // box can't be moved. dragArea adds Moveable's own draggable center layer instead.
                    dragArea={true}
                    // DRAG (move) persists ONLY left/top — never width/height (those change only on
                    // resize). The clamp keeps left/top inside the frame in CSS coords (offset-parent
                    // space, same as persisted), and reselect after persist is always by identity
                    // (domId/oid), never by clickRects[0] or coordinates.
                    onDragStart={() => {
                        gesturing.current = true;
                        dragTicks.current = 0;
                        captureBase();
                        ccLog('dragStart', { domId: el.domId, oid: el.oid, tag, base: base.current, scale: scaleRef.current });
                        debugLog('[CC-MOVEABLE] onDragStart', { domId: el.domId, base: base.current, scale: scaleRef.current });
                    }}
                    onDrag={(e: any) => {
                        // Moveable owns the proxy during the gesture: translate it so the box follows.
                        e.target.style.transform = e.transform;
                        dragTicks.current++;
                        const s = scaleRef.current;
                        debugLog('[CC-MOVEABLE] drag', {
                            beforeLeft: base.current.left, beforeTop: base.current.top,
                            delta: e.delta, dist: e.dist,
                            nextLeft: Math.round(base.current.left + e.beforeTranslate[0] / s),
                            nextTop: Math.round(base.current.top + e.beforeTranslate[1] / s),
                            transform: e.transform, scale: s,
                        });
                    }}
                    onDragEnd={(e: any) => {
                        const last = e.lastEvent;
                        if (last) {
                            const s = scaleRef.current;
                            // Glue the proxy to its final position FIRST (screen space, no /scale) so the
                            // box stays put, then persist the element-space left/top to the real element.
                            reconcileProxy({
                                left: baseScreen.current.left + last.beforeTranslate[0],
                                top: baseScreen.current.top + last.beforeTranslate[1],
                                width: baseScreen.current.width,
                                height: baseScreen.current.height,
                            });
                            gesturing.current = false;
                            const newLeft = base.current.left + last.beforeTranslate[0] / s;
                            const newTop = base.current.top + last.beforeTranslate[1] / s;
                            const cl = clampToFrame(newLeft, newTop, base.current.width, base.current.height);
                            ccLog('dragEnd', { domId: el.domId, oid: el.oid, dragTicks: dragTicks.current, hasMovement: true, clampedLeft: Math.round(cl.left), clampedTop: Math.round(cl.top) });
                            void persist({ left: px(cl.left), top: px(cl.top) });
                        } else {
                            gesturing.current = false;
                            ccLog('dragEnd', { domId: el.domId, dragTicks: dragTicks.current, hasMovement: false });
                            void editorEngine.overlay.refresh();
                        }
                        debugLog('[CC-MOVEABLE] onDragEnd', { hasMovement: !!last });
                    }}
                    // RESIZE persists the full geometry (width/height + left/top, since corner/edge
                    // handles can re-anchor the box). width/height clamped to >= 1px; left/top clamped
                    // to the frame like drag.
                    onResizeStart={() => {
                        gesturing.current = true;
                        resizeTicks.current = 0;
                        captureBase();
                        ccLog('resizeStart', { domId: el.domId, oid: el.oid, tag, base: base.current, scale: scaleRef.current });
                        debugLog('[CC-MOVEABLE] onResizeStart', { domId: el.domId, base: base.current, scale: scaleRef.current });
                    }}
                    onResize={(e: any) => {
                        // Moveable owns the proxy: apply BOTH the new size and the keep-corner translate
                        // so the control box stays glued to the (growing/shrinking) proxy.
                        e.target.style.width = `${e.width}px`;
                        e.target.style.height = `${e.height}px`;
                        e.target.style.transform = e.drag.transform;
                        resizeTicks.current++;
                        const s = scaleRef.current;
                        debugLog('[CC-MOVEABLE] resize', {
                            beforeWidth: base.current.width, beforeHeight: base.current.height,
                            nextWidth: Math.round(e.width / s), nextHeight: Math.round(e.height / s),
                            dragLeft: e.drag.beforeTranslate[0], dragTop: e.drag.beforeTranslate[1],
                            transform: e.drag.transform, scale: s,
                        });
                    }}
                    onResizeEnd={(e: any) => {
                        const last = e.lastEvent;
                        if (last) {
                            const s = scaleRef.current;
                            // Never persist a collapsed box: clamp to >= 1px so a stray 0-width gesture
                            // can't write width:0/height:0 and orphan the element.
                            const finalWidth = Math.max(1, last.width / s);
                            const finalHeight = Math.max(1, last.height / s);
                            const finalLeft = base.current.left + last.drag.beforeTranslate[0] / s;
                            const finalTop = base.current.top + last.drag.beforeTranslate[1] / s;
                            // Glue the proxy to its final size/position FIRST (screen space, no /scale)
                            // so the control box snaps onto the new rect instead of drifting/collapsing.
                            reconcileProxy({
                                left: baseScreen.current.left + last.drag.beforeTranslate[0],
                                top: baseScreen.current.top + last.drag.beforeTranslate[1],
                                width: last.width,
                                height: last.height,
                            });
                            gesturing.current = false;
                            ccLog('resizeEnd', { domId: el.domId, oid: el.oid, resizeTicks: resizeTicks.current, hasMovement: true });
                            const clr = clampToFrame(finalLeft, finalTop, finalWidth, finalHeight);
                            void persist({
                                width: px(finalWidth),
                                height: px(finalHeight),
                                left: px(clr.left),
                                top: px(clr.top),
                            });
                            debugLog('[CC-MOVEABLE] resizeEnd', {
                                finalLeft: Math.round(finalLeft), finalTop: Math.round(finalTop),
                                finalWidth: Math.round(finalWidth), finalHeight: Math.round(finalHeight),
                                targetStyle: e.target.style.cssText, persisted: true,
                            });
                        } else {
                            gesturing.current = false;
                            ccLog('resizeEnd', { domId: el.domId, resizeTicks: resizeTicks.current, hasMovement: false });
                            void editorEngine.overlay.refresh();
                            debugLog('[CC-MOVEABLE] resizeEnd', { persisted: false });
                        }
                    }}
                />
            )}
            </div>
        </RightClickMenu>
    );
});
