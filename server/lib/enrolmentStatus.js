/**
 * enrolmentStatus.js — is a Schoology enrollment row still active? (issue #128)
 *
 * `GET /v1/sections/{id}/enrollments` does NOT drop a student who has left the
 * course. It keeps returning the row with a non-active `status`. Verified
 * 2026-08-13 by sweeping all 9 active HKIS sections (scripts/
 * probe-enrolment-status-sweep.js): 117 student rows, `status` was `"1"` for
 * 115 and `"5"` for exactly the 2 students who had dropped (Anant Sachdeva —
 * AP CSP block 7; Ho Kan Lai — AIML block 1). No row ever disappeared.
 *
 * Sync historically filtered only on `admin`, so those 2 were re-inserted on
 * every sync and could never leave the roster.
 *
 * Only `"1"` and `"5"` have been observed, so the rest of the enum is unknown.
 * We whitelist active rather than blacklist dropped: an unrecognised code then
 * lands a student in the roster's "dropped" group, where the count and the
 * show-dropped toggle make the misclassification visible and reversible. The
 * inverse (blacklisting) would hide a NEW drop code silently — which is the
 * bug being fixed. Nothing is deleted either way; `enrolments.status` keeps the
 * raw value so an unfamiliar code is diagnosable after the fact.
 */

/** Schoology `status` values known to mean "still in the course". */
export const ACTIVE_ENROLMENT_STATUSES = new Set(['1']);

/**
 * True when the enrollment should appear on the roster.
 *
 * A missing/null `status` is treated as ACTIVE — older cached payloads and any
 * caller that hands us a trimmed object must not cause a roster wipe. Only an
 * explicit, recognised-as-inactive value drops a student.
 */
export function isActiveEnrolment(enrollment) {
  if (!enrollment || typeof enrollment !== 'object') return false;
  const { status } = enrollment;
  if (status == null || status === '') return true;
  return ACTIVE_ENROLMENT_STATUSES.has(String(status));
}
