import { useEffect } from 'react';

/**
 * Bridges inspector events from the preview iframe up to the VS Code workbench.
 *
 * The inspector (running inside the user's app iframe) posts:
 *   { type: 'codecanvas:inspector-click', source: { fileName, lineNumber, columnNumber } }
 *
 * We re-emit it to the workbench as:
 *   { type: 'codecanvas:open-source', source: { ... } }
 */
export function useInspectorBridge() {
    useEffect(() => {
        function handleMessage(event: MessageEvent) {
            const data = event.data;
            if (!data || typeof data !== 'object') return;

            if (data.type === 'codecanvas:inspector-click') {
                window.parent?.postMessage(
                    {
                        type: 'codecanvas:open-source',
                        source: data.source,
                    },
                    '*'
                );
            }
        }

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);
}
