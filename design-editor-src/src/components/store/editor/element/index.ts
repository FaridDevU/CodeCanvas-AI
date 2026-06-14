import { debugLog } from '@/lib/debug';
import type { CoreElementType, DomElement, DynamicType } from '@onlook/models';
import type { RemoveElementAction } from '@onlook/models/actions';
import { toast } from '@onlook/ui/sonner';
import { makeAutoObservable } from 'mobx';
import { getActiveProject } from '@/lib/design-session';
import {
    applyHtmlAttrEdit,
    CC_CREATED_ATTR,
    CC_CREATED_VALUE,
    CC_EDITABLE_ATTR,
    CC_EDITABLE_VALUE,
    pageFileForPathname,
} from '@/lib/html-writeback';
import type { EditorEngine } from '../engine';
import type { FrameData } from '../frames';
import { adaptRectToCanvas } from '../overlay/utils';

// Tags that are not user content and must never be converted to free-positioned editing.
const NON_CONVERTIBLE_TAGS = new Set([
    'html', 'head', 'body', 'script', 'style', 'template', 'meta', 'link', 'base', 'title', 'noscript',
]);

export class ElementsManager {
    private _hovered: DomElement | undefined;
    private _selected: DomElement[] = [];
    // True when the single selected element was created by Design (img/video, or any element carrying
    // the persistent `data-cc-created="design"` marker). Drives the Moveable gate so original flow
    // content (hero/card/h1/p) never becomes freely movable. Resolved async (getActionElement reads
    // the live attribute) since DomElement doesn't carry arbitrary attributes.
    selectedIsDesignCreated = false;
    // Oids of ORIGINAL elements converted to free editing this session. Lets the Moveable gate light up
    // immediately after a conversion (no reload), while the persistent data-cc-editable marker (written
    // to the source) is what survives across sessions.
    private locallyEditableOids = new Set<string>();

    constructor(private editorEngine: EditorEngine) {
        makeAutoObservable(this);
    }

    /** Whether the (single) selected element can already be freely moved/resized by Moveable. */
    get selectedIsFreelyEditable(): boolean {
        const el = this._selected.length === 1 ? this._selected[0] : null;
        if (!el) return false;
        const tag = el.tagName?.toLowerCase();
        if (tag === 'img' || tag === 'video') return true;
        return this.selectedIsDesignCreated;
    }

    /** Whether "Convertir a edición libre" should be offered for the current selection. */
    get selectedCanConvertToEditable(): boolean {
        const el = this._selected.length === 1 ? this._selected[0] : null;
        if (!el) return false;
        const tag = el.tagName?.toLowerCase();
        if (!tag || NON_CONVERTIBLE_TAGS.has(tag)) return false;
        if (this.selectedIsFreelyEditable) return false; // already movable
        const rect = el.rect as { width?: number; height?: number } | undefined;
        return !!rect && (rect.width ?? 0) >= 1 && (rect.height ?? 0) >= 1;
    }

    // Arrow-field methods (same pattern as HistoryManager.push / OverlayManager.undebouncedRefresh):
    // makeAutoObservable turns these into bound actions, so setting the observable from the async
    // continuation is safe and never throws during engine construction.
    private setSelectedIsDesignCreated = (value: boolean) => {
        this.selectedIsDesignCreated = value;
    };

    private resolveDesignCreated = async (domEl: DomElement | null) => {
        if (!domEl) {
            this.setSelectedIsDesignCreated(false);
            return;
        }
        const tag = domEl.tagName?.toLowerCase();
        if (tag === 'img' || tag === 'video') {
            this.setSelectedIsDesignCreated(true);
            return;
        }
        // Converted this session -> recognized immediately (the source marker may not be live yet).
        if (domEl.oid && this.locallyEditableOids.has(domEl.oid)) {
            this.setSelectedIsDesignCreated(true);
            return;
        }
        try {
            const view = this.editorEngine.frames.get(domEl.frameId)?.view;
            const actionEl = (await view?.getActionElement(domEl.domId)) as
                | { attributes?: Record<string, string> }
                | undefined;
            const attrs = actionEl?.attributes ?? {};
            const isEditable =
                attrs[CC_CREATED_ATTR] === CC_CREATED_VALUE || attrs[CC_EDITABLE_ATTR] === CC_EDITABLE_VALUE;
            // Cache the durable recognition into the session set so later re-selections (and click()'s
            // synchronous fast-path) don't have to re-read the attribute and won't flicker the gate.
            if (isEditable && domEl.oid) this.locallyEditableOids.add(domEl.oid);
            this.setSelectedIsDesignCreated(isEditable);
        } catch {
            this.setSelectedIsDesignCreated(false);
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
        if (!this.selectedCanConvertToEditable) {
            toast.warning('Este elemento no se puede convertir a edición libre.');
            return;
        }
        const rect = el.rect as { left: number; top: number; width: number; height: number } | undefined;
        if (!rect) return;

        const view = this.editorEngine.frames.get(el.frameId)?.view;

        // left/top relative to the offset parent (the containing block once position:absolute), so the
        // element stays exactly where it is. Falls back to document coords (offset parent ~ body @0,0).
        let offX = 0;
        let offY = 0;
        try {
            const op = (await view?.getOffsetParent(el.domId)) as { rect?: { left: number; top: number } } | undefined;
            if (op?.rect) {
                offX = op.rect.left;
                offY = op.rect.top;
            }
        } catch {
            /* no offset parent resolvable -> document coords */
        }

        const left = Math.round(rect.left - offX);
        const top = Math.round(rect.top - offY);
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));

        // Light up the Moveable gate immediately for the CURRENT oid (it may be a positional index if
        // the page wasn't instrumented yet; the durable cc-id is added after the writes below).
        if (el.oid) this.locallyEditableOids.add(el.oid);
        this.setSelectedIsDesignCreated(true);

        // 1. Pin geometry (live + source + undo) through the normal style pipeline. AWAIT it: this both
        // applies position:absolute to the live DOM and writes it to the source file (and migrates the
        // page to durable data-cc-id). We must let it finish before step 2 so the two writebacks don't
        // race on the SAME .html file (the bug where the style landed but data-cc-editable did not).
        await this.editorEngine.style.updateMultiple({
            position: 'absolute',
            left: `${left}px`,
            top: `${top}px`,
            width: `${width}px`,
            height: `${height}px`,
        });

        // 2. Persist the durable marker to the source so the conversion survives a reload/restart. Now
        // serialized AFTER the style write, so it reads the style-patched file and adds the attribute
        // instead of clobbering it. Awaited so a later reload sees data-cc-editable="free".
        const frame = this.editorEngine.frames.get(el.frameId)?.frame;
        let pathname = '/';
        try {
            if (frame?.url) pathname = new URL(frame.url).pathname;
        } catch {
            /* keep default */
        }
        await applyHtmlAttrEdit(el.oid ?? undefined, { [CC_EDITABLE_ATTR]: CC_EDITABLE_VALUE }, pageFileForPathname(pathname));

        // 3. Re-select the freshly-converted element. The style write above may have assigned a durable
        // cc-id (oid drifts from a positional index to the cc-id), so the live re-fetch carries the NEW
        // oid: register THAT in the editable set too, otherwise a later move/resize re-selection (which
        // sees the cc-id oid) wouldn't recognize the element and the legacy overlay would come back.
        // Re-fetching also gives the click-rect the post-conversion computed styles (absolute + left/top)
        // the Moveable gate and baseline depend on.
        await this.reselectAfterConvert(el);
        void this.editorEngine.overlay.refresh();
        toast.success('Elemento convertido a edición libre.');
    };

    /** Marks an oid as freely editable for this session (used after re-selection so oid drift across
     *  a write/reload doesn't drop the Moveable gate). No-op for empty oids. */
    markOidEditable = (oid: string | undefined) => {
        if (oid) this.locallyEditableOids.add(oid);
    };

    // Re-fetches the just-converted element from the live DOM until its computed position is absolute
    // (the conversion's style update is async), then re-selects it so overlay/selection reflect the new
    // geometry. Also registers the (possibly migrated) oid as editable. Best-effort: on timeout it
    // leaves the existing selection in place.
    private reselectAfterConvert = async (prev: DomElement) => {
        const view = this.editorEngine.frames.get(prev.frameId)?.view;
        if (!view) return;
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            try {
                const fresh = (await view.getElementByDomId(prev.domId, true)) as DomElement | null;
                const pos = fresh?.styles?.computed?.position;
                if (fresh && (pos === 'absolute' || pos === 'fixed')) {
                    this.markOidEditable(fresh.oid ?? undefined);
                    this.click([{ ...fresh, frameId: prev.frameId }]);
                    return;
                }
            } catch {
                /* frame busy applying the style; keep polling */
            }
            await new Promise((r) => setTimeout(r, 80));
        }
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
            }
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
    }
}
