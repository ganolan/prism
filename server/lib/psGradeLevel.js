/**
 * psGradeLevel.js — pure helpers for syncing per-student grade level from
 * PowerSchool's attendance app (issue #43). gradeLevel (9–12) is read from
 * /ws/attendance/section_attendance and joined to Prism students by
 * school_uid === '1_' + dcid. Prism stores the INVARIANT grad_year (not the
 * raw grade) and derives the displayed grade on read.
 *
 * See .claude/powerschool-api-reference.md "Deriving grade / graduating year".
 */

/**
 * The school year is named by its ENDING calendar year, rolling over in August.
 * e.g. 2025-26 → 2026. August = month index 7.
 */
export function currentSchoolYearEndYear(now = new Date()) {
  return now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
}

/**
 * Derive the invariant grad_year from a current grade level.
 * grad_year = schoolYearEndYear + (12 − gradeLevel).
 * Returns null when gradeLevel is not an integer (guards against string coercion).
 */
export function gradeLevelToGradYear(gradeLevel, schoolYearEndYear) {
  if (!Number.isInteger(gradeLevel)) return null;
  return schoolYearEndYear + (12 - gradeLevel);
}

/**
 * Pick the date to query section_attendance for: the most recent in-session day
 * on or before `today` (ISO YYYY-MM-DD string); if none exist yet, the earliest
 * future in-session day; else null.
 *
 * `sectionInfo` is section_info[0]; its calendar lives under `calenderDays`
 * (PowerSchool's spelling) or `calendarDays`, each value carrying an `inSession`
 * boolean. ISO dates sort lexicographically so plain string comparison is safe.
 */
export function pickInSessionDate(sectionInfo, today) {
  const cal = sectionInfo?.calenderDays || sectionInfo?.calendarDays || {};
  const inSession = Object.entries(cal)
    .filter(([, d]) => d && d.inSession)
    .map(([date]) => date)
    .sort();
  if (inSession.length === 0) return null;
  const past = inSession.filter((d) => d <= today);
  return past.length ? past[past.length - 1] : inSession[0];
}

/**
 * Extract [{ dcid, gradeLevel }] from a section_attendance response. The roster
 * is sectionAttendances[].studentAttendance[]; each entry carries dcid + gradeLevel.
 * dcid is normalised to a string for the '1_' + dcid join. Entries without an
 * integer gradeLevel are skipped.
 */
export function extractGradeLevels(sectionAttendanceJson) {
  const out = [];
  for (const sec of sectionAttendanceJson?.sectionAttendances || []) {
    for (const sa of sec?.studentAttendance || []) {
      if (sa && sa.dcid != null && Number.isInteger(sa.gradeLevel)) {
        out.push({ dcid: String(sa.dcid), gradeLevel: sa.gradeLevel });
      }
    }
  }
  return out;
}

/**
 * Extract the teacher userDcid from the LTI launch-form HTML (hidden input
 * custom_userdcid, e.g. "2_10405"), stripping the realm prefix. Returns null
 * when the input is absent or its value is empty.
 *
 * NOTE: this value need NOT match section_attendance's own userDcid (the live
 * grid used 10005, not the form's 10405). PowerSchool resolves the real user
 * from the session and the param only scopes "attendance taken by", so a
 * plausible value suffices and the roster returns regardless. See
 * .claude/powerschool-api-reference.md ("userDcid" caveat).
 */
export function userDcidFromLaunchForm(html) {
  if (!html || typeof html !== 'string') return null;
  const m = html.match(/name=["']custom_userdcid["'][^>]*?value=["']([^"']*)["']/i)
    || html.match(/value=["']([^"']*)["'][^>]*?name=["']custom_userdcid["']/i);
  if (!m) return null;
  const v = m[1].trim();
  if (!v) return null;
  return v.includes('_') ? v.split('_').pop() : v;
}
