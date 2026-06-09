// Local stub for @/services/sync-engine/sync-engine (cloud file sync; not used locally).
export class CodeProviderSync {
	constructor(..._args: any[]) {}
	start(..._args: any[]): void {}
	stop(..._args: any[]): void {}
	dispose(..._args: any[]): void {}
}

// Simple local content hash (the real one lived in the cloud sync engine).
export function hashContent(content: string): string {
	let hash = 0;
	for (let i = 0; i < content.length; i++) {
		hash = (hash << 5) - hash + content.charCodeAt(i);
		hash |= 0;
	}
	return String(hash >>> 0);
}
