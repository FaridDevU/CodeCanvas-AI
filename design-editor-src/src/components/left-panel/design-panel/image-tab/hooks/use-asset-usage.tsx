// Scans the project's markup/source files for asset references so the Images tab can flag files in
// /assets that no element references anymore ("Unused"). Read-only: it never deletes anything.
//
// Matching is by BASENAME and errs toward "used": any token ending in a known media extension in any
// scanned file contributes its filename. A false "used" (not flagging an actually-orphan file) is
// safe; a false "unused" (flagging a referenced file) would be misleading, so we accept the former.

import { useEffect, useState } from 'react';
import { getActiveProjectRoot } from '@/lib/design-session';
import { workbench } from '@/lib/workbench-bridge';

// Directories that never reference assets or shouldn't be read (incl. /assets itself: it holds the
// binaries, not references). Mirrors use-image-operations' ignore list.
const IGNORED_DIRS = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', 'out', '.onlook', '.turbo', 'coverage', 'assets',
]);
// Text files that can reference an asset.
const SCAN_EXT = /\.(html?|css|js|jsx|ts|tsx|md|json|vue|svelte)$/i;
// Bound the walk so a huge project can't stall the panel.
const MAX_FILES = 400;
const MAX_DEPTH = 6;

const MEDIA_REF_RE =
    /[A-Za-z0-9_\-./]+?\.(?:png|jpe?g|gif|svg|webp|avif|bmp|ico|mp4|webm|ogg|mov|m4v)/gi;

function joinAbs(root: string, rel: string): string {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    return clean ? `${r}/${clean}` : r;
}

function collectReferences(content: string, out: Set<string>): void {
    const matches = content.match(MEDIA_REF_RE);
    if (!matches) return;
    for (const full of matches) {
        const base = full.split(/[\\/]/).pop();
        if (base) out.add(base.toLowerCase());
    }
}

/**
 * Returns the set of referenced asset basenames (lowercased) and a `ready` flag. Recomputes when
 * `refreshKey` changes (the Images tab passes a signal that flips on file operations / reopen).
 */
export function useAssetUsage(refreshKey?: unknown) {
    const [referencedNames, setReferencedNames] = useState<Set<string>>(new Set());
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const root = getActiveProjectRoot();
        if (!root) {
            setReady(false);
            return;
        }

        (async () => {
            setReady(false);
            const names = new Set<string>();
            let fileCount = 0;

            const walk = async (relDir: string, depth: number): Promise<void> => {
                if (cancelled || depth > MAX_DEPTH || fileCount > MAX_FILES) return;
                let entries: { name: string; isDirectory: boolean }[];
                try {
                    entries = await workbench.readDir(joinAbs(root, relDir));
                } catch {
                    return;
                }
                for (const e of entries) {
                    if (cancelled || fileCount > MAX_FILES) return;
                    const childRel = relDir ? `${relDir}/${e.name}` : e.name;
                    if (e.isDirectory) {
                        if (!IGNORED_DIRS.has(e.name)) await walk(childRel, depth + 1);
                    } else if (SCAN_EXT.test(e.name)) {
                        fileCount++;
                        try {
                            const { content } = await workbench.readFile(joinAbs(root, childRel), 'utf8');
                            collectReferences(content, names);
                        } catch {
                            /* unreadable file: skip */
                        }
                    }
                }
            };

            await walk('', 0);
            if (!cancelled) {
                setReferencedNames(names);
                setReady(true);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [refreshKey]);

    return { referencedNames, ready };
}
