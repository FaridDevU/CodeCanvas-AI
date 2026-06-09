// Local stub for the Supabase browser client. No auth/storage backend exists locally.
export function createClient(): any {
	return new Proxy({}, { get: () => () => undefined });
}

export const getFileUrlFromStorage = (_bucket: string, _path: string): string => '';

export const getFileInfoFromStorage = async (_bucket: string, _path: string): Promise<null> => null;

export const uploadBlobToStorage = async (
	_bucket: string,
	_path: string,
	_file: Blob,
	_options?: any,
): Promise<null> => null;
