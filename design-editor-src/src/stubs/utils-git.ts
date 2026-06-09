// Local stub for @/utils/git helpers used by the git manager.
export const prepareCommitMessage = (message: string): string => message;
export const sanitizeCommitMessage = (message: string): string => message;
export const withSyncPaused = async <T>(fn: () => Promise<T> | T): Promise<T> => fn();
