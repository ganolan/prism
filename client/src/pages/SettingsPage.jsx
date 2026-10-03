import { useEffect, useState } from 'react';
import NumberStepper from '../components/NumberStepper.jsx';
import RecentSyncs from '../components/RecentSyncs.jsx';
import SchoologyConnectionStatus, { useSchoologyConnection } from '../components/SchoologyConnectionStatus.jsx';
import { getSettings, updateSettings, getTriage, triggerMasteryLogin } from '../services/api.js';
import { formatDateTime } from '../lib/formatDate.js';

// The saved Schoology browser session (mastery sync, OneDrive links, unsubmitting work on
// an Ask): its live status, a re-check, and the login window. The login opens on the
// server's screen, so the button says so. Anchor: /settings#schoology (the Ask modal's
// "reconnect in Settings" link).
function SchoologyConnectionCard() {
  const connection = useSchoologyConnection();
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginMsg, setLoginMsg] = useState(null);

  async function login() {
    setLoginBusy(true);
    setLoginMsg(null);
    try {
      await triggerMasteryLogin();
      setLoginMsg('Login saved.');
    } catch (err) {
      setLoginMsg(`Login did not complete: ${err.message}`);
    } finally {
      setLoginBusy(false);
      connection.refresh();
    }
  }

  return (
    <section className="card settings-section" id="schoology" aria-labelledby="schoology-connection-title">
      <h3 id="schoology-connection-title">Schoology connection</h3>
      <p className="text-sm text-muted">
        Prism&apos;s saved Schoology login — used for mastery sync, OneDrive links and unsubmitting work when you ask for a resubmission.
      </p>
      <div className="settings-row">
        <SchoologyConnectionStatus connection={connection} />
      </div>
      <div className="settings-row">
        <button type="button" className="secondary" onClick={login} disabled={loginBusy}>
          {loginBusy ? 'Waiting for login…' : 'Log in to Schoology'}
        </button>
        <span className="text-sm text-muted">Opens a Schoology login window on the server — screen-share to it if you&apos;re away.</span>
      </div>
      {loginMsg && <p className="text-sm text-muted" role="status">{loginMsg}</p>}
    </section>
  );
}

// App settings, stored server-side (shared by every device and PrisMCP).
export default function SettingsPage() {
  const [triage, setTriage] = useState(null);
  const [calendar, setCalendar] = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    getSettings().then((s) => setTriage(s.triage)).catch((err) => setStatus(`Could not load settings: ${err.message}`));
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
          Counted in school days, numbered from the due date (or test date) as day 1. Applies to the Dashboard, course pages and PrisMCP.
        </p>
        <div className="settings-row">
          <span>Late work is allowed through day</span>
          <NumberStepper value={triage.referralLimitDays} min={1} max={60} onChange={(v) => save({ referralLimitDays: v })} aria-label="Referral limit (last allowed day)" />
          <span className="text-sm text-muted">(due date = day 1); refer after day {triage.referralLimitDays}</span>
        </div>
        <div className="settings-row">
          <span>Feedback is overdue after day</span>
          <NumberStepper value={triage.feedbackLimitDays} min={1} max={60} onChange={(v) => save({ feedbackLimitDays: v })} aria-label="Feedback limit (last allowed day)" />
        </div>
        <div className="settings-row">
          <span>Amber warning covers the last</span>
          <NumberStepper value={triage.warnLeadDays} min={0} max={59} onChange={(v) => save({ warnLeadDays: v })} aria-label="Warning lead (school days)" />
          <span>allowed days</span>
        </div>
        <div className="settings-row">
          <span>Make-up tests turn amber on day</span>
          <NumberStepper value={triage.makeUpAmberDay} min={1} max={triage.makeUpRedDay} onChange={(v) => save({ makeUpAmberDay: v })} aria-label="Make-up amber (day)" />
          <span>and red on day</span>
          <NumberStepper value={triage.makeUpRedDay} min={2} max={31} onChange={(v) => save({ makeUpRedDay: v })} aria-label="Make-up red (day)" />
          <span className="text-sm text-muted">(test day = day 1)</span>
        </div>
        <div className="settings-row">
          <span>Resubmission deadline (default)</span>
          <NumberStepper value={triage.resubmitLessonsDefault} min={1} max={60} onChange={(v) => save({ resubmitLessonsDefault: v })} aria-label="Resubmission deadline (lessons)" />
          <span className="text-sm text-muted">lessons after asking</span>
        </div>
        <label className="settings-row">
          <input type="checkbox" checked={triage.showFormativeDefault} onChange={(e) => save({ showFormativeDefault: e.target.checked })} />
          <span>Show formative work in Feedback owed by default</span>
        </label>
        {status && <p className="text-sm text-muted" role="status">{status}</p>}
      </section>

      <section className="card settings-section">
        <h3>School calendar</h3>
        {!calendar && <p className="text-sm text-muted">Loading…</p>}
        {calendar?.source === 'powerschool' && (
          <p>PowerSchool · {calendar.totalSchoolDays} school days{calendar.syncedAt ? ` · synced ${formatDateTime(calendar.syncedAt)}` : ''}</p>
        )}
        {calendar && calendar.source !== 'powerschool' && (
          <div className="alert alert-warning">
            No school calendar yet, so Prism is counting weekdays (approximate). Run a sync with "Sync from PowerSchool" ticked to load it.
          </div>
        )}
      </section>

      <SchoologyConnectionCard />

      <RecentSyncs />
    </div>
  );
}
