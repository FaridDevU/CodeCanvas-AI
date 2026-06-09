// Local stub for @onlook/db. Only the few values the editor store uses are provided;
// the real package pulls in Drizzle/Supabase which has no place in the local editor.

export const DefaultDesktopFrame = {
	x: '150',
	y: '40',
	width: '1536',
	height: '960',
} as const;

export const DefaultMobileFrame = {
	x: '1600',
	y: '0',
	width: '440',
	height: '956',
} as const;

export const toDbFrame = (frame: any): any => frame;
export const toDbPartialFrame = (frame: any): any => frame;
