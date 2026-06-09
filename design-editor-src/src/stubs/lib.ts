export function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(' ');
}

export function getRelativeMousePositionToFrameView(...args: any[]) {
  return { x: 0, y: 0 };
}
