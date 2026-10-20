import { useCallback, useEffect, useRef, useState } from 'react';
import { ensureSync, getCurrentSync, getSyncRun } from '../services/api.js';

const POLL_MS = 2000;
const FAILED = ['failed', 'completed_with_errors', 'interrupted'];
const ACTIVE = ['queued', 'running', 'held'];

// Background sync (20/10/2026): a page asks the server to sync its scope after it loads
// (POST /api/sync/ensure: nothing when synced or tried in the last 10 minutes), then follows the
// run through the queue until it ends, when `onDone(status, runId)` reloads the page's data.
//   scope: { kind: 'all' } | { kind: 'courses', courseIds } | { kind: 'task', courseId, assignmentId },
//          or null (not loaded yet, or archived: no background sync)
// → { state: 'idle' | 'fresh' | 'queued' | 'running' | 'held' | 'failed' | 'done', runId, follow(runId) }.
// `follow(runId)` tracks a run a button started (Sync Assignment), so the same chip shows it.
export function useBackgroundSync(scope, { onDone, pollMs = POLL_MS } = {}) {
  const [sync, setSync] = useState({ state: 'idle', runId: null });
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const token = useRef(0); // the current follow; a newer scope or follow cancels older loops
  const key = scope ? JSON.stringify(scope) : null;

  const follow = useCallback(async (runId) => {
    const mine = (token.current += 1);
    const live = () => mine === token.current;
    setSync({ state: 'queued', runId });
    for (;;) {
      let cur = null;
      try { cur = await getCurrentSync(); } catch { cur = null; }
      if (!live()) return;
      if (cur) {
        const where = cur.running?.runId === runId ? 'running'
          : (cur.queued ?? []).some((q) => q.runId === runId) ? 'queued'
          : (cur.held ?? []).some((q) => q.runId === runId) ? 'held'
          : null;
        let state = where;
        if (!where) {
          // Not in the queue's answer: its own record decides (it may be between two states).
          let status = 'completed';
          try { status = (await getSyncRun(runId))?.status ?? status; } catch { /* keep 'completed' */ }
          if (!live()) return;
          if (ACTIVE.includes(status)) {
            state = status;
          } else {
            setSync({ state: FAILED.includes(status) ? 'failed' : 'done', runId });
            await onDoneRef.current?.(status, runId);
            return;
          }
        }
        setSync({ state, runId });
      }
      await new Promise((r) => setTimeout(r, pollMs));
      if (!live()) return;
    }
  }, [pollMs]);

  useEffect(() => {
    if (!key) { token.current += 1; setSync({ state: 'idle', runId: null }); return undefined; }
    const mine = (token.current += 1);
    // Through a promise, so a throw or an odd answer becomes a state, never a page error.
    Promise.resolve().then(() => ensureSync(JSON.parse(key)))
      .then((r) => {
        if (mine !== token.current) return;
        if (r?.state === 'fresh' || r?.runId == null) setSync({ state: 'fresh', runId: null });
        else follow(r.runId);
      })
      .catch(() => { if (mine === token.current) setSync({ state: 'failed', runId: null }); });
    return () => { token.current += 1; };
  }, [key, follow]);

  return { ...sync, follow };
}
