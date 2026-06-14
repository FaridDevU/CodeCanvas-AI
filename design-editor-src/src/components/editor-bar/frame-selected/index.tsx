'use client';

import { useEditorEngine } from '@/components/store/editor';
import { observer } from 'mobx-react-lite';
import React from 'react';
import { BranchDisplay } from '../../canvas/frame/top-bar/branch';
import { useDropdownControl } from '../hooks/use-dropdown-manager';
import { useMeasureGroup } from '../hooks/use-measure-group';
import { OverflowMenu } from '../overflow-menu';
import { InputSeparator } from '../separator';
import { RotateGroup } from './rotate-group';
import { ThemeGroup } from './theme-group';
import { WindowActionsGroup } from './window-actions-group';

export const FrameSelected = observer(({ availableWidth = 0 }: { availableWidth?: number }) => {
    const editorEngine = useEditorEngine();
    const frameData = editorEngine.frames.selected[0];
    const { isOpen, onOpenChange } = useDropdownControl({
        id: 'window-selected-overflow-dropdown',
        isOverflow: true
    });
    if (!frameData) return null;

    // Device + frame-bezel toggles live in the persistent TopBar now, so they're not repeated here.
    const WINDOW_GROUPS = [
        {
            key: 'rotate',
            label: 'Rotate',
            components: [
                <RotateGroup key="rotate" frameData={frameData} />
            ]
        },
        {
            key: 'window-actions',
            label: 'Window Actions',
            components: [
                <WindowActionsGroup key="window-actions" frameData={frameData} />
            ]
        },
        {
            key: 'frame',
            label: 'Frame',
            components: [
                <ThemeGroup key="theme" frameData={frameData} />
            ]
        },
    ];

    // Approximate rendered width (px) of each window group, in order, so the overflow logic uses
    // real sizes instead of the unrelated div/text table (which made the whole toolbar collapse).
    const WINDOW_GROUP_WIDTHS = [
        40,  // rotate: one icon button
        80,  // window-actions: duplicate (+ delete) buttons
        112, // frame: 3 theme buttons
    ];

    const { visibleCount } = useMeasureGroup({
        availableWidth,
        count: WINDOW_GROUPS.length,
        widths: WINDOW_GROUP_WIDTHS,
    });
    const visibleGroups = WINDOW_GROUPS.slice(0, visibleCount);
    const overflowGroups = WINDOW_GROUPS.slice(visibleCount);

    return (
        <div className="flex items-center justify-center gap-1 w-full overflow-hidden px-1.5">
            {visibleGroups.map((group, groupIdx) => (
                <React.Fragment key={group.key}>
                    {groupIdx > 0 && <InputSeparator />}
                    <div className="flex items-center gap-1">
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