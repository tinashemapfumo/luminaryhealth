import React, { createContext, useContext } from 'react';

/**
 * Workspace context.
 *
 * The page components in `components/pages/` are views over one shared
 * workspace: the signed-in user, the tenant-scoped collections, and the
 * actions that mutate them. Threading forty props through each page would be
 * unreadable and would couple every page to the shell's internals, so the
 * shell publishes one value and each page destructures what it needs.
 *
 * Deliberately not a state container. All state still lives in the shell;
 * this only carries it. When the API service layer lands, the shell swaps its
 * local state for service calls and every page keeps working unchanged.
 */
const WorkspaceContext = createContext(null);

export function WorkspaceProvider({ value, children }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error('useWorkspace must be used inside a WorkspaceProvider');
  }
  return value;
}
