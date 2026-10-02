import { useState, useEffect, useMemo, useRef } from 'react';
import {
  getCourses, getMasteryLoginStatus, triggerMasteryLogin, runSync, getSyncMetrics, getTriageCalendar,
  getCurrentSync, getSyncRunEvents,
} from '../services/api.js';
import { reduceSyncEvents } from '../lib/syncEvents.js';
import SyncConfig from './SyncConfig.jsx';
import SyncProgress from './SyncProgress.jsx';

// How often a dialog that lost its stream polls the run's stored events, and
// how long polls may keep failing — counted in VISIBLE time only, restarted on
// every return to the page — before it stops in the neutral "can't reach"
// state. Generous on purpose: after an iPhone unlock the VPN / Wi-Fi is often
// still reconnecting, and a deploy answers 502 for a while.
const POLL_MS = 2000;
const GIVE_UP_MS = 3 * 60 * 1000;

// The stream failed before the server named the run, and Prism answered that
// nothing is running: the sync never started. Never surface a raw fetch error
// ("Load failed", "Failed to fetch").
function startErrorMessage(err) {
  const msg = String(err?.message || '');
  if (err instanceof TypeError || /load failed|failed to fetch|network/i.test(msg)) {
    return "The sync didn't start — Prism didn't respond. Try again.";
  }
  return `The sync didn't start: ${msg || 'unknown error'}`;
}

const NOTICES = {
  lost: 'Connection lost — still syncing on the server…',
  joined: 'A sync is already running — showing its progress.',
};

// A sync is a server-side run (see server/routes/schoology.js). The dialog
// follows it over the streaming POST; if that stream drops (iOS kills it when
// the screen locks) it keeps following by polling the run's stored events from
// the last `seq` it saw, so a dropped connection is never shown as an error.
export default function SyncDialog({ onClose, onSyncComplete, pollMs = POLL_MS, giveUpMs = GIVE_UP_MS }) {
  // stalled = following a run but Prism has been unreachable for giveUpMs of
  // visible time: neutral, closable, with "Try again".
  const [mode, setMode] = useState('loading'); // loading | config | running | stalled | done
  const [courses, setCourses] = useState([]);
  const [loggedIn, setLoggedIn] = useState(false);
  // Calendar freshness (source/totalSchoolDays/syncedAt), fetched alongside
  // courses so SyncConfig can seed its PowerSchool-step default once, at
  // mount — same "load everything before SyncConfig renders" pattern as
  // courses/loggedIn below. Left null on fetch failure; SyncConfig treats
  // null the same as "missing" (pre-ticks the step) rather than guessing fresh.
  const [calendar, setCalendar] = useState(null);
  const [events, setEvents] = useState([]);
  const [retryEnabled, setRetryEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [metrics, setMetrics] = useState(null);
  const [notice, setNotice] = useState(null); // null | 'lost' | 'joined'
  // The run being followed: { runId, lastSeq, stage: 'stream'|'poll'|'locate'|
  // 'stalled'|'done', controller, wake, quietSwitch, failSince, startError }. A ref, not state — the stream callback,
  // the poll loop and the visibility handler all read it mid-flight.
  const runRef = useRef(null);
  const unmounted = useRef(false);

  useEffect(() => {
    unmounted.current = false;
    let cancelled = false;
    // A sync already running (started on another device, or before this page
    // was reloaded) → go straight to following it instead of the config step.
    const current = getCurrentSync().catch(() => null);
    Promise.all([getCourses(true, true), getMasteryLoginStatus(), getTriageCalendar()])
      .then(([courseList, status, cal]) => {
        if (cancelled) return;
        setCourses(courseList);
        setLoggedIn(!!status.loggedIn);
        setCalendar(cal ?? null);
      })
      .catch(() => {})
      .then(() => current)
      .then((cur) => {
        if (cancelled) return;
        if (cur?.running && cur.runId != null) joinRun(cur.runId, 'joined');
        else setMode('config');
      });
    return () => {
      cancelled = true;
      unmounted.current = true;
      // Closing the dialog only stops *following* — the sync carries on
      // server-side. Drop the stream so the browser frees the connection.
      const r = runRef.current;
      if (r) { r.stage = 'done'; r.wake?.(); r.controller?.abort(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coming back to the page (phone unlocked, tab re-focused) while a sync runs:
  // poll now rather than waiting out a timer the OS may have frozen, and if we
  // were still on the stream, drop it for polling — after a screen lock iOS can
  // leave a fetch stream hung forever instead of failing it.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      const r = runRef.current;
      if (!r || r.stage === 'done') return;
      r.failSince = null; // back on the page: give the network a fresh budget
      if (r.stage === 'poll' || r.stage === 'locate') r.wake?.();
      else if (r.stage === 'stream' && r.runId != null) {
        r.quietSwitch = true;
        r.controller.abort();
      }
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const reduced = useMemo(() => reduceSyncEvents(events), [events]);

  // Append events not seen yet (stream and poll can overlap; seq dedupes).
  function ingest(r, evts) {
    const fresh = evts.filter((e) => e.seq == null || e.seq > r.lastSeq);
    if (!fresh.length) return;
    for (const e of fresh) if (e.seq != null && e.seq > r.lastSeq) r.lastSeq = e.seq;
    if (fresh.some((e) => e.type === 'summary' || e.type === 'error')) r.sawEnd = true;
    setEvents((prev) => [...prev, ...fresh]);
  }

  function sleep(r, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { r.wake = null; resolve(); }, ms);
      r.wake = () => { clearTimeout(t); r.wake = null; resolve(); };
    });
  }

  // Poll the run's stored events until it finishes → { status }, or
  // { unreachable: true } once polls have failed for giveUpMs of visible time
  // (failures while the page is hidden don't count), or { cancelled: true }.
  async function follow(r) {
    r.stage = 'poll';
    r.failSince = null;
    while (!unmounted.current && r.stage === 'poll') {
      try {
        const res = await getSyncRunEvents(r.runId, r.lastSeq);
        r.failSince = null;
        ingest(r, res.events || []);
        if (res.finished) return { status: res.status };
      } catch {
        if (document.hidden) r.failSince = null;
        else if (r.failSince == null) r.failSince = Date.now();
        else if (Date.now() - r.failSince >= giveUpMs) return { unreachable: true };
      }
      await sleep(r, pollMs);
    }
    return { cancelled: true };
  }

  function stall(r) {
    r.stage = 'stalled';
    if (!unmounted.current) setMode('stalled');
  }

  // Wrap up a run: refresh open pages if the server finished it, fetch
  // metrics, show the done state.
  async function finish(r, { refresh }) {
    r.stage = 'done';
    if (unmounted.current) return;
    if (refresh) onSyncComplete?.();
    try {
      const m = await getSyncMetrics();
      setMetrics(m);
    } catch { /* metrics fetch failure is non-fatal */ }
    setMode('done');
  }

  // Follow a run by polling from r.lastSeq (0 for a joined run, so its
  // earlier lines load too), then finish.
  async function pollToEnd(r) {
    const out = await follow(r);
    if (out.cancelled || unmounted.current || r.stage === 'done') return;
    if (out.unreachable) return stall(r);
    if (out.status === 'interrupted') {
      ingest(r, [{ type: 'error', message: 'The sync was interrupted — the server restarted before it finished. Run it again.' }]);
    }
    // Any finished run may have written data, so let open pages refresh.
    await finish(r, { refresh: true });
  }

  // The stream failed before the server named the run. Ask Prism what is
  // running, retrying with backoff while the network comes back; join the run
  // if there is one. Unreachable throughout → the neutral stalled state.
  async function locate(r) {
    r.stage = 'locate';
    const delays = [0, pollMs / 2, pollMs, pollMs * 2];
    let reached = false;
    for (const d of delays) {
      if (d) await sleep(r, d);
      if (unmounted.current || r.stage !== 'locate') return;
      try {
        const cur = await getCurrentSync();
        reached = true;
        if (cur?.running && cur.runId != null) return joinRun(cur.runId, 'lost');
        break;
      } catch { /* still reconnecting */ }
    }
    if (unmounted.current || r.stage !== 'locate') return;
    if (!reached) return stall(r);
    ingest(r, [{ type: 'error', message: startErrorMessage(r.startError) }]);
    // A sync that never started wrote nothing, so skip the refresh.
    return finish(r, { refresh: false });
  }

  // "Try again" from the stalled state: resume following.
  function resume() {
    const r = runRef.current;
    if (!r || r.stage !== 'stalled') return;
    setMode('running');
    if (r.runId != null) pollToEnd(r);
    else locate(r);
  }

  function joinRun(runId, why) {
    const r = { runId, lastSeq: 0, stage: 'poll', controller: null, wake: null };
    runRef.current = r;
    setEvents([]);
    setMetrics(null);
    setNotice(why);
    setMode('running');
    return pollToEnd(r);
  }

  // Fire-and-forget: startSync owns its error handling (failures surface as
  // events). While running the dialog can be closed with its Close button
  // (the sync carries on server-side; reopening Sync joins it) — there is
  // still no backdrop/Escape handler, so it never closes by accident.
  async function startSync(masteryCourseIds, { skipSchoology = false, includeHidden = false, recentOnly = false, recentDays = 30, syncBlocks = true } = {}) {
    const r = { runId: null, lastSeq: 0, stage: 'stream', controller: new AbortController(), wake: null, quietSwitch: false, sawEnd: false };
    runRef.current = r;
    setEvents([]);
    setMetrics(null);
    setNotice(null);
    setMode('running');
    try {
      await runSync({ masteryCourseIds, skipSchoology, includeHidden, recentOnly, recentDays, syncBlocks }, (evt) => {
        if (evt.type === 'run') { r.runId = evt.runId; return; }
        if (r.stage === 'stream') ingest(r, [evt]);
      }, { signal: r.controller.signal });
    } catch (err) {
      if (unmounted.current) return;
      if (err?.status === 409) {
        // Someone (another device, or this one before a reload) is syncing.
        let runId = err.runId;
        if (runId == null) runId = (await getCurrentSync().catch(() => null))?.runId;
        if (runId != null) return joinRun(runId, 'joined');
      } else if (r.runId != null) {
        // The stream dropped (or we dropped it on return to the page); the
        // run carries on server-side — follow it from the last seq we saw.
        if (!r.quietSwitch) setNotice('lost');
        return pollToEnd(r);
      } else {
        // Dropped before the run event arrived — is our sync running anyway?
        r.startError = err;
        return locate(r);
      }
      ingest(r, [{ type: 'error', message: err?.message || 'Sync failed' }]);
      // A hard request failure wrote nothing, so skip the refresh.
      return finish(r, { refresh: false });
    }
    // The stream ended cleanly. If it ended early (no summary/error — e.g. a
    // proxy closed it), the run may still be going: follow it to the end.
    if (r.runId != null && !r.sawEnd && !unmounted.current) {
      setNotice('lost');
      return pollToEnd(r);
    }
    // The stream completing means data was (at least partially) written, even if
    // individual courses errored. Signal open pages to refresh.
    return finish(r, { refresh: true });
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
    // Retry is mastery-only — don't re-run the PowerSchool block pass.
    startSync(courseIds, { skipSchoology: true, syncBlocks: false });
  }

  function handleRetryBlocks() {
    setRetryEnabled(false);
    // Retry is blocks-only — no mastery courses requested, don't re-run Schoology.
    startSync([], { skipSchoology: true, syncBlocks: true });
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content sync-dialog">
        {mode === 'loading' && <p className="loading">Loading courses…</p>}

        {mode === 'config' && (
          <SyncConfig
            courses={courses}
            calendar={calendar}
            loggedIn={loggedIn}
            busy={busy}
            onStart={(ids, opts) => startSync(ids, opts)}
            onCancel={onClose}
            onLogin={handleLogin}
          />
        )}

        {(mode === 'running' || mode === 'stalled' || mode === 'done') && (
          <>
            {mode === 'done' && metrics?.abandoned ? (
              <div className="alert alert-warning">
                Submission sync was abandoned due to repeated rate limits. Re-run sync to retry.
              </div>
            ) : mode === 'done' && metrics?.retries_failed > 0 ? (
              <div className="alert alert-warning">
                {metrics.retries_failed} assignment{metrics.retries_failed === 1 ? '' : 's'} couldn't sync — re-run sync when ready.
              </div>
            ) : null}
            <SyncProgress
              reduced={reduced}
              mode={mode}
              notice={mode === 'running' && notice ? NOTICES[notice] : null}
              onClose={onClose}
              onTryAgain={resume}
              retryEnabled={retryEnabled}
              onDone={onClose}
              onRetry={handleRetry}
              onRetryBlocks={handleRetryBlocks}
              onLogin={handleLogin}
            />
          </>
        )}
      </div>
    </div>
  );
}
