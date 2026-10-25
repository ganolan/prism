import { useEffect, useState } from 'react';
import NumberStepper from '../components/NumberStepper.jsx';
import { GradeScaleChart } from '../components/GradeScale.jsx';
import RecentSyncs from '../components/RecentSyncs.jsx';
import SchoologyConnectionStatus, { useSchoologyConnection } from '../components/SchoologyConnectionStatus.jsx';
import { getSettings, updateSettings, getTriage } from '../services/api.js';
import RemoteSignIn from '../components/RemoteSignIn.jsx';
import { formatDateTime } from '../lib/formatDate.js';

// The saved Schoology browser session (mastery sync, OneDrive links, unsubmitting work on
// an Ask): its live status, a re-check, and the sign-in. Log in to Schoology opens the
// server's own Microsoft sign-in here, as a picture you tap and type into
// (RemoteSignIn, #136), so it works from a phone. Anchor: /settings#schoology (the Ask
// modal's "reconnect in Settings" link); /settings#schoology-signin opens the sign-in.
function SchoologyConnectionCard() {
  const connection = useSchoologyConnection();
  const [signingIn, setSigningIn] = useState(() => window.location.hash === '#schoology-signin');
  const [loginMsg, setLoginMsg] = useState(null);

  function open() {
    setLoginMsg(null);
    setSigningIn(true);
  }

  function finished(signedIn) {
    setSigningIn(false);
    if (signedIn) setLoginMsg('Login saved.');
    connection.refresh();
  }

  return (
    <section className="card settings-section" id="schoology" aria-labelledby="schoology-connection-title">
      <h3 id="schoology-connection-title">Schoology connection</h3>
      <p className="text-sm text-muted">
        Prism&apos;s saved Schoology login, used for mastery sync, OneDrive links and unsubmitting work when you ask for a resubmission.
      </p>
      <div className="settings-row">
        <SchoologyConnectionStatus connection={connection} />
      </div>
      {signingIn ? (
        <RemoteSignIn onClose={finished} />
      ) : (
        <div className="settings-row">
          <button type="button" className="secondary" onClick={open}>Log in to Schoology</button>
          <span className="text-sm text-muted">Opens the sign-in here, on this device: a phone works too.</span>
        </div>
      )}
      {loginMsg && <p className="text-sm text-muted" role="status">{loginMsg}</p>}
    </section>
  );
}

const LAST_RUN_LABEL = {
  running: 'running now',
  completed: 'completed',
  completed_with_errors: 'completed with errors (see Recent syncs)',
  failed: 'failed (see Recent syncs)',
  interrupted: 'interrupted by a server restart',
  skipped: 'skipped, a sync was already running',
};

// Nightly unified sync, run by the prod server at the chosen time
// (server/services/syncScheduler.js). Only prod arms it, so a dev copy says so.
function ScheduledSyncCard({ schedule, status, message, onSave }) {
  const last = status.last;
  return (
    <section className="card settings-section" aria-labelledby="scheduled-sync-title">
      <h3 id="scheduled-sync-title">Scheduled sync</h3>
      <p className="text-sm text-muted">
        A full sync the server runs by itself every day, recorded in Recent syncs like any other.
      </p>
      {!status.active && (
        <div className="alert alert-warning">This copy of Prism never runs the schedule: only the prod server does.</div>
      )}
      <div className="settings-row">
        <label className="settings-row">
          <input type="checkbox" checked={schedule.enabled} onChange={(e) => onSave({ enabled: e.target.checked })} />
          <span>Sync every day at</span>
        </label>
        <input
          type="time" aria-label="Scheduled sync time" value={schedule.time} disabled={!schedule.enabled} style={{ width: 'auto' }}
          onChange={(e) => { if (e.target.value) onSave({ time: e.target.value }); }}
        />
      </div>
      <label className="settings-row">
        <input type="checkbox" checked={schedule.syncBlocks} onChange={(e) => onSave({ syncBlocks: e.target.checked })} />
        <span>Sync PowerSchool blocks and school calendar</span>
      </label>
      <label className="settings-row">
        <input type="checkbox" checked={schedule.includeHidden} onChange={(e) => onSave({ includeHidden: e.target.checked })} />
        <span>Include hidden courses</span>
      </label>
      {status.active && (
        <p className="text-sm text-muted" data-testid="scheduled-sync-next">
          {status.nextRunAt ? `Next run: ${formatDateTime(status.nextRunAt)}` : 'Off: no sync is scheduled.'}
        </p>
      )}
      <p className="text-sm text-muted" data-testid="scheduled-sync-last">
        {last ? `Last scheduled sync: ${formatDateTime(last.at)}, ${LAST_RUN_LABEL[last.status] || last.status}` : 'No scheduled sync has run yet.'}
      </p>
      {message && <p className="text-sm text-muted" role="status">{message}</p>}
    </section>
  );
}

// App settings, stored server-side (shared by every device and PrisMCP).
export default function SettingsPage() {
  const [triage, setTriage] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [scheduleStatus, setScheduleStatus] = useState(null);
  const [calendar, setCalendar] = useState(null);
  const [status, setStatus] = useState(null);
  const [scheduleMsg, setScheduleMsg] = useState(null);

  useEffect(() => {
    getSettings().then((s) => {
      setTriage(s.triage);
      setSchedule(s.syncSchedule);
      setScheduleStatus(s.syncScheduleStatus);
    }).catch((err) => setStatus(`Could not load settings: ${err.message}`));
    (async () => {
      try { const t = await getTriage(); if (t) setCalendar(t.calendar); } catch { /* shown as loading */ }
    })();
  }, []);

  async function save(patch) {
    const prevTriage = triage;
    setTriage((prev) => ({ ...prev, ...patch }));
    try {
      const s = await updateSettings({ triage: patch });
      setTriage(s.triage);
      setStatus('Saved');
    } catch (err) {
      setTriage(prevTriage);
      setStatus(`Not saved: ${err.message}`);
    }
  }

  async function saveSchedule(patch) {
    const prev = schedule;
    setSchedule((p) => ({ ...p, ...patch }));
    try {
      const s = await updateSettings({ syncSchedule: patch });
      setSchedule(s.syncSchedule);
      setScheduleStatus(s.syncScheduleStatus);
      setScheduleMsg('Saved');
    } catch (err) {
      setSchedule(prev);
      setScheduleMsg(`Not saved: ${err.message}`);
    }
  }

  // /settings#schoology: the card renders once the settings have loaded — scroll to it then.
  useEffect(() => {
    if (triage && window.location.hash === '#schoology') document.getElementById('schoology')?.scrollIntoView?.({ block: 'start' });
  }, [Boolean(triage)]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!triage) return status ? <div className="error-msg">{status}</div> : <div className="loading">Loading...</div>;

  return (
    <div className="fade-in">
      <h2 className="page-title">Settings</h2>

      <section className="card settings-section">
        <h3>Triage</h3>
        <p className="text-sm text-muted">
          Counted in school days after the due date (or test date). Applies to the Dashboard, course pages and PrisMCP.
        </p>
        <div className="settings-row">
          <span>Refer late work at</span>
          <NumberStepper value={triage.referralLimitDays} min={1} max={60} onChange={(v) => save({ referralLimitDays: v })} aria-label="Referral limit (school days late)" />
          <span>school days late</span>
        </div>
        <div className="settings-row">
          <span>Feedback is overdue at</span>
          <NumberStepper value={triage.feedbackLimitDays} min={1} max={60} onChange={(v) => save({ feedbackLimitDays: v })} aria-label="Feedback limit (school days waiting)" />
          <span>school days waiting</span>
        </div>
        <div className="settings-row">
          <span>Amber warning starts</span>
          <NumberStepper value={triage.warnLeadDays} min={0} max={59} onChange={(v) => save({ warnLeadDays: v })} aria-label="Warning lead (school days)" />
          <span>school days before each limit</span>
        </div>
        <div className="settings-row">
          {/* Stored as day numbers (test day = day 1); shown as school days after the test. */}
          <span>Make-up tests turn amber</span>
          <NumberStepper value={triage.makeUpAmberDay - 1} min={0} max={triage.makeUpRedDay - 1} onChange={(v) => save({ makeUpAmberDay: v + 1 })} aria-label="Make-up amber (school days after the test)" />
          <span>and red</span>
          <NumberStepper value={triage.makeUpRedDay - 1} min={1} max={30} onChange={(v) => save({ makeUpRedDay: v + 1 })} aria-label="Make-up red (school days after the test)" />
          <span>school days after the test</span>
        </div>
        <div className="settings-row">
          <span>Resubmission deadline (default)</span>
          <NumberStepper value={triage.resubmitLessonsDefault} min={1} max={60} onChange={(v) => save({ resubmitLessonsDefault: v })} aria-label="Resubmission deadline (school days)" />
          <span className="text-sm text-muted">school days after asking</span>
        </div>
        <label className="settings-row">
          <input type="checkbox" checked={triage.showFormativeDefault} onChange={(e) => save({ showFormativeDefault: e.target.checked })} />
          <span>Show formative work in Feedback owed by default</span>
        </label>
        {status && <p className="text-sm text-muted" role="status">{status}</p>}
      </section>

      <section className="card settings-section" id="grade-scale" aria-labelledby="grade-scale-title">
        <h3 id="grade-scale-title">Grade scale</h3>
        <p className="text-sm text-muted">
          HKIS's letter grade for each combination of reporting category levels, and the score band of each level.
          For checking that Prism's grades and levels match HKIS and Schoology.
        </p>
        <GradeScaleChart />
      </section>

      <section className="card settings-section">
        <h3>School calendar</h3>
        {!calendar && <p className="text-sm text-muted">Loading…</p>}
        {calendar?.source === 'powerschool' && (
          <p>PowerSchool · {calendar.totalSchoolDays} school days{calendar.syncedAt ? ` · synced ${formatDateTime(calendar.syncedAt)}` : ''}</p>
        )}
        {calendar && calendar.source !== 'powerschool' && (
          <div className="alert alert-warning">
            No school calendar yet, so Prism is counting weekdays (approximate). Press Sync Courses on the dashboard to load it.
          </div>
        )}
      </section>

      {schedule && scheduleStatus && (
        <ScheduledSyncCard schedule={schedule} status={scheduleStatus} message={scheduleMsg} onSave={saveSchedule} />
      )}

      <SchoologyConnectionCard />

      <RecentSyncs />
    </div>
  );
}
