// Debug logging gate for CodeCanvas Design.
//
// The temporary `[CC-*]` traces (Moveable, drag/drop, write-back, live update...) are useful while
// developing but must NOT spam the console in a production build. They are emitted only when:
//   - the app runs in a Vite dev build (`import.meta.env.DEV`), or
//   - the user opts in at runtime with `localStorage.setItem('cc-debug', '1')` (to debug a packaged
//     build without a rebuild).
// Replace `console.log`/`console.warn` for `[CC-*]` traces with `debugLog`/`debugWarn`.

function computeEnabled(): boolean {
    let runtime = false;
    try {
        runtime = typeof localStorage !== 'undefined' && localStorage.getItem('cc-debug') === '1';
    } catch {
        /* localStorage may be unavailable (sandboxed iframe) */
    }
    const dev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
    return dev || runtime;
}

const DEBUG_ENABLED = computeEnabled();

// Same gate as debugLog, exposed so non-essential debug UI (e.g. the Moveable HUD) and the
// cc-moveable-debug log file can be mounted/written ONLY in dev or when the user opts in. Keeps the
// green diagnostic overlay and the on-disk log out of a normal user's build.
export function isDebugEnabled(): boolean {
    return DEBUG_ENABLED;
}

export function debugLog(...args: unknown[]): void {
    if (DEBUG_ENABLED) {
        // eslint-disable-next-line no-console
        console.log(...args);
    }
}

export function debugWarn(...args: unknown[]): void {
    if (DEBUG_ENABLED) {
        // eslint-disable-next-line no-console
        console.warn(...args);
    }
}
