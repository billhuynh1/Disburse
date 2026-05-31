'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from 'react';

type ProjectClipSearchContextValue = {
  query: string;
  setQuery: (query: string) => void;
  clearQuery: () => void;
};

const ProjectClipSearchContext =
  createContext<ProjectClipSearchContextValue | null>(null);

export function ProjectClipSearchProvider({
  children
}: {
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const clearQuery = useCallback(() => setQuery(''), []);
  const value = useMemo(
    () => ({ query, setQuery, clearQuery }),
    [query, clearQuery]
  );

  return (
    <ProjectClipSearchContext.Provider value={value}>
      {children}
    </ProjectClipSearchContext.Provider>
  );
}

export function useProjectClipSearch() {
  const context = useContext(ProjectClipSearchContext);

  if (!context) {
    throw new Error(
      'useProjectClipSearch must be used inside ProjectClipSearchProvider.'
    );
  }

  return context;
}
