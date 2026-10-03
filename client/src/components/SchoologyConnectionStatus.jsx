import { useCallback, useEffect, useRef, useState } from 'react';
import { getMasteryLoginStatus } from '../services/api.js';

// The saved Schoology browser session (mastery sync, OneDrive links, the Ask modal's
// unsubmit): is it still live? GET /api/mastery/login-status does one cheap
// authenticated check on the server, cached ~10 minutes; refresh() forces a re-check.
// Shared by the Settings "Schoology connection" card, the Sync dialog and the Ask
// confirm (StatusLineModal). `enabled: false` → no request at all.
//
// status: { loggedIn, live: 'connected' | 'expired' | 'unknown' | 'none' | null, checkedAt, message? }
// 'unknown' = the check couldn't tell (Schoology unreachable, browser failed) — not expired.
export function useSchoologyConnection({ enabled = true } = {}) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);
  const seq = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const mine = (seq.current += 1);
    setLoading(true);
    try {
      const s = await getMasteryLoginStatus({ refresh });
      if (mine !== seq.current) return;
      setStatus(s ?? null);
      setError(null);
    } catch (err) {
      if (mine === seq.current) setError(err.message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) load(false);
    return () => { seq.current += 1; }; // a late answer after unmount is dropped
  }, [enabled, load]);

  return { status, loading, error, refresh: () => load(true) };
}

// 'connected' | 'expired' | 'unknown' | 'none' | null (still checking / never checked).
export const connectionState = (status) => status?.live ?? (status && status.loggedIn === false ? 'none' : null);

const hhmm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
};

// One status line + a "Check now" link. `connection` = useSchoologyConnection().
export default function SchoologyConnectionStatus({ connection, className = '' }) {
  const { status, loading, error, refresh } = connection;
  const state = connectionState(status);
  let text;
  let tone = 'muted';
  if (loading && !status) text = 'Checking the Schoology connection…';
  else if (error && !status) { text = `Could not check the Schoology connection: ${error}`; tone = 'warning'; }
  else if (state === 'connected') { text = `Connected${status.checkedAt ? ` · checked ${hhmm(status.checkedAt)}` : ''}`; tone = 'success'; }
  else if (state === 'expired') { text = 'Expired'; tone = 'warning'; }
  else if (state === 'none') { text = 'Not set up'; tone = 'warning'; }
  else if (state === 'unknown') { text = "Couldn't check — try again"; tone = 'muted'; }
  else text = 'Not checked yet';

  return (
    <span className={`schoology-connection ${className}`.trim()} role="status">
      <span className={`schoology-connection__dot schoology-connection__dot--${tone}`} aria-hidden="true" />
      <span className="schoology-connection__text" title={status?.message || undefined}>{text}</span>
      {state !== 'none' && (
        <button type="button" className="ghost btn-sm schoology-connection__check" disabled={loading} onClick={refresh}>
          {loading && status ? 'Checking…' : 'Check now'}
        </button>
      )}
    </span>
  );
}
