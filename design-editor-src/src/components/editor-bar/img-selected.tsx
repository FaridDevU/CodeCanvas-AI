'use client';

import React, { memo } from 'react';
import { Border } from './dropdowns/border';
import { Height } from './dropdowns/height';
import { ImgFit } from './dropdowns/img-fit';
import { Margin } from './dropdowns/margin';
import { Opacity } from './dropdowns/opacity';
import { Padding } from './dropdowns/padding';
import { Radius } from './dropdowns/radius';
import { Width } from './dropdowns/width';
import { useDropdownControl } from './hooks/use-dropdown-manager';
import { useMeasureGroup } from './hooks/use-measure-group';
import { OverflowMenu } from './overflow-menu';
import { InputSeparator } from './separator';

// Group definitions for the img/video-selected toolbar. Only controls that persist via inline-style
// write-back (applyHtmlStyleEdit): object-fit, border/radius, opacity, spacing and dimensions. No
// text/typography controls here — those don't apply to media.
export const IMG_SELECTED_GROUPS = [
    {
        key: 'image',
        label: 'Image',
        components: [<ImgFit />],
    },
    {
        key: 'base',
        label: 'Base',
        components: [<Border />, <Radius />],
    },
    {
        key: 'opacity',
        label: 'Opacity',
        components: [<Opacity />],
    },
    {
        key: 'layout',
        label: 'Layout',
        components: [<Padding />, <Margin />],
    },
];

const MUST_EXTEND_GROUPS = [
    {
        key: 'dimensions',
        label: 'Dimensions',
        components: [<Width />, <Height />],
    },
]

export const ImgSelected = memo(({ availableWidth = 0 }: { availableWidth?: number }) => {
    const { isOpen, onOpenChange } = useDropdownControl({
        id: 'img-selected-overflow-dropdown',
    });
    const { visibleCount } = useMeasureGroup({ availableWidth, count: IMG_SELECTED_GROUPS.length });

    const visibleGroups = IMG_SELECTED_GROUPS.slice(0, visibleCount);
    const overflowGroups = [...IMG_SELECTED_GROUPS.slice(visibleCount), ...MUST_EXTEND_GROUPS];

    return (
        <div className="flex items-center justify-center gap-0.5 w-full overflow-hidden">
            {visibleGroups.map((group, groupIdx) => (
                <React.Fragment key={group.key}>
                    {groupIdx > 0 && <InputSeparator />}
                    <div className="flex items-center justify-center gap-0.5">
                        {group.components.map((comp, idx) => (
                            <React.Fragment key={idx}>{comp}</React.Fragment>
                        ))}
                    </div>
                </React.Fragment>
            ))}
            <OverflowMenu
                isOpen={isOpen}
                onOpenChange={onOpenChange}
                overflowGroups={overflowGroups}
                visibleCount={visibleCount}
            />
        </div>
    );
});
