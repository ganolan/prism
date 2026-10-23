// Patches a grade card applies to its student row after a save. Shared by the card and the
// assessment page's Send-all.

// The card's patch after a grade cleared a marker (#40): the save routes return flagCleared
// ({ exception: 0, comment?, status_line?: null }) once Schoology took the grade over Late,
// Incomplete or Absent and Prism removed the flag's status line. Absent → nothing to patch.
export function flagClearedPatch(cleared) {
  if (!cleared) return {};
  return {
    exception: 0,
    ...(typeof cleared.comment === 'string' ? { grade_comment: cleared.comment } : {}),
    ...('status_line' in cleared ? { status_line: null } : {}),
  };
}

// A published grade (a score, or levels) makes a waiting saved copy stale: the server retires it
// (mastery.js retireCopy), so the card drops its restore offer without a reload (#40, 22 Oct 2026).
export const GRADE_WRITTEN_PATCH = { saved_grade: null };

// The card's resubmission fields after a save (final review I2): the save routes
// return the pair's post-save state (resubmissionFields — what the server decided
// after snapshotting the save and settling an answered request), so patch exactly
// that. A hidden-only, unchanged or received-line-only save keeps an arrival
// Arrived. Unknown (null/absent — the server could not read it) → leave the card's
// fields alone rather than guess.
export function resubmissionFieldsPatch(fields) {
  if (!fields) return {};
  return {
    resubmission: fields.resubmission ?? null,
    resubmit_flag: fields.resubmit_flag ?? null,
    resubmitted: Boolean(fields.resubmitted),
    arrived_on: fields.arrived_on ?? null,
  };
}
