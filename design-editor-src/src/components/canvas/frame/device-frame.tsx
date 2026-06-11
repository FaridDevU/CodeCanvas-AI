// Cosmetic device frame drawn around the preview iframe. The frame type is derived from
// the frame's logical dimension using the same device classification as the existing
// device selector (computeWindowMetadata + getDeviceType), so it follows the selector
// rather than introducing a separate device control. Unknown sizes get no frame (the
// preview renders plainly), which is the safe fallback.

import { computeWindowMetadata, getDeviceType } from '@onlook/utility';
import './device-frame.css';

export type DeviceFrameType = 'phone' | 'tablet' | 'laptop';

/** Maps a logical viewport size to a device frame, or null when there is no good match. */
export function deviceFrameTypeFor(width: number, height: number): DeviceFrameType | null {
    const device = computeWindowMetadata(String(width), String(height)).device;
    switch (getDeviceType(device)) {
        case 'Phone':
            return 'phone';
        case 'Tablet':
            return 'tablet';
        case 'Laptop':
        case 'Desktop':
            return 'laptop';
        default:
            return null;
    }
}

/** Border radius (px) applied to the iframe so its corners match the surrounding frame. */
export function deviceFrameRadius(type: DeviceFrameType): number {
    switch (type) {
        case 'phone':
            return 30;
        case 'tablet':
            return 10;
        case 'laptop':
            return 4;
    }
}

export const DeviceFrame = ({ type }: { type: DeviceFrameType }) => (
    <div className={`cc-device-frame cc-device-frame--${type}`} aria-hidden="true">
        <div className="cc-device-frame__bezel" />
        {type === 'phone' && <div className="cc-device-frame__notch" />}
        {type === 'tablet' && <div className="cc-device-frame__camera" />}
        {type === 'laptop' && (
            <>
                <div className="cc-device-frame__notch" />
                <div className="cc-device-frame__base" />
            </>
        )}
    </div>
);
