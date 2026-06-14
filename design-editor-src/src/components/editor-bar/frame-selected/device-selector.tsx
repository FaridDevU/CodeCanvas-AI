import { useEditorEngine } from '@/components/store/editor';
import { DEVICE_OPTIONS, Orientation } from '@onlook/constants';
import type { WindowMetadata } from '@onlook/models';
import { Icons } from '@onlook/ui/icons/index';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger } from '@onlook/ui/select';
import { cn } from '@onlook/ui/utils';
import { computeWindowMetadata, getDeviceType } from '@onlook/utility';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import { HoverOnlyTooltip } from '../hover-tooltip';

const DeviceIcon = ({ deviceType, orientation, className }: { deviceType: string, orientation: Orientation, className?: string }) => {
    const iconClassName = `h-3.5 w-3.5 min-h-3.5 min-w-3.5 ${className || ''}`;
    switch (deviceType) {
        case 'Phone':
            return <Icons.Mobile className={iconClassName} />;
        case 'Desktop':
            return <Icons.Desktop className={iconClassName} />;
        case 'Laptop':
            return <Icons.Laptop className={iconClassName} />;
        case 'Tablet':
            return <Icons.Tablet className={iconClassName} />;
        default:
            return <CustomIcon orientation={orientation} className={className} />;
    }
};

const CustomIcon = ({ orientation, className }: { orientation: Orientation, className?: string }) => {
    const iconClassName = `h-3.5 w-3.5 min-h-3.5 min-w-3.5 ${className || ''}`;
    return orientation === Orientation.Landscape ? (
        <Icons.Landscape className={iconClassName} />
    ) : (
        <Icons.Portrait className={iconClassName} />
    );
};

export const DeviceSelector = observer(() => {
    const editorEngine = useEditorEngine();
    // Persistent toolbar control: act on the selected frame, or fall back to the first frame on the
    // canvas so the device selector stays usable when nothing is selected (e.g. in Preview).
    const frameData = editorEngine.frames.selected[0] ?? editorEngine.frames.getAll()[0];
    const frameWidth = frameData?.frame.dimension.width;
    const frameHeight = frameData?.frame.dimension.height;

    // NOTE: every hook must run unconditionally before any early return, otherwise the hook count
    // changes when the frame appears/disappears and React throws (this used to blank the toolbar).
    const [isOpen, setIsOpen] = useState(false);
    const [metadata, setMetadata] = useState<WindowMetadata>(() =>
        computeWindowMetadata(String(frameWidth ?? 0), String(frameHeight ?? 0))
    );
    const [device, setDevice] = useState('Custom:Custom');

    useEffect(() => {
        setMetadata(computeWindowMetadata(String(frameWidth ?? 0), String(frameHeight ?? 0)));
    }, [frameWidth, frameHeight]);

    // Keep the selected option label in sync with the frame's real dimensions.
    useEffect(() => {
        let match = 'Custom:Custom';
        for (const category in DEVICE_OPTIONS) {
            for (const deviceName in DEVICE_OPTIONS[category]) {
                if (DEVICE_OPTIONS[category][deviceName] === `${metadata.width}x${metadata.height}`) {
                    match = `${category}:${deviceName}`;
                }
            }
        }
        setDevice(match);
    }, [metadata.width, metadata.height]);

    const deviceType = useMemo(() => getDeviceType(metadata.device), [metadata.device]);
    // Show the chosen device NAME (e.g. "iMac"), not just its category, so picking iMac doesn't
    // appear to revert to "Desktop". Falls back to the type for Custom sizes.
    const deviceLabel = useMemo(() => {
        const name = device.split(':')[1];
        return name && name !== 'Custom' ? name : deviceType;
    }, [device, deviceType]);

    if (!frameData) return null;

    const handleDeviceChange = (value: string) => {
        setDevice(value);
        const [category, deviceName] = value.split(':');
        if (
            category &&
            deviceName &&
            DEVICE_OPTIONS[category]?.[deviceName] &&
            deviceName !== 'Custom'
        ) {
            const [w, h] = DEVICE_OPTIONS[category][deviceName].split('x').map(Number);
            if (typeof w === 'number' && !isNaN(w) && typeof h === 'number' && !isNaN(h)) {

                const roundedWidth = Math.round(w);
                const roundedHeight = Math.round(h);
                editorEngine.frames.updateAndSaveToStorage(frameData.frame.id, { dimension: { width: roundedWidth, height: roundedHeight } });
                // Resizing can push the frame out of view; recenter so it stays usable.
                editorEngine.frameEvent.recenterCanvas();
            }
        }
    };

    return (
        <Select value={device} onValueChange={handleDeviceChange} onOpenChange={setIsOpen}>
            <HoverOnlyTooltip content="Device" side="bottom" sideOffset={10} disabled={isOpen}>
                <SelectTrigger size="sm" className="group flex items-center gap-2 text-muted-foreground dark:bg-transparent border border-border/0 cursor-pointer rounded-lg hover:bg-background-tertiary/20 hover:text-foreground hover:border hover:border-border focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none focus-visible:outline-none">
                    <DeviceIcon deviceType={deviceType} orientation={metadata.orientation} className="group-hover:text-foreground-primary" />
                    <span className="text-smallPlus">{deviceLabel}</span>
                </SelectTrigger>
            </HoverOnlyTooltip>
            <SelectContent
                position="popper"
                side="bottom"
                align="start"
                sideOffset={6}
                // Clamp to the space Radix actually measured below the trigger so the list never
                // overflows the top of the viewport (it gets a scrollbar instead of being clipped).
                className="max-h-[min(60vh,var(--radix-select-content-available-height))] min-w-[220px]"
            >
                {Object.entries(DEVICE_OPTIONS).map(([category, devices], categoryIdx) => (
                    <SelectGroup key={category}>
                        {categoryIdx > 0 && <SelectSeparator className="bg-border/50" />}
                        <SelectLabel className="text-xs text-foreground-tertiary px-2 pt-1.5 pb-1">{category}</SelectLabel>
                        {Object.entries(devices).map(([name, dimensions]) => (
                            <SelectItem
                                key={`${category}:${name}`}
                                value={`${category}:${name}`}
                                className={cn(
                                    'text-xs flex items-center cursor-pointer gap-2 py-1.5',
                                    device === `${category}:${name}` && 'bg-background-tertiary/25 text-foreground-primary'
                                )}
                            >
                                <DeviceIcon deviceType={category} orientation={metadata.orientation} className={`${device === `${category}:${name}` ? 'text-foreground-primary' : 'text-foreground-onlook'}`} />
                                {name} <span className={`text-micro ${device === `${category}:${name}` ? 'text-foreground-primary' : 'text-foreground-tertiary'}`}>{dimensions.replace('x', '×')}</span>
                            </SelectItem>
                        ))}
                    </SelectGroup>
                ))}
            </SelectContent>
        </Select>
    );
}); 