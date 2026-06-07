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
