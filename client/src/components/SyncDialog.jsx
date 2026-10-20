import { goToSignIn } from '../lib/signIn.js';
import { useState, useEffect, useMemo, useRef } from 'react';
import { startSync as queueSync, getSyncMetrics, getSyncRunEvents } from '../services/api.js';
import { reduceSyncEvents } from '../lib/syncEvents.js';
import SyncProgress from './SyncProgress.jsx';

// How often the dialog polls the run's stored events, and how long polls may keep failing (in
// VISIBLE time only, restarted on every return to the page) before it stops in the neutral
// "can't reach" state. Generous on purpose: after an iPhone unlock the VPN / Wi-Fi is often still
// reconnecting, and a deploy answers 502 for a while.
const POLL_MS = 2000;
const GIVE_UP_MS = 3 * 60 * 1000;

const NOTICES = {
  joined: 'This sync was already queued: showing its progress.',
  waiting: 'Waiting for the running sync to finish, then this one starts.',
};

// Every sync is a run in the server's queue (server/services/syncQueue.js). The dialog asks for
// one (POST /api/sync → runId) and follows it by polling its stored events from the last `seq`
// it saw, so a dropped connection or a locked phone is never shown as an error. Closing the
// dialog only stops following: the run carries on, and nothing queued is lost.
//   request (a POST /api/sync body): asks for that run on mount. The dashboard's Sync Courses sends
//     { everything: true }, the nightly run's scope with PowerSchool on (#171). There is no course
//     list to tick.
//   presetCourse ({ id, name }, Sync Course): the same path, for that one course (everything,
//     PowerSchool off).
//   followRunId: open on a run that is already queued or running (a page's "Syncing…" chip).
//   onRun(runId): the run a press here queued (or joined), so the page's chip follows it after
//     the dialog closes.
export default function SyncDialog({ onClose, onSyncComplete, onRun, request = null, presetCourse = null, followRunId = null, pollMs = POLL_MS, giveUpMs = GIVE_UP_MS }) {
  // stalled = following a run but Prism has been unreachable for giveUpMs of visible time;
  // held = the run waits for a Schoology sign-in.
  const [mode, setMode] = useState('running'); // running | stalled | held | done
  const [events, setEvents] = useState([]);
  const [retryEnabled, setRetryEnabled] = useState(false);
  const [metrics, setMetrics] = useState(null);
  const [notice, setNotice] = useState(null); // null | 'joined' | 'waiting'
  // The run being followed: { runId, lastSeq, stage: 'poll' | 'stalled' | 'done', wake, failSince }.
  const runRef = useRef(null);
  const unmounted = useRef(false);
  // A request is posted once per dialog: React StrictMode runs the mount effect twice in dev. A
  // followed run is simply followed again (the first follow was cancelled by the cleanup).
  const started = useRef(false);

  useEffect(() => {
    unmounted.current = false;
    if (followRunId != null) {
      joinRun(followRunId, null);
    } else if (!started.current) {
      // Posted once: on StrictMode's second mount, the first post's answer joins the run (startSync).
      started.current = true;
      if (request) startSync(request);
      else if (presetCourse) startSync({ courseIds: [Number(presetCourse.id)], syncBlocks: false });
    }
    return () => {
      unmounted.current = true;
      const r = runRef.current;
      if (r) { r.stage = 'done'; r.wake?.(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coming back to the page (phone unlocked, tab re-focused): poll now rather than waiting out a
  // timer the OS may have frozen, with a fresh budget for the network.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      const r = runRef.current;
      if (!r || r.stage !== 'poll') return;
      r.failSince = null;
      r.wake?.();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const reduced = useMemo(() => reduceSyncEvents(events), [events]);

  // Append events not seen yet (seq dedupes).
  function ingest(r, evts) {
    const fresh = evts.filter((e) => e.seq == null || e.seq > r.lastSeq);
    if (!fresh.length) return;
    for (const e of fresh) if (e.seq != null && e.seq > r.lastSeq) r.lastSeq = e.seq;
    setEvents((prev) => [...prev, ...fresh]);
  }

  function sleep(r, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { r.wake = null; resolve(); }, ms);
      r.wake = () => { clearTimeout(t); r.wake = null; resolve(); };
    });
  }

  // Poll the run's stored events until it finishes → { status } (showing the sign-in while it is
  // held), polls have failed for giveUpMs of visible time → { unreachable: true }, or { cancelled: true }.
  async function follow(r) {
    r.stage = 'poll';
    r.failSince = null;
    while (!unmounted.current && r.stage === 'poll') {
      try {
        const res = await getSyncRunEvents(r.runId, r.lastSeq);
        if (r.stage !== 'poll') break; // cancelled while it waited (a newer follow took over)
        r.failSince = null;
        ingest(r, res.events || []);
        if (res.finished) return { status: res.status };
        if (!unmounted.current) {
          // A held run stays followed: a sign-in (here or on another page) lets it run on.
          setMode((m) => (res.status === 'held' ? 'held' : m === 'held' ? 'running' : m));
          setNotice((n) => (res.status === 'queued' ? 'waiting' : n === 'waiting' ? null : n));
        }
      } catch {
        if (document.hidden) r.failSince = null;
        else if (r.failSince == null) r.failSince = Date.now();
        else if (Date.now() - r.failSince >= giveUpMs) return { unreachable: true };
      }
      await sleep(r, pollMs);
    }
    return { cancelled: true };
  }

  // Wrap up a run: refresh open pages, fetch metrics, show the done state.
  async function finish(r, { refresh }) {
    r.stage = 'done';
    if (unmounted.current) return;
    if (refresh) onSyncComplete?.();
    try {
      setMetrics(await getSyncMetrics());
    } catch { /* metrics fetch failure is non-fatal */ }
    setMode('done');
  }

  async function pollToEnd(r) {
    const out = await follow(r);
    if (out.cancelled || unmounted.current || r.stage === 'done') return;
    if (out.unreachable) { r.stage = 'stalled'; setMode('stalled'); return; }
    if (out.status === 'interrupted') {
      ingest(r, [{ type: 'error', message: 'The sync was interrupted: the server restarted before it finished. Run it again.' }]);
    }
    // Any finished run may have written data, so let open pages refresh.
    await finish(r, { refresh: true });
  }

  // "Try again" from the stalled state: resume following.
  function resume() {
    const r = runRef.current;
    if (!r || r.stage !== 'stalled') return;
    setMode('running');
    pollToEnd(r);
  }

  function joinRun(runId, why) {
    const r = { runId, lastSeq: 0, stage: 'poll', wake: null };
    runRef.current = r;
    setEvents([]);
    setMetrics(null);
    setNotice(why);
    setMode('running');
    return pollToEnd(r);
  }

  // Ask the queue for a sync, then follow it. A request the queue joins to one already queued
  // follows that run.
  async function startSync(request) {
    setMode('running');
    setEvents([]);
    setNotice(null);
    try {
      const r = await queueSync(request);
      onRun?.(r.runId);
      if (unmounted.current) return undefined;
      return joinRun(r.runId, r.joined ? 'joined' : null);
    } catch (err) {
      if (unmounted.current) return undefined;
      const r = { runId: null, lastSeq: 0, stage: 'done' };
      runRef.current = r;
      ingest(r, [{ type: 'error', message: `The sync didn't start: ${err?.message || 'Prism did not respond'}` }]);
      return finish(r, { refresh: false });
    }
  }

  function handleRetry(courseIds) {
    setRetryEnabled(false);
    // Retry is mastery-only: don't re-run Schoology or the PowerSchool block pass.
    startSync({ masteryCourseIds: courseIds, skipSchoology: true, syncBlocks: false });
  }

  function handleRetryBlocks() {
    setRetryEnabled(false);
    startSync({ masteryCourseIds: [], skipSchoology: true, syncBlocks: true });
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content sync-dialog">
        {mode === 'held' && (
          <div className="sync-progress">
            <div className="sync-progress-head sync-head-warn"><h2>Waiting for a Schoology sign-in</h2></div>
            <p>This sync starts as soon as you log in to Schoology.</p>
            <div className="sync-foot-actions">
              <button type="button" className="primary" onClick={goToSignIn}>Log in to Schoology</button>
              <button type="button" className="ghost" onClick={onClose}>Close</button>
            </div>
          </div>
        )}

        {(mode === 'running' || mode === 'stalled' || mode === 'done') && (
          <>
            {mode === 'done' && metrics?.abandoned ? (
              <div className="alert alert-warning">
                Submission sync was abandoned due to repeated rate limits. Re-run sync to retry.
              </div>
            ) : mode === 'done' && metrics?.retries_failed > 0 ? (
              <div className="alert alert-warning">
                {metrics.retries_failed} assignment{metrics.retries_failed === 1 ? '' : 's'} couldn't sync: re-run sync when ready.
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
              onLogin={goToSignIn}
            />
          </>
        )}
      </div>
    </div>
  );
}
