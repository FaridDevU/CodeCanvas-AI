// Local stub for @codesandbox/sdk. CodeSandbox is the cloud preview provider we replace
// with a local provider; these placeholders only let the code-provider package build.
export class CodeSandbox { constructor(..._args: any[]) {} }
export class Sandbox {}
export class SandboxBrowserSession {}
export class WebSocketSession {}
export class Command {}
export class Task {}
export class Terminal {}
export class Watcher {}
export const connectToSandbox = async (..._args: any[]): Promise<any> => {
	throw new Error('CodeSandbox is disabled in the local Design editor');
};
export default {} as any;
