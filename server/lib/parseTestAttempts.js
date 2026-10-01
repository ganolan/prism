/**
 * parseTestAttempts.js
 *
 * Pure parser for the gradebook's lazy column loader,
 * `GET /iapi/grades/grader_grade_data/{sectionId}/all?uids=…&grade_item_nids=…`
 * (browser-session auth). Response `{ body: { grades: { <uid>: { <gradeItemId>: cell } } } }`,
 * where the grade-item id is the public `assignment.id`. For a Schoology test:
 *   - `submission: "assessment"` → the student has an attempt (took it);
 *   - `has_assessment: true` and no submission → assigned, not taken;
 *   - `not_assigned: true` → the student is on the other copy (e.g. the `*` extra-time copy).
 * Verified 2026-10-02 (15/15 against the results page) — see
 * .claude/schoology-api-reference.md "Tests and quizzes > Did the student take the test?".
 *
 * Returns Map<uid, Map<gradeItemId, { took, notAssigned }>>, or null when the payload has no
 * grades object (a failed read must stay UNKNOWN, never "nobody took it").
 */

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export function parseTestAttempts(payload) {
  const grades = payload?.body?.grades;
  if (!isObject(grades)) return null;
  const out = new Map();
  for (const [uid, cells] of Object.entries(grades)) {
    if (!isObject(cells)) continue;
    const byItem = new Map();
    for (const [itemId, cell] of Object.entries(cells)) {
      if (!isObject(cell)) continue;
      byItem.set(String(itemId), { took: cell.submission === 'assessment', notAssigned: !!cell.not_assigned });
    }
    out.set(String(uid), byItem);
  }
  return out;
}
