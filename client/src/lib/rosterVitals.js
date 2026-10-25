// The Roster tab's private vitals and filters (#160): unread comment counts, the alert chips' short
// labels, and the filter pills built from them. Callers pass enrolled students only, so a dropped
// student is never counted or matched.
//
// Filter keys: LEARNING_PLAN (any learning alert: they share one pill), an alert key for every other
// roster alert (health, other; family alerts never reach a roster, `forRoster`), UNREAD, and
// `gender:F`, `gender:M`, `gender:NB`, `gender:none` (25 Oct 2026; none = blank or missing). Alerts and Follow up pills combine as "any of"; the Gender row narrows that (AND).
import { forRoster } from './psAlerts.js';
import { genderOf, GENDER_TAGS } from './genderTag.js';

export const LEARNING_PLAN = 'learning';
export const UNREAD = 'unread';
const FIXED_LABELS = { [LEARNING_PLAN]: 'Learning plan', [UNREAD]: 'Unread comments' };
const GENDER_PREFIX = 'gender:';
const GENDER_ORDER = Object.keys(GENDER_TAGS); // F, M, NB, none
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
  keys.add(GENDER_PREFIX + genderOf(student));
  return keys;
}

// → { alerts: [{ key, label, count }], followUp: [...], gender: [...], alertStudents, followUpStudents, genderStudents }.
// A pill is listed while some student matches it, or while it is on (`selected`; `labels` names an
// alert pill nobody holds any more). Alerts: Learning plan first, then health, then other, by label.
// `unread` null (comments unavailable) lists no Unread comments pill.
export function rosterFilterOptions(students, unread, selected = new Set(), labels = {}) {
  const alerts = new Map(); // key → { key, label, count, rank }
  let alertStudents = 0;
  let followUpStudents = 0;
  const genders = { F: 0, M: 0, NB: 0, none: 0 };
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
    genders[genderOf(s)] += 1;
  }
  for (const key of selected) {
    if (key === UNREAD || key.startsWith(GENDER_PREFIX) || alerts.has(key)) continue;
    alerts.set(key, { key, label: FIXED_LABELS[key] || labels[key] || key, count: 0, rank: key === LEARNING_PLAN ? -1 : 3 });
  }
  const followUp = followUpStudents > 0 || selected.has(UNREAD)
    ? [{ key: UNREAD, label: FIXED_LABELS[UNREAD], count: followUpStudents }] : [];
  // F, M, NB, ?: listed while some student matches or the pill is on. The pill shows the code; `tip` is the full label.
  const gender = GENDER_ORDER
    .filter((g) => genders[g] > 0 || selected.has(GENDER_PREFIX + g))
    .map((g) => ({ key: GENDER_PREFIX + g, label: GENDER_TAGS[g].code, tip: GENDER_TAGS[g].label, count: genders[g] }));
  return {
    alerts: [...alerts.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)).map(({ key, label, count }) => ({ key, label, count })),
    followUp,
    gender,
    alertStudents,
    followUpStudents,
    genderStudents: students.length,
  };
}

// The students who match the selected pills; everyone when none is selected. Alerts and Follow up
// pills combine as "any of". Gender is an attribute, so its row narrows: a student must match any
// selected Gender pill (Female or Male) AND, when other pills are on, any of those.
export function applyRosterFilters(students, selected, unread = null) {
  if (!selected?.size) return students;
  const keys = [...selected];
  const genders = keys.filter((k) => k.startsWith(GENDER_PREFIX));
  const others = keys.filter((k) => !k.startsWith(GENDER_PREFIX));
  return students.filter((s) => {
    const mine = keysOf(s, unread);
    return (!genders.length || genders.some((k) => mine.has(k))) && (!others.length || others.some((k) => mine.has(k)));
  });
}
