import { useCallback, useEffect, useRef, useState } from 'react';
import { getSyncStatus } from '../services/api.js';

// What the sync pages need from GET /api/sync/status beyond the run itself (#171): whether the
// night's refresh is on and when blocks, calendar and alerts were last read (`nightlyData`), and
// the last past-course import (`pastImport`, Task 5). One fetch on mount and whenever `refreshKey`
// changes (a page passes its data version, so a finished sync shows its new time); `reload()`
// fetches again. `status` is the whole response. All null until the answer arrives, or if it fails.
export function useSyncFacts(refreshKey = 0) {
  const [status, setStatus] = useState(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reload = useCallback(async () => {
    try {
      const s = (await getSyncStatus()) ?? null;
      if (alive.current) setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => { reload(); }, [reload, refreshKey]);
  return {
    status,
    nightlyData: status?.nightlyData ?? null,
    pastImport: status?.pastImport ?? null,
    reload,
  };
}
