// The Roster tab's private vitals and filters (#160): unread comment counts, the alert chips' short
// labels, and the filter pills built from them. Callers pass enrolled students only, so a dropped
// student is never counted or matched.
//
// Filter keys: LEARNING_PLAN (any learning alert: they share one pill), an alert key for every other
// roster alert (health, other; family alerts never reach a roster, `forRoster`), and UNREAD.
import { forRoster } from './psAlerts.js';

export const LEARNING_PLAN = 'learning';
export const UNREAD = 'unread';
const FIXED_LABELS = { [LEARNING_PLAN]: 'Learning plan', [UNREAD]: 'Unread comments' };
const CATEGORY_ORDER = { health: 0, other: 1 };

// The course's comment summaries ({ [schoology aid]: { [student id]: summary } }) → { [student id]: unread }.
export function unreadCounts(assignments) {
  const out = {};
  for (const byStudent of Object.values(assignments || {})) {
    for (const [sid, summary] of Object.entries(byStudent || {})) {
      out[sid] = (out[sid] || 0) + (summary?.unread || 0);
    }
  }
  return out;
}

// The short label an alert chip shows; the full name is in the pop-up and the chip's title.
const SHORT = { accommodation_plan: 'Plan', learning_support_1: 'LS 1', learning_support_2: 'LS 2', learning_support_3: 'LS 3' };
export const alertChipLabel = (alert) => SHORT[alert.key] || alert.label;

// The filter keys one student matches.
function keysOf(student, unread) {
  const keys = new Set();
  for (const a of forRoster(student.ps_alerts)) keys.add(a.category === 'learning' ? LEARNING_PLAN : a.key);
  if (unread?.[student.id] > 0) keys.add(UNREAD);
  return keys;
}

// → { alerts: [{ key, label, count }], followUp: [...], alertStudents, followUpStudents }.
// A pill is listed while some student matches it, or while it is on (`selected`; `labels` names an
// alert pill nobody holds any more). Alerts: Learning plan first, then health, then other, by label.
// `unread` null (comments unavailable) lists no Unread comments pill.
export function rosterFilterOptions(students, unread, selected = new Set(), labels = {}) {
  const alerts = new Map(); // key → { key, label, count, rank }
  let alertStudents = 0;
  let followUpStudents = 0;
  for (const s of students) {
    const roster = forRoster(s.ps_alerts);
    if (roster.length) alertStudents += 1;
    const counted = new Set();
    for (const a of roster) {
      const key = a.category === 'learning' ? LEARNING_PLAN : a.key;
      if (!alerts.has(key)) alerts.set(key, { key, label: FIXED_LABELS[key] || a.label, count: 0, rank: key === LEARNING_PLAN ? -1 : CATEGORY_ORDER[a.category] ?? 2 });
      if (!counted.has(key)) { alerts.get(key).count += 1; counted.add(key); }
    }
    if (unread?.[s.id] > 0) followUpStudents += 1;
  }
  for (const key of selected) {
    if (key === UNREAD || alerts.has(key)) continue;
    alerts.set(key, { key, label: FIXED_LABELS[key] || labels[key] || key, count: 0, rank: key === LEARNING_PLAN ? -1 : 3 });
  }
  const followUp = followUpStudents > 0 || selected.has(UNREAD)
    ? [{ key: UNREAD, label: FIXED_LABELS[UNREAD], count: followUpStudents }] : [];
  return {
    alerts: [...alerts.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)).map(({ key, label, count }) => ({ key, label, count })),
    followUp,
    alertStudents,
    followUpStudents,
  };
}

// The students who match any selected pill; everyone when none is selected.
export function applyRosterFilters(students, selected, unread = null) {
  if (!selected?.size) return students;
  return students.filter((s) => [...keysOf(s, unread)].some((k) => selected.has(k)));
}
