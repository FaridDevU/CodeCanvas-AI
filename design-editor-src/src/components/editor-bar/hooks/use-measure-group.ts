import { useCallback, useEffect, useState } from 'react';

// Pre-calculated approximate widths for each group type
const GROUP_WIDTHS = {
    // Div groups
    'dimensions': 160, // Width + Height
    'base': 180, // Color + Border + Radius
    'layout': 180, // Display + Padding + Margin
    'typography': 320, // Font Family + Weight + Size
    'text-color': 40, // Text Color
    'opacity': 80, // Opacity

    // Text groups (wider due to more components)
    'text-typography': 360, // Font Family + Weight + Size + Color + Align + Advanced
    'text-dimensions': 160, // Width + Height
    'text-base': 180, // Color + Border + Radius
    'text-layout': 180, // Display + Padding + Margin
    'text-opacity': 80, // Opacity
};

export const useMeasureGroup = ({ availableWidth = 0, count = 0, widths }: { availableWidth?: number, count?: number, widths?: number[] }) => {
    const [visibleCount, setVisibleCount] = useState(count);
    // Update visible count based on available width
    const updateVisibleCount = useCallback(() => {
        if (!availableWidth) {
            // Width not measured yet: show everything rather than collapsing the toolbar.
            setVisibleCount(count);
            return;
        }

        const OVERFLOW_BUTTON_WIDTH = 32;
        const SEPARATOR_WIDTH = 8;
        const BUFFER_WIDTH = 10;
        let used = 0;
        let fitCount = 0;

        // Per-group widths. Callers that don't match the hardcoded div/text table (e.g. the
        // window/frame toolbar) pass their own `widths`, otherwise we fall back to GROUP_WIDTHS.
        const groupWidths = widths ?? Object.values(GROUP_WIDTHS);

        for (let i = 0; i < groupWidths.length; i++) {
            const width = groupWidths[i];

            // Add separator width if this isn't the first group
            const totalWidth = width + (fitCount > 0 ? SEPARATOR_WIDTH : 0);

            if (used + totalWidth <= availableWidth - OVERFLOW_BUTTON_WIDTH - BUFFER_WIDTH) {
                used += totalWidth;
                fitCount++;
            } else {
                break;
            }
        }

        // Always keep at least the first group visible so the toolbar (and the device selector)
        // never fully disappears on a narrow canvas — the rest goes to the overflow menu.
        setVisibleCount(Math.max(1, fitCount));
    }, [availableWidth, count, widths]);

    // Update visible count when available width changes
    useEffect(() => {
        updateVisibleCount();
    }, [updateVisibleCount]);

    return {
        visibleCount,
    };
};
