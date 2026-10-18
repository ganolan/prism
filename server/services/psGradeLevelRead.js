/**
 * psGradeLevelRead.js — each section's students' PowerSchool grade level, over
 * plain HTTP on the attendance LTI session (server/services/powerschoolWeb.js),
 * no browser (#164).
 *
 * Per section:
 *   1. GET /ws/attendance/section_info → psmSectionId (and the calendar the
 *      fallback needs). The block sync already holds it, and passes it in.
 *   2. GET /ws/pt/v1/section/{psmSectionId}/students_integration → every
 *      student's gradeLevel in one call with no date (Accept: application/json).
 *      The list's id is a PSM id, so the join to the dcid goes through photoURL
 *      (/teachers/stpnormal/{studentid}ph.jpeg) and
 *   3. GET getStudentsInSection.json → studentid → studentdcid (Prism school_uid
 *      is '1_' + dcid).
 *   Fallback, when the list read fails or joins no student: the old read,
 *   GET /ws/attendance/section_attendance over ~15 in-session days (a section is
 *   listed only on days it meets), deduped per dcid.
 *
 * Read only. The same list carries gender; Prism stores nothing from it.
 * See .claude/powerschool-api-reference.md "Grade level from the section student
 * list (#164)".
 */
import { pickInSessionRange, extractGradeLevels, extractStudentListGradeLevels } from '../lib/psGradeLevel.js';
import { loopTimeBudgetExceeded } from '../lib/psBlockNumber.js';

const JSON_ONLY = { method: 'GET', accept: 'application/json' };
const ROSTER = '/teachers/mba_alerts/queries/getStudentsInSection.json';
const TIME_BUDGET_MS = 2 * 60 * 1000;

export async function readSectionInfo(ps, sectionDcid, today) {
  const info = await ps.read('/ws/attendance/section_info', {
    sectionDcid, multiSections: 'false', startDate: today, endDate: today,
  }, JSON_ONLY);
  return (Array.isArray(info) ? info[0] : info) || null;
}

// The new read: the section student list, joined to dcids through the roster.
export async function readStudentListGrades(ps, { sectionDcid, psmSectionId }) {
  const list = await ps.read(`/ws/pt/v1/section/${encodeURIComponent(psmSectionId)}/students_integration`, {}, JSON_ONLY);
  const roster = await ps.read(ROSTER, { sectionIds: sectionDcid }, { method: 'GET' });
  return extractStudentListGradeLevels(list, roster);
}

// The old read: section_attendance over an in-session range, deduped per dcid.
export async function readAttendanceGrades(ps, { sectionDcid, userDcid, sectionInfo, today }) {
  if (!userDcid) throw new Error('no userDcid for section_attendance');
  const range = pickInSessionRange(sectionInfo, today);
  if (!range) throw new Error('no in-session days for section_attendance');
  const sa = await ps.read('/ws/attendance/section_attendance', {
    sectionDcid, userDcid, startDate: range.startDate, endDate: range.endDate,
    includeStudentAlerts: 'false', multiSections: 'false', sortByFirstName: 'false',
  }, JSON_ONLY);
  const byDcid = new Map(extractGradeLevels(sa).map(({ dcid, gradeLevel }) => [dcid, gradeLevel]));
  return [...byDcid].map(([dcid, gradeLevel]) => ({ dcid, gradeLevel }));
}

/**
 * One section's grade levels. → { source: 'students_integration' |
 * 'section_attendance', grades: [{ dcid, gradeLevel }], sectionInfo,
 * fallbackReason? }. Throws when both reads fail (the caller keeps the
 * section's stored grades).
 */
export async function readSectionGradeLevels(ps, { sectionDcid, userDcid, sectionInfo, today }) {
  const info = sectionInfo ?? await readSectionInfo(ps, sectionDcid, today);
  let fallbackReason;
  try {
    if (!info?.psmSectionId) throw new Error('no psmSectionId');
    const read = await readStudentListGrades(ps, { sectionDcid, psmSectionId: info.psmSectionId });
    if (read.grades.length) return { source: 'students_integration', grades: read.grades, sectionInfo: info };
    throw new Error(`the student list joined no student (${read.listed} listed)`);
  } catch (err) {
    fallbackReason = err.message;
  }
  const grades = await readAttendanceGrades(ps, { sectionDcid, userDcid, sectionInfo: info, today });
  return { source: 'section_attendance', grades, sectionInfo: info, fallbackReason };
}

/**
 * Every section's grade levels on one PowerSchool session. Best-effort: never
 * throws. A section whose reads fail is counted and skipped; a session that
 * ends mid-pass (PS_SESSION) is started again once for that section.
 *
 * sections: [{ name, schoologySectionId, sectionDcid, userDcid, sectionInfo? }]
 * → { gradeByDcid: Map<dcid, gradeLevel>, sources: { students_integration,
 *     section_attendance, failed }, error? }
 */
export async function readGradeLevels({ ps, sections, today, log = () => {}, timeBudgetMs = TIME_BUDGET_MS }) {
  const out = { gradeByDcid: new Map(), sources: { students_integration: 0, section_attendance: 0, failed: 0 } };
  const startedAt = Date.now();
  for (const sec of sections) {
    if (!sec.sectionDcid) continue;
    if (loopTimeBudgetExceeded(startedAt, timeBudgetMs)) {
      log(`Grade levels: time budget (${timeBudgetMs / 1000}s) exceeded, the rest wait for the next sync.`);
      break;
    }
    try {
      if (!ps.launched) await ps.launch(sec.schoologySectionId);
    } catch (err) {
      out.error = `PowerSchool session not started: ${err.message}`;
      log(`Grade levels: ${out.error}`);
      return out;
    }
    const args = { sectionDcid: sec.sectionDcid, userDcid: sec.userDcid, sectionInfo: sec.sectionInfo, today };
    try {
      let r;
      try {
        r = await readSectionGradeLevels(ps, args);
      } catch (err) {
        if (err.code !== 'PS_SESSION') throw err;
        await ps.launch(sec.schoologySectionId);
        r = await readSectionGradeLevels(ps, args);
      }
      for (const { dcid, gradeLevel } of r.grades) out.gradeByDcid.set(dcid, gradeLevel);
      out.sources[r.source]++;
      if (r.source !== 'students_integration') log(`${sec.name}: grade levels from section_attendance (${r.fallbackReason})`);
    } catch (err) {
      out.sources.failed++;
      log(`${sec.name}: grade-level read failed (${err.message}), kept the stored grades`);
    }
  }
  return out;
}
