// Local stub for tRPC `api`. No backend exists in the local Design editor.
// The proxy is infinitely chainable so any `api.x.y.<verb>(...)` access resolves, and the
// React-Query-style hooks return safely-shaped results so components can destructure them.

const asyncNoop = async (): Promise<undefined> => undefined;

const queryResult = (): any => ({
	data: undefined,
	error: null,
	isLoading: false,
	isPending: false,
	isFetching: false,
	isError: false,
	isSuccess: false,
	status: 'idle',
	refetch: async () => ({}),
	fetchNextPage: async () => ({}),
	hasNextPage: false,
});

const mutationResult = (): any => ({
	mutate: () => undefined,
	mutateAsync: asyncNoop,
	isPending: false,
	isLoading: false,
	isError: false,
	isSuccess: false,
	error: null,
	reset: () => undefined,
	data: undefined,
});

const makeProxy = (): any =>
	new Proxy(function () {}, {
		get: (_target, prop): any => {
			// Only the unambiguous React-Query hook names get special shapes. Everything else
			// (including tRPC procedure names like `cancel`, `reset`, `query`) stays a chainable,
			// callable proxy so both `api.x.y.useMutation()` and `api.x.y.query()` resolve.
			switch (prop) {
				case 'useQuery':
				case 'useSuspenseQuery':
				case 'useInfiniteQuery':
					return () => queryResult();
				case 'useMutation':
					return () => mutationResult();
				case 'useSubscription':
					return () => ({});
				case 'useUtils':
				case 'useContext':
					return () => makeProxy();
				default:
					return makeProxy();
			}
		},
		// Any call resolves to undefined (vanilla `api.x.query()`/`.mutate()` callers).
		apply: () => undefined,
	});

export const api: any = makeProxy();
export const createTRPCReact = (): any => makeProxy();
export const trpcClient: any = makeProxy();
export default api;
