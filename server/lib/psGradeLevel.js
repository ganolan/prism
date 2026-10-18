/**
 * psGradeLevel.js — pure helpers for syncing per-student grade level from
 * PowerSchool's attendance app (issue #43). gradeLevel (9–12) is read from the
 * section's student list, /ws/pt/v1/section/{psmSectionId}/students_integration
 * (#164: one call, no date), with /ws/attendance/section_attendance over a date
 * range as the fallback, and joined to Prism students by
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
 * Pick a date RANGE to query section_attendance for: up to `windowDays` in-session
 * days ending at the most recent in-session day on or before `today` (ISO
 * YYYY-MM-DD). A single day misses sections not meeting that day (A/B block
 * rotation), so we span a window — section_attendance returns a section's roster
 * for any day it met within the range (the caller dedupes per student). If the
 * year hasn't started (no in-session day <= today), span forward from the
 * earliest in-session day. Returns { startDate, endDate } or null when the
 * calendar has no in-session days. `sectionInfo` is section_info[0]; its calendar
 * is `calenderDays` (PowerSchool's spelling) or `calendarDays`.
 */
export function pickInSessionRange(sectionInfo, today, windowDays = 15) {
  const cal = sectionInfo?.calenderDays || sectionInfo?.calendarDays || {};
  const inSession = Object.entries(cal)
    .filter(([, d]) => d && d.inSession)
    .map(([date]) => date)
    .sort();
  if (inSession.length === 0) return null;
  const pastOrToday = inSession.filter((d) => d <= today);
  if (pastOrToday.length) {
    const endIdx = inSession.indexOf(pastOrToday[pastOrToday.length - 1]);
    const startIdx = Math.max(0, endIdx - (windowDays - 1));
    return { startDate: inSession[startIdx], endDate: inSession[endIdx] };
  }
  const endIdx = Math.min(inSession.length - 1, windowDays - 1);
  return { startDate: inSession[0], endDate: inSession[endIdx] };
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

/**
 * A grade level as an integer: integers pass, digit strings ("10", "09") are
 * parsed (students_integration sends gradeLevel as a string), anything else is
 * null.
 */
export function parseGradeLevel(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\s*\d{1,2}\s*$/.test(v)) return Number(v.trim());
  return null;
}

/**
 * The PowerSchool studentid in a students_integration photoURL
 * ("/teachers/stpnormal/{studentid}ph.jpeg"), or null. The list's own `id` is a
 * PSM id that matches neither the studentid nor the dcid, so the photo path is
 * the join (27/27 in the #116 probe).
 */
export function studentIdFromPhotoUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/(\d+)ph\.[a-z]+(?:[?#].*)?$/i);
  return m ? m[1] : null;
}

/**
 * Grade levels from a students_integration answer
 * ({ "student-list": { students: [{ id, gradeLevel, photoURL, … }] } }), joined
 * to the dcid through the section roster (getStudentsInSection.json:
 * [{ studentid, studentdcid }]). → { grades: [{ dcid, gradeLevel }], listed,
 * unjoined, noGrade }: listed = students in the list, unjoined = students with a
 * grade but no roster match, noGrade = students without an integer grade.
 * Gender is in the same list; Prism stores nothing from it (#164).
 */
export function extractStudentListGradeLevels(json, roster) {
  const students = json?.['student-list']?.students;
  const list = Array.isArray(students) ? students : [];
  const dcidByStudentId = new Map();
  for (const r of Array.isArray(roster) ? roster : []) {
    if (r && r.studentid != null && r.studentdcid != null) dcidByStudentId.set(String(r.studentid), String(r.studentdcid));
  }
  const out = { grades: [], listed: list.length, unjoined: 0, noGrade: 0 };
  for (const s of list) {
    const gradeLevel = parseGradeLevel(s?.gradeLevel);
    if (gradeLevel == null) { out.noGrade++; continue; }
    const dcid = dcidByStudentId.get(studentIdFromPhotoUrl(s?.photoURL));
    if (!dcid) { out.unjoined++; continue; }
    out.grades.push({ dcid, gradeLevel });
  }
  return out;
}
