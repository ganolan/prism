import { useState, useEffect, useMemo } from 'react';
import { getCourses, getMasteryLoginStatus, triggerMasteryLogin, runSync } from '../services/api.js';
import { reduceSyncEvents } from '../lib/syncEvents.js';
import SyncConfig from './SyncConfig.jsx';
import SyncProgress from './SyncProgress.jsx';

export default function SyncDialog({ onClose }) {
  const [mode, setMode] = useState('loading'); // loading | config | running | done
  const [courses, setCourses] = useState([]);
  const [loggedIn, setLoggedIn] = useState(false);
  const [events, setEvents] = useState([]);
  const [retryEnabled, setRetryEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getCourses(true, true), getMasteryLoginStatus()])
      .then(([courseList, status]) => {
        if (cancelled) return;
        setCourses(courseList);
        setLoggedIn(!!status.loggedIn);
        setMode('config');
      })
      .catch(() => { if (!cancelled) setMode('config'); });
    return () => { cancelled = true; };
  }, []);

  const reduced = useMemo(() => reduceSyncEvents(events), [events]);

  // Fire-and-forget: startSync owns its error handling (failures surface as
  // events). The running-mode overlay is intentionally non-dismissable —
  // there is no backdrop/Escape handler — so the stream always runs to
  // completion and needs no abort path.
  async function startSync(masteryCourseIds, { skipSchoology = false } = {}) {
    setEvents([]);
    setMode('running');
    try {
      await runSync({ masteryCourseIds, skipSchoology }, (evt) => {
        setEvents((prev) => [...prev, evt]);
      });
    } catch (err) {
      setEvents((prev) => [...prev, { type: 'error', message: err.message }]);
    }
    setMode('done');
  }

  async function handleLogin() {
    setBusy(true);
    try {
      await triggerMasteryLogin();
      const status = await getMasteryLoginStatus();
      setLoggedIn(!!status.loggedIn);
      setRetryEnabled(true);
    } catch {
      /* login browser failed or was cancelled — leave state unchanged */
    } finally {
      setBusy(false);
    }
  }

  function handleRetry(courseIds) {
    setRetryEnabled(false);
    startSync(courseIds, { skipSchoology: true });
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content sync-dialog">
        {mode === 'loading' && <p className="loading">Loading courses…</p>}

        {mode === 'config' && (
          <SyncConfig
            courses={courses}
            loggedIn={loggedIn}
            busy={busy}
            onStart={(ids) => startSync(ids)}
            onCancel={onClose}
            onLogin={handleLogin}
          />
        )}

        {(mode === 'running' || mode === 'done') && (
          <SyncProgress
            reduced={reduced}
            mode={mode}
            retryEnabled={retryEnabled}
            onDone={onClose}
            onRetry={handleRetry}
            onLogin={handleLogin}
          />
        )}
      </div>
    </div>
  );
}
