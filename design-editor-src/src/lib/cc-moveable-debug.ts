// TEMPORARY diagnostics for the Moveable/overlay event flow. Events are shown live in an on-screen
// HUD (see cc-moveable-hud.tsx) AND mirrored to console + a best-effort log file, so the gesture
// lifecycle can be inspected without opening DevTools. Remove once the Moveable drag/resize bug is
// closed.

import { getActiveProjectRoot } from '@/lib/design-session';
import { isDebugEnabled } from '@/lib/debug';
import { workbench } from '@/lib/workbench-bridge';

const events: string[] = [];
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        const root = getActiveProjectRoot();
        if (!root) return;
        const path = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/cc-moveable-debug.log`;
        void workbench.writeFile(path, events.join('\n'), 'utf8').catch(() => {});
    }, 120);
}

export function getCcEvents(): string[] {
    return events;
}

export function subscribeCcEvents(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function ccLog(name: string, data?: Record<string, unknown>): void {
    // Gated: in a normal user build (no dev, no cc-debug opt-in) this is a no-op, so no console
    // spam, no on-disk cc-moveable-debug.log in the user's project, and the HUD stays empty/unmounted.
    if (!isDebugEnabled()) return;
    const ts = new Date().toISOString().slice(11, 23);
    let payload = '';
    try {
        payload = data ? ' ' + JSON.stringify(data) : '';
    } catch {
        payload = ' [unserializable]';
    }
    events.push(`${ts} ${name}${payload}`);
    if (events.length > 300) events.shift();
    // eslint-disable-next-line no-console
    console.log(`[CC-MOVEABLE-EVENT] ${name}`, data ?? '');
    for (const l of listeners) {
        try {
            l();
        } catch {
            /* ignore */
        }
    }
    flush();
}
