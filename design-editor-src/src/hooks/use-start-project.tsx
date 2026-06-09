// Local replacement for Onlook's cloud `useStartProject` (which used tRPC/Supabase).
// In the local Design editor there is no remote project to fetch; the engine is driven
// by the folder open in CodeCanvas. For now we report ready immediately.
export const useStartProject = () => {
	return { isProjectReady: true, error: null as string | null };
};
