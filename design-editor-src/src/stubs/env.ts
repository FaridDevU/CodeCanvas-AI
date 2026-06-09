// Local stub for @/env (cloud env validation via @t3-oss). No server env locally.
export const env: any = new Proxy({}, { get: () => undefined });
