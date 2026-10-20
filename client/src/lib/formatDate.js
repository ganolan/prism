// Dates are day-first (en-GB), never the browser's default, which renders US
// month-first on a US-locale machine. Accepts a Date or anything `new Date()`
// parses; a missing or bad value renders as ''.
const LOCALE = 'en-GB';

function toDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 06/09/2026 */
export function formatDate(value) {
  const d = toDate(value);
  return d ? d.toLocaleDateString(LOCALE) : '';
}

/** 06/09/2026, 17:40 */
export function formatDateTime(value) {
  const d = toDate(value);
  return d ? d.toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' }) : '';
}

/** 17:40:43 — a time of day, for log lines (the date shown elsewhere). */
export function formatTime(value) {
  const d = toDate(value);
  return d ? d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
}

/** 2026-10-03 — today's local calendar date as ISO (YYYY-MM-DD), for comparing with API dates. */
export function localIsoDate(value = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The "Synced" label (SyncStatus): "14:05 today", else "18/10/2026, 03:02".
export function freshnessTime(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (localIsoDate(d) === localIsoDate(now)) {
    return `${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })} today`;
  }
  return formatDateTime(d);
}
