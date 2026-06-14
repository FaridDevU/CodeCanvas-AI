import { useEffect, useState } from 'react';
import { ONLOOK_PRELOAD_SCRIPT_FILE } from '@onlook/constants';
import { INSPECTOR_SCRIPT } from '@/lib/inspector-script';
import { ccIdOf, editableElements } from '@/lib/html-writeback';

const BASE_TAG_REGEX = /<base\s[^>]*>/i;
const HEAD_TAG_REGEX = /<head(\s[^>]*)?>/i;

// Assigns `data-oid="<n>"` to each EDITABLE element (content inside <body>, excluding script/style/
// meta/etc.), where <n> is its position among editable elements. The HTML write-back relocates
// element <n> with the same editableElements walk on the source file, so visual edits map back to
// real source elements - and non-content tags never become editable. Runs on the ORIGINAL html,
// before the <base> and editor scripts are injected, so the indices match the untouched source file.
function instrumentHtml(rawHtml: string): string {
    try {
        const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
        const els = editableElements(doc);
        if (els.length === 0) return rawHtml;
        // Prefer the durable data-cc-id as the oid (set once a page has been edited); fall back to a
        // positional index for pages not yet instrumented. The write-back resolves both.
        els.forEach((el, i) => el.setAttribute('data-oid', ccIdOf(el) ?? String(i)));
        const doctype = doc.doctype ? '<!DOCTYPE html>\n' : '';
        return doctype + doc.documentElement.outerHTML;
    } catch (err) {
        console.warn('[CodeCanvas Inspector] HTML instrumentation failed:', err);
        return rawHtml;
    }
}
const HEAD_CLOSE_REGEX = /<\/head>/i;
const BODY_CLOSE_REGEX = /<\/body>/i;
const HTML_CLOSE_REGEX = /<\/html>/i;

/**
 * Explicit proxy state so callers never load the original (unproxied) page by mistake. Loading
 * `frame.url` directly means the iframe has no penpal child, so the editor can never connect - the
 * iframe must only ever load the proxied blob (status 'ready') or, if proxying fails, fall back to
 * the original URL as an explicit view-only mode (status 'failed').
 */
export type InspectorProxyState =
    | { status: 'building'; src: undefined; isProxied: false; error?: undefined }
    | { status: 'ready'; src: string; isProxied: true; error?: undefined }
    | { status: 'failed'; src: string; isProxied: false; error: string };

// The Onlook preload bundle (penpal child + processDom/getElementAtLoc/drag/insert...) is vendored
// in the design-editor bundle's public folder. It is fetched once and cached so we can inline it
// into every proxied page. The bundle is an ES module (it ends with `export { ... }`), so it MUST
// be injected as <script type="module">; inside a classic <script> the export is a SyntaxError
// and the whole bundle silently fails to run - which leaves penpal unconnected.
let preloadScriptPromise: Promise<string | null> | null = null;
function getPreloadScript(): Promise<string | null> {
    if (!preloadScriptPromise) {
        const url = new URL(ONLOOK_PRELOAD_SCRIPT_FILE, window.location.href);
        preloadScriptPromise = fetch(url)
            .then((res) => (res.ok ? res.text() : null))
            .then((text) => {
                console.log('[CodeCanvas Inspector] Preload bundle loaded:', {
                    url: url.href,
                    bytes: text?.length ?? 0,
                });
                return text;
            })
            .catch((err) => {
                console.warn('[CodeCanvas Inspector] Could not load preload bundle:', err);
                return null;
            });
    }
    return preloadScriptPromise;
}

// Classic bootstrap injected before the module preload. It reports progress to the parent via
// postMessage so the connection state is visible WITHOUT opening the webview DevTools, and it
// surfaces any global error from the page/preload.
const PRELOAD_BOOTSTRAP = /* js */ `
(function () {
  function post(type, detail) {
    try { window.parent.postMessage({ type: type, detail: detail }, '*'); } catch (e) {}
  }
  post('codecanvas:preload-bootstrap');
  console.log('[CodeCanvas preload] bootstrap injected; waiting for penpal child...');
  window.addEventListener('error', function (e) {
    var msg = (e && e.message) ? e.message : 'error';
    console.error('[CodeCanvas preload] window.onerror:', msg, e.filename + ':' + e.lineno);
    post('codecanvas:preload-error', msg + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var msg = (e && e.reason) ? String(e.reason) : 'unhandledrejection';
    console.error('[CodeCanvas preload] unhandledrejection:', msg);
    post('codecanvas:preload-error', msg);
  });
})();
`;

// A marker module injected right after the preload. If it runs, module scripts execute in this
// document (rules out a CSP that blocks modules). It does not prove the preload itself ran - that
// is confirmed by the parent's penpal connection - but it isolates "modules blocked" failures.
const MODULE_MARKER = /* js */ `
try { window.parent.postMessage({ type: 'codecanvas:preload-module-executed' }, '*'); } catch (e) {}
`;

/**
 * Fetches the original HTML from the dev/static server, injects the Onlook preload bundle (the
 * penpal child) plus the lightweight click-to-source inspector, adds a <base> tag so relative URLs
 * still resolve, and returns an explicit proxy state. The iframe must only load `state.src` when
 * `status === 'ready'` (the proxied blob) - never the raw `frame.url`, which has no preload.
 *
 * Element identity for the write-back is the durable `data-cc-id` (persisted on first edit); until
 * a page has been edited, `data-oid` falls back to the element's positional index. No Onlook
 * build-time OIDs are needed for static HTML.
 */
export function useInspectorProxy(originalUrl: string | undefined): InspectorProxyState {
    const [state, setState] = useState<InspectorProxyState>({
        status: 'building',
        src: undefined,
        isProxied: false,
    });

    useEffect(() => {
        if (!originalUrl) {
            setState({ status: 'building', src: undefined, isProxied: false });
            return;
        }

        setState({ status: 'building', src: undefined, isProxied: false });

        let objectUrl: string | undefined;
        let cancelled = false;

        const buildProxy = async () => {
            try {
                const [res, preloadScript] = await Promise.all([
                    fetch(originalUrl, { cache: 'no-store' }),
                    getPreloadScript(),
                ]);
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                let html = await res.text();

                // Assign stable element ids (data-oid) on the original markup so visual edits can be
                // written back to the source file. Must run before <base>/scripts are injected.
                html = instrumentHtml(html);

                // Inject <base> so relative assets resolve against the original dev server.
                const baseTag = `<base href="${originalUrl}">`;
                if (!BASE_TAG_REGEX.test(html)) {
                    if (HEAD_TAG_REGEX.test(html)) {
                        html = html.replace(HEAD_TAG_REGEX, (match) => `${match}\n${baseTag}`);
                    } else {
                        html = `<!DOCTYPE html><head>${baseTag}</head>${html}`;
                    }
                }

                // The Onlook preload MUST be a module (it ends with `export`). Bootstrap + marker +
                // click-to-source inspector are classic/marker scripts. Module scripts are deferred;
                // both penpal sides retry the handshake, so injection order is not critical.
                const preloadTag = preloadScript
                    ? `<script type="module" id="onlook-preload-script">${preloadScript}</script>\n`
                      + `<script type="module">${MODULE_MARKER}</script>`
                    : '';
                const editorScripts =
                    `<script>${PRELOAD_BOOTSTRAP}</script>\n` +
                    `${preloadTag}\n` +
                    `<script>${INSPECTOR_SCRIPT}</script>`;

                // Inject robustly: prefer right after <head>; otherwise before </head>, </body> or
                // </html>; as a last resort append. This survives odd/minimal HTML structures.
                const before = html;
                if (HEAD_TAG_REGEX.test(html)) {
                    html = html.replace(HEAD_TAG_REGEX, (match) => `${match}\n${editorScripts}`);
                } else if (HEAD_CLOSE_REGEX.test(html)) {
                    html = html.replace(HEAD_CLOSE_REGEX, `${editorScripts}\n</head>`);
                } else if (BODY_CLOSE_REGEX.test(html)) {
                    html = html.replace(BODY_CLOSE_REGEX, `${editorScripts}\n</body>`);
                } else if (HTML_CLOSE_REGEX.test(html)) {
                    html = html.replace(HTML_CLOSE_REGEX, `${editorScripts}\n</html>`);
                } else {
                    html = `${html}\n${editorScripts}`;
                }

                const preloadInjected = !!preloadScript && html.includes('onlook-preload-script');
                console.log('[CodeCanvas Inspector] Proxy built:', {
                    originalUrl,
                    preloadInjected,
                    preloadBytes: preloadScript?.length ?? 0,
                    hadHead: HEAD_TAG_REGEX.test(before),
                    hadBodyClose: BODY_CLOSE_REGEX.test(before),
                });

                if (!preloadScript) {
                    throw new Error('preload bundle missing');
                }

                // The charset MUST be declared on the blob's content-type: we inject the ~475KB
                // preload module right after <head>, which pushes the page's own <meta charset> past
                // the browser's 1024-byte encoding pre-scan window. Without an explicit charset here
                // the iframe decodes UTF-8 bytes as latin1 and renders mojibake ("TÃ­tulo").
                const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
                objectUrl = URL.createObjectURL(blob);

                if (!cancelled) {
                    setState({ status: 'ready', src: objectUrl, isProxied: true });
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.warn('[CodeCanvas Inspector] Proxy failed, view-only fallback:', message);
                if (!cancelled) {
                    setState({ status: 'failed', src: originalUrl, isProxied: false, error: message });
                }
            }
        };

        buildProxy();

        return () => {
            cancelled = true;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [originalUrl]);

    return state;
}
