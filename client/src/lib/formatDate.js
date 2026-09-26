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
