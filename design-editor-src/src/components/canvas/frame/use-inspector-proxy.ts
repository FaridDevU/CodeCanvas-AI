import { useEffect, useState } from 'react';
import { INSPECTOR_SCRIPT } from '@/lib/inspector-script';

const BASE_TAG_REGEX = /<base\s[^>]*>/i;
const HEAD_TAG_REGEX = /<head(\s[^>]*)?>/i;

/**
 * Fetches the original HTML from the dev server, injects the CodeCanvas
 * inspector script, adds a <base> tag so relative URLs still resolve, and
 * returns a Blob URL that can be used as the iframe `src`.
 *
 * This lets the inspector run inside the SAME document as the user's React
 * app, which is required to access React fibers (cross-origin access is
 * blocked).
 *
 * Limitations:
 * - fetch/XHR from the iframe will have the Blob URL origin (not the dev
 *   server origin), which may trigger CORS on some APIs.
 * - For projects where this is a problem we will fall back to file-based
 *   injection (Onlook-style) in a later phase.
 */
export function useInspectorProxy(originalUrl: string | undefined): string | undefined {
    const [proxiedUrl, setProxiedUrl] = useState<string | undefined>(undefined);

    useEffect(() => {
        if (!originalUrl) {
            setProxiedUrl(undefined);
            return;
        }

        let objectUrl: string | undefined;
        let cancelled = false;

        const buildProxy = async () => {
            try {
                const res = await fetch(originalUrl, { cache: 'no-store' });
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                let html = await res.text();

                // Inject <base> so relative assets resolve against the original dev server.
                const baseTag = `<base href="${originalUrl}">`;
                if (!BASE_TAG_REGEX.test(html)) {
                    if (HEAD_TAG_REGEX.test(html)) {
                        html = html.replace(HEAD_TAG_REGEX, (match) => `${match}\n${baseTag}`);
                    } else {
                        html = `<!DOCTYPE html><head>${baseTag}</head>${html}`;
                    }
                }

                // Inject inspector script right after <head> so it runs before app code.
                const scriptTag = `<script>${INSPECTOR_SCRIPT}</script>`;
                html = html.replace(HEAD_TAG_REGEX, (match) => `${match}\n${scriptTag}`);

                const blob = new Blob([html], { type: 'text/html' });
                objectUrl = URL.createObjectURL(blob);

                if (!cancelled) {
                    setProxiedUrl(objectUrl);
                }
            } catch (err) {
                console.warn('[CodeCanvas Inspector] Proxy failed, falling back to original URL:', err);
                if (!cancelled) {
                    setProxiedUrl(originalUrl);
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

    return proxiedUrl;
}
