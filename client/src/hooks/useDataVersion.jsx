import { createContext, useContext } from 'react';

// A monotonically increasing counter, bumped whenever a global data refresh is
// warranted (currently: a sync completing). Data-fetching pages add the value
// to their fetch effect's dependency array, so an open page re-pulls fresh data
// after a sync instead of showing a pre-sync snapshot until manually reloaded.
export const DataVersionContext = createContext(0);

export function useDataVersion() {
  return useContext(DataVersionContext);
}

// Bumps that counter: a sync started from a page (#58 Sync Course) reloads every open page, as a
// sidebar sync does. A no-op outside the provider (tests).
export const BumpDataVersionContext = createContext(() => {});

export function useBumpDataVersion() {
  return useContext(BumpDataVersionContext);
}
