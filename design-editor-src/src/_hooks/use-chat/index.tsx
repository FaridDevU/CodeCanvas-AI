// Local stub for Onlook's cloud chat hook. The real chat will be CodeCanvas' own Copilot;
// this keeps the chat panel rendering with an empty, inert state for now.
export type SendMessage = (content: string, type: any) => Promise<any>;
export type EditMessage = (...args: any[]) => Promise<any>;
export type ProcessMessage = (...args: any[]) => Promise<any>;

export function useChat(_props?: any) {
	return {
		status: 'idle' as const,
		sendMessage: async () => undefined,
		editMessage: async () => undefined,
		messages: [] as any[],
		error: null as any,
		stop: () => undefined,
		isStreaming: false,
		queuedMessages: [] as any[],
		removeFromQueue: (_id: string) => undefined,
	};
}
