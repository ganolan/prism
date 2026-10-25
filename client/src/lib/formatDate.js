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

// A sync time (SyncStatus, #198): 12-hour, "10:51 PM today", else "23/10/2026 at 10:51 PM".
// Built by hand: en-US puts a narrow no-break space before "PM" on newer ICU.
export function freshnessTime(iso, now = new Date()) {
  const d = toDate(iso);
  if (!d) return '';
  const time = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  return localIsoDate(d) === localIsoDate(now) ? `${time} today` : `${formatDate(d)} at ${time}`;
}
