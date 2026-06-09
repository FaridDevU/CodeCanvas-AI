// Local stub for @onlook/git (only the GitCommit type is referenced by the store).
export type GitCommit = {
	oid: string;
	message: string;
	author?: { name?: string; email?: string; timestamp?: number };
	displayName?: string;
};
