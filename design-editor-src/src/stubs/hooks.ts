export function useCreateBlankProject() {
  return async () => ({ id: 'mock', name: 'Mock Project' });
}

export function useProjects() {
  return { projects: [], isLoading: false };
}

export function useAuth() {
  return { user: null, isLoading: false };
}
