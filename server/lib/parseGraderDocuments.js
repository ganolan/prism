/**
 * parseGraderDocuments.js
 *
 * Pure parser for Schoology's per-assignment grader document lists
 * (`GET /iapi2/assignments/{aid}/submitted-documents/` and
 * `/in-progress-documents/`, browser-session auth). Each returns
 * `{ data: [ { id (=schoology uid), revisionCreated (bool), … } ] }`.
 *
 * Produces the true per-student submission state for lti_submission work — the
 * only surface that distinguishes "opened, in progress" (revisionCreated:true)
 * from "never opened" (revisionCreated:false). See schoology-api-reference.md
 * (2026-06-07 RESOLVED note) and issue #62.
 */

function rows(payload) {
  const data = payload?.data;
  return Array.isArray(data) ? data : [];
}

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Schoology's grader `submissionDate` display string, e.g.
// "Tuesday, June 9, 2026 at 3:27 pm". Day/hour are NOT zero-padded; minute IS
// 2-digit; lowercase am/pm; no seconds; NO timezone (#125 probe, 2026-06-15).
const DATE_RE = /^[A-Za-z]+,\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([ap])m$/i;

/**
 * Parse a grader `submissionDate` string to epoch SECONDS, or null if absent/
 * unparseable. The string carries no timezone, so it is interpreted in the
 * server's LOCAL timezone (`new Date(y, m, d, h, min)`). Prism is local-first
 * and runs on the teacher's HKIS (HKT) host, so local == Schoology's display
 * tz — the resulting epoch matches the time shown next to "Open" in the grader.
 * Running Prism on a non-HKT host would offset LTI submission times. (#125)
 * @param {string|null|undefined} str
 * @returns {number|null} epoch seconds
 */
export function parseSubmissionDate(str) {
  if (typeof str !== 'string') return null;
  const m = DATE_RE.exec(str.trim());
  if (!m) return null;
  const monthIndex = MONTHS[m[1].toLowerCase()];
  if (monthIndex == null) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = Number(m[4]) % 12;             // 12 → 0 for am; pm adds 12 below
  if (m[6].toLowerCase() === 'p') hour += 12;
  const minute = Number(m[5]);
  const d = new Date(year, monthIndex, day, hour, minute);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

/**
 * Per-uid submission detail from the SUBMITTED-documents payload only (the
 * in-progress payload has no date/timing): the parsed submission time + the
 * decoded late flag. `submissionTiming` is a 3-value enum (#125 probe):
 * 0 = none, 1 = on-time, 2 = late — so `late = (timing === 2)`.
 * @param {object|null} submittedPayload
 * @returns {Map<string, { submittedAt: number|null, late: 0|1 }>} keyed by string uid
 */
export function buildSubmissionDetailMap(submittedPayload) {
  const map = new Map();
  for (const r of rows(submittedPayload)) {
    if (r?.id == null) continue;
    map.set(String(r.id), {
      submittedAt: parseSubmissionDate(r.submissionDate),
      late: Number(r.submissionTiming) === 2 ? 1 : 0,
    });
  }
  return map;
}

/**
 * @param {object|null} submittedPayload   submitted-documents response
 * @param {object|null} inProgressPayload  in-progress-documents response
 * @returns {Map<string, 'submitted'|'in_progress'|'not_started'>} keyed by string uid
 */
export function buildSubmissionStateMap(submittedPayload, inProgressPayload) {
  const map = new Map();
  for (const r of rows(inProgressPayload)) {
    if (r?.id == null) continue;
    map.set(String(r.id), r.revisionCreated ? 'in_progress' : 'not_started');
  }
  // submitted overrides in-progress for the same uid.
  for (const r of rows(submittedPayload)) {
    if (r?.id == null) continue;
    map.set(String(r.id), 'submitted');
  }
  return map;
}
