// Local stub for @onlook/ai (Onlook's LLM tools). The local editor will use CodeCanvas'
// own Copilot/Claude instead; these are inert placeholders so the chat UI builds.
class StubTool {
	constructor(..._args: any[]) {}
	static toolName = 'stub';
}
export const BaseTool: any = StubTool;
export const FuzzyEditFileTool: any = StubTool;
export const SearchReplaceEditTool: any = StubTool;
export const SearchReplaceMultiEditFileTool: any = StubTool;
export const TerminalCommandTool: any = StubTool;
export const TypecheckTool: any = StubTool;
export const WebSearchTool: any = StubTool;
export const WriteFileTool: any = StubTool;
export const ListFilesTool: any = StubTool;
export const ReadFileTool: any = StubTool;
export const TOOLS_MAP: any = {};
export const getContextClass: any = () => undefined;
export const getContextLabel: any = () => '';
export default {} as any;
