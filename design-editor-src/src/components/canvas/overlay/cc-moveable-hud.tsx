// TEMPORARY on-screen HUD that shows the latest Moveable/overlay diagnostic events (see
// cc-moveable-debug.ts). Lets the gesture lifecycle be read directly from the Design editor (no
// DevTools / file access needed). Remove once the Moveable drag/resize bug is closed.

import { useEffect, useReducer } from 'react';
import { getCcEvents, subscribeCcEvents } from '@/lib/cc-moveable-debug';

export const CcMoveableHud = () => {
    const [, force] = useReducer((x: number) => x + 1, 0);
    useEffect(() => subscribeCcEvents(force), []);
    const events = getCcEvents().slice(-16);

    return (
        <div
            style={{
                position: 'fixed',
                left: 8,
                bottom: 8,
                zIndex: 99999,
                maxWidth: 560,
                maxHeight: 280,
                overflow: 'hidden',
                pointerEvents: 'none',
                background: 'rgba(0,0,0,0.78)',
                color: '#9cff9c',
                font: '10px/1.35 ui-monospace, monospace',
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid rgba(156,255,156,0.35)',
                whiteSpace: 'pre-wrap',
            }}
        >
            <div style={{ color: '#fff', marginBottom: 2 }}>CC-MOVEABLE-EVENT (debug)</div>
            {events.length === 0 ? '(sin eventos aún — selecciona/arrastra)' : events.join('\n')}
        </div>
    );
};
