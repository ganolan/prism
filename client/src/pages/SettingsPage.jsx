import { useEffect, useState } from 'react';
import NumberStepper from '../components/NumberStepper.jsx';
import { getSettings, updateSettings, getTriage } from '../services/api.js';
import { formatDateTime } from '../lib/formatDate.js';

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

  if (!triage) return status ? <div className="error-msg">{status}</div> : <div className="loading">Loading...</div>;

  return (
    <div className="fade-in">
      <h2 className="page-title">Settings</h2>

      <section className="card settings-section">
        <h3>Triage</h3>
        <p className="text-sm text-muted">Counted in school days. Applies to the Dashboard, course pages and PrisMCP.</p>
        <div className="settings-row">
          <span>Refer late summative work at</span>
          <NumberStepper value={triage.referralLimitDays} min={1} max={60} onChange={(v) => save({ referralLimitDays: v })} aria-label="Referral limit (school days)" />
          <span className="text-sm text-muted">school days late</span>
        </div>
        <div className="settings-row">
          <span>Feedback is overdue after</span>
          <NumberStepper value={triage.feedbackLimitDays} min={1} max={60} onChange={(v) => save({ feedbackLimitDays: v })} aria-label="Feedback limit (school days)" />
          <span className="text-sm text-muted">school days waiting</span>
        </div>
        <div className="settings-row">
          <span>Amber warning starts</span>
          <NumberStepper value={triage.warnLeadDays} min={0} max={59} onChange={(v) => save({ warnLeadDays: v })} aria-label="Warning lead (school days)" />
          <span className="text-sm text-muted">school days before each limit</span>
        </div>
        <div className="settings-row">
          <span>Make-up tests turn amber</span>
          <NumberStepper value={triage.makeUpAmberDays} min={0} max={triage.makeUpRedDays} onChange={(v) => save({ makeUpAmberDays: v })} aria-label="Make-up amber (school days)" />
          <span className="text-sm text-muted">school days after the test (0 = on the day)</span>
        </div>
        <div className="settings-row">
          <span>…and red (sit by)</span>
          <NumberStepper value={triage.makeUpRedDays} min={1} max={30} onChange={(v) => save({ makeUpRedDays: v })} aria-label="Make-up red (school days)" />
          <span className="text-sm text-muted">school days after the test</span>
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
            No school calendar yet, so Prism is counting weekdays (approximate). Run a sync while signed in to PowerSchool to load it.
          </div>
        )}
      </section>
    </div>
  );
}
