import { useEffect, useRef, useState } from 'react';

// #52 (and #108: the triage and course reads of submissions and scores use it too, through the
// same answer shape): a page that shows mastery renders what Prism holds, then asks the server to read it from
// Schoology again (`refresh`: an api.js refreshMasteryFor… call; the server skips a read made in the
// last 2 minutes). When Schoology was read, `onRefreshed` reloads the page's mastery.
// `key` starts one refresh per value (a course id, an assignment); null waits (data not loaded yet,
// or an archived course, whose levels no longer change).
// → { status: 'idle' | 'refreshing' | 'done' | 'error', syncedAt, error, signIn }.
export function useMasteryRefresh(key, refresh, onRefreshed) {
  const [state, setState] = useState({ status: 'idle', syncedAt: null, error: null, signIn: false });
  const refreshRef = useRef(refresh);
  const onRefreshedRef = useRef(onRefreshed);
  refreshRef.current = refresh;
  onRefreshedRef.current = onRefreshed;

  useEffect(() => {
    if (key == null) { setState({ status: 'idle', syncedAt: null, error: null, signIn: false }); return undefined; }
    let live = true;
    setState({ status: 'refreshing', syncedAt: null, error: null, signIn: false });
    Promise.resolve()
      .then(() => refreshRef.current())
      .then(async (r) => {
        if (!live) return;
        if (r?.refreshed) await onRefreshedRef.current?.(r);
        if (!live) return;
        setState({ status: r?.error ? 'error' : 'done', syncedAt: r?.syncedAt ?? null, error: r?.error ?? null, signIn: Boolean(r?.signIn) });
      })
      .catch((err) => { if (live) setState({ status: 'error', syncedAt: null, error: err?.message || String(err), signIn: false }); });
    return () => { live = false; };
  }, [key]);

  return state;
}
