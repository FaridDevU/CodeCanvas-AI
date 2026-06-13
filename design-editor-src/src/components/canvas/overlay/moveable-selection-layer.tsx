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
import { useEditorEngine } from '@/components/store/editor';
import { EditorMode } from '@onlook/models';
import { StyleChangeType } from '@onlook/models/style';
import { observer } from 'mobx-react-lite';
import { useLayoutEffect, useRef, useState } from 'react';
import Moveable from 'react-moveable';

function num(value: string | undefined, fallback = 0): number {
    const n = parseFloat(value ?? '');
    return Number.isFinite(n) ? n : fallback;
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

    const selected = editorEngine.elements.selected;
    const el = selected.length === 1 ? selected[0] : null;
    const clickRect = overlay.clickRects.length === 1 ? overlay.clickRects[0] : null;
    const position = clickRect?.styles?.computed?.position;
    const isAbsolute = position === 'absolute' || position === 'fixed';
    // Degenerate (collapsed) rects belong to orphaned/zero-size elements (e.g. an image that wrote
    // width:0). Don't attach handles to them: resizing from a 0x0 box produces garbage and creates
    // more orphans. Require a real, measurable box.
    const hasRealSize = !!clickRect && clickRect.width >= 1 && clickRect.height >= 1;
    // SAFETY GATE: free move/resize is only for media Design inserts (img/video), which are always
    // absolute-anchored and meant to be dragged. Original flow content (hero, card, h1, p, containers)
    // must NEVER enter the move system — even if a past corrupt op left it position:absolute — or its
    // layout breaks. DomElement carries no attributes, so we can't read a "created by Design" marker;
    // restricting to absolute img/video is the safe, structural equivalent (originals aren't absolute
    // media). Inserted boxes/text are intentionally excluded for now until a real marker is wired.
    const tag = el?.tagName?.toLowerCase();
    const isMovableMedia = tag === 'img' || tag === 'video';
    const active = !!(
        el &&
        clickRect &&
        hasRealSize &&
        isAbsolute &&
        isMovableMedia &&
        editorEngine.state.editorMode === EditorMode.DESIGN &&
        !editorEngine.text.isEditing &&
        !editorEngine.state.rightClickMenuOpen
    );

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

    const captureBase = () => {
        const c = el.styles?.computed ?? {};
        const rect = el.rect as { left?: number; top?: number; width?: number; height?: number } | undefined;
        const scale = editorEngine.canvas.scale || 1;
        base.current = {
            left: num(c.left, rect?.left ?? 0),
            top: num(c.top, rect?.top ?? 0),
            width: num(c.width, rect?.width ?? clickRect.width / scale),
            height: num(c.height, rect?.height ?? clickRect.height / scale),
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

    // After a reload, re-select the SAME element by IDENTITY (durable oid = data-cc-id, preserved
    // across reload), located via getElementAtLoc at its new center. CRITICAL: we only ever accept a
    // hit whose oid equals the expected one. Coordinates alone are unsafe — overlap, iframe scroll, or
    // the element landing under another would make getElementAtLoc return a DIFFERENT element, and
    // selecting it would then persist absolute geometry onto e.g. the hero/card and wreck the layout.
    // So if the identity never matches, we DO NOT change the selection at all (better unselected than
    // wrong). oid is required; without it we never reselect.
    const reselectAt = async (centerX: number, centerY: number, oid: string | undefined) => {
        if (!oid) {
            debugLog('[CC-MOVEABLE] reselect skipped (no oid)');
            return;
        }
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 150));
            // Re-fetch the view each tick: the reload remounts the frame, so the registered view
            // (and its penpal child) is replaced — a reference captured before the reload is dead.
            const view = editorEngine.frames.get(el.frameId)?.view;
            if (!view) continue;
            try {
                const domEl: any = await view.getElementAtLoc(centerX, centerY, true);
                if (domEl && domEl.oid === oid) {
                    editorEngine.elements.click([domEl]);
                    void editorEngine.overlay.refresh();
                    debugLog('[CC-MOVEABLE] reselect ok', { oid: domEl.oid, domId: domEl.domId });
                    return;
                }
            } catch {
                /* frame still reloading; keep polling */
            }
        }
        // Identity never confirmed: leave the selection untouched rather than grab a wrong element.
        debugLog('[CC-MOVEABLE] reselect timeout (no identity match)', { centerX, centerY, oid });
    };

    // Persist the final geometry. Strategy: try a LIVE DOM patch first (penpal updateStyle on the
    // selected element's domId) and VERIFY it actually moved/resized the element (compare the returned
    // rect against the old one). If it took, we skip the frame reload entirely — no flicker. Only when
    // the live patch can't be confirmed do we fall back to the reliable-but-flickery reload + reselect.
    // HTML is always persisted (history.push -> code.write -> writeback) so the file is the source of
    // truth. `center` is the element's new center in FRAME/CSS space (used by the reload fallback).
    const persist = async (
        styles: Record<string, string>,
        center: { x: number; y: number },
    ) => {
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

        // 1. Live patch + verify it (a) is the SAME element by identity and (b) really moved/resized.
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
        debugLog('[CC-MOVEABLE] live update', {
            domId: el.domId, oid: el.oid, liveOid: liveDomEl?.oid,
            found: !!liveDomEl, sameIdentity, rectChanged, applied: liveApplied,
        });

        // 2. Persist to the HTML file + history (no extra live dispatch: history.push writes the file).
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
            debugLog('[CC-MOVEABLE] persist result', { ok: true });
        } catch (error) {
            debugLog('[CC-MOVEABLE] persist result', { ok: false, error: String(error) });
        }

        // 3a. Live patch confirmed: re-bind overlay/selection/panel to the updated element. No reload.
        if (liveApplied) {
            editorEngine.elements.click([{ ...liveDomEl, frameId: el.frameId }]);
            void editorEngine.overlay.refresh();
            return;
        }

        // 3b. Live patch couldn't be confirmed: reload so the canvas matches the file, then re-select.
        try {
            view?.reload();
        } catch (err) {
            debugWarn('[CC-MOVEABLE] frame reload failed', err);
        }
        await reselectAt(center.x, center.y, el.oid);
    };

    return (
        // Zero-size wrapper (no footprint). It must NOT set pointer-events:none — Moveable's handles
        // rely on the initial (auto) value and a `none` ancestor suppressed their hit-testing.
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
                    onDragStart={() => {
                        gesturing.current = true;
                        captureBase();
                        debugLog('[CC-MOVEABLE] onDragStart', { domId: el.domId, base: base.current, scale: scaleRef.current });
                    }}
                    onDrag={(e: any) => {
                        // Moveable owns the proxy during the gesture: translate it so the box follows.
                        e.target.style.transform = e.transform;
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
                            void persist(
                                { left: px(newLeft), top: px(newTop) },
                                // New center in FRAME/CSS space (size unchanged on a drag).
                                { x: newLeft + base.current.width / 2, y: newTop + base.current.height / 2 },
                            );
                        } else {
                            gesturing.current = false;
                            void editorEngine.overlay.refresh();
                        }
                        debugLog('[CC-MOVEABLE] onDragEnd', { hasMovement: !!last });
                    }}
                    onResizeStart={() => {
                        gesturing.current = true;
                        captureBase();
                        debugLog('[CC-MOVEABLE] onResizeStart', { domId: el.domId, base: base.current, scale: scaleRef.current });
                    }}
                    onResize={(e: any) => {
                        // Moveable owns the proxy: apply BOTH the new size and the keep-corner translate
                        // so the control box stays glued to the (growing/shrinking) proxy.
                        e.target.style.width = `${e.width}px`;
                        e.target.style.height = `${e.height}px`;
                        e.target.style.transform = e.drag.transform;
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
                            void persist(
                                {
                                    width: px(finalWidth),
                                    height: px(finalHeight),
                                    left: px(finalLeft),
                                    top: px(finalTop),
                                },
                                { x: finalLeft + finalWidth / 2, y: finalTop + finalHeight / 2 },
                            );
                            debugLog('[CC-MOVEABLE] resizeEnd', {
                                finalLeft: Math.round(finalLeft), finalTop: Math.round(finalTop),
                                finalWidth: Math.round(finalWidth), finalHeight: Math.round(finalHeight),
                                targetStyle: e.target.style.cssText, persisted: true,
                            });
                        } else {
                            gesturing.current = false;
                            void editorEngine.overlay.refresh();
                            debugLog('[CC-MOVEABLE] resizeEnd', { persisted: false });
                        }
                    }}
                />
            )}
        </div>
    );
});
