// Permissive empty stub for cloud-only @onlook packages with no local meaning.
// Any named import resolves to a no-op chainable proxy.
const proxy: any = new Proxy(function () {}, {
	get: () => proxy,
	apply: () => undefined,
	construct: () => proxy,
});
export default proxy;
export const __esModule = true;
