/**
 * CodeCanvas Inspector – vanilla JS injected into the user's preview iframe.
 *
 * Ported from click-to-component (React fiber _debugSource) +
 * overlay inspired by locatorjs.
 *
 * This string is inlined into the proxied HTML so the inspector runs inside
 * the SAME origin as the user's React app (required to read React fibers).
 */
export const INSPECTOR_SCRIPT = /* js */ `
(function () {
  'use strict';

  const NS = 'codecanvas-inspector';
  const OVERLAY_ID = NS + '-overlay';
  const LABEL_ID = NS + '-label';

  /* ─── React Fiber helpers (ported from click-to-component) ─── */

  function getReactInstanceForElement(element) {
    if (typeof window === 'undefined') return undefined;

    if ('__REACT_DEVTOOLS_GLOBAL_HOOK__' in window) {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook && hook.renderers) {
        for (const renderer of hook.renderers.values()) {
          try {
            const fiber = renderer.findFiberByHostInstance?.(element);
            if (fiber) return fiber;
          } catch (e) {
            /* React may be mid-render */
          }
        }
      }
    }

    if ('_reactRootContainer' in element) {
      return element._reactRootContainer?._internalRoot?.current?.child;
    }

    for (const key in element) {
      if (key.startsWith('__reactInternalInstance$')) return element[key];
      if (key.startsWith('__reactFiber')) return element[key];
    }
    return undefined;
  }

  function getSourceForInstance(instance) {
    if (!instance?._debugSource) return undefined;
    const {
      columnNumber = 1,
      fileName,
      lineNumber = 1,
    } = instance._debugSource;
    return { columnNumber, fileName, lineNumber };
  }

  function getSourceForElement(element) {
    const instance = getReactInstanceForElement(element);
    const source = getSourceForInstance(instance);
    if (source) return source;
    const parent = element.parentElement;
    if (!parent) return undefined;
    return getSourceForElement(parent);
  }

  function getDisplayName(element) {
    const instance = getReactInstanceForElement(element);
    if (!instance) return element.tagName.toLowerCase();
    const { elementType, tag } = instance;
    if (tag === 5 && typeof elementType === 'string') {
      return elementType;
    }
    if (tag === 0 || tag === 1) {
      return elementType?.displayName || elementType?.name || 'Anonymous';
    }
    return element.tagName.toLowerCase();
  }

  /* ─── Overlay helpers (inspired by locatorjs) ─── */

  function createOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    let label = document.getElementById(LABEL_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      Object.assign(overlay.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '2147483646',
        boxSizing: 'border-box',
        border: '2px solid #0ea5e9',
        borderRadius: '3px',
        backgroundColor: 'rgba(14, 165, 233, 0.08)',
        transition: 'all 0.05s ease-out',
      });
      document.body.appendChild(overlay);
    }
    if (!label) {
      label = document.createElement('div');
      label.id = LABEL_ID;
      Object.assign(label.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '2147483647',
        boxSizing: 'border-box',
        padding: '2px 6px',
        backgroundColor: '#0ea5e9',
        color: '#fff',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '11px',
        fontWeight: '600',
        borderRadius: '3px',
        whiteSpace: 'nowrap',
        lineHeight: '1.4',
      });
      document.body.appendChild(label);
    }
    return { overlay, label };
  }

  function removeOverlay() {
    const overlay = document.getElementById(OVERLAY_ID);
    const label = document.getElementById(LABEL_ID);
    if (overlay) overlay.remove();
    if (label) label.remove();
  }

  function updateOverlay(element, source) {
    const { overlay, label } = createOverlay();
    const rect = element.getBoundingClientRect();
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';

    const displayName = getDisplayName(element);
    const fileName = source ? source.fileName.split('/').pop() : '?';
    label.textContent =
      displayName +
      ' • ' +
      fileName +
      (source ? ':' + source.lineNumber : '');

    const labelTop = rect.top - 22;
    label.style.left = rect.left + 'px';
    label.style.top = (labelTop < 0 ? rect.bottom + 4 : labelTop) + 'px';
  }

  /* ─── Event handlers ─── */

  let currentTarget = null;
  // Only active in Design mode. The parent toggles this via postMessage; in Preview the inspector
  // must draw NOTHING (no outline, no label) and intercept NO clicks, so native controls (e.g. the
  // video play button) work like the real page.
  let enabled = true;

  function onMouseOver(e) {
    if (!enabled) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    currentTarget = target;
    const source = getSourceForElement(target);
    updateOverlay(target, source);
  }

  function onMouseOut(e) {
    if (!enabled) return;
    if (
      e.relatedTarget &&
      e.relatedTarget instanceof HTMLElement &&
      document.contains(e.relatedTarget)
    ) {
      return;
    }
    currentTarget = null;
    removeOverlay();
  }

  function onClick(e) {
    if (!enabled) return;
    if (!currentTarget) return;
    const source = getSourceForElement(currentTarget);
    if (!source) return;

    e.preventDefault();
    e.stopPropagation();

    window.parent.postMessage(
      {
        type: 'codecanvas:inspector-click',
        source: {
          fileName: source.fileName,
          lineNumber: source.lineNumber,
          columnNumber: source.columnNumber,
        },
      },
      '*'
    );
  }

  /* ─── Init ─── */

  document.addEventListener('mouseover', onMouseOver, { capture: true });
  document.addEventListener('mouseout', onMouseOut, { capture: true });
  document.addEventListener('click', onClick, { capture: true });

  // The parent (Design canvas) enables the inspector only in Design mode.
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (d && d.type === 'codecanvas:inspector-set-enabled') {
      enabled = !!d.enabled;
      if (!enabled) {
        currentTarget = null;
        removeOverlay();
      }
    }
  }, false);

  // Tell the parent we're ready so it can push the current mode's enabled state immediately.
  try { window.parent.postMessage({ type: 'codecanvas:inspector-ready' }, '*'); } catch (e) {}

  console.log('[CodeCanvas Inspector] Active — hover any element to inspect, click to open in Code.');
})();
`;
