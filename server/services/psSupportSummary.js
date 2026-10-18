// A student's PowerSchool Student Support Summary (#163), read on demand: when the
// teacher opens "Show alerts" on the student page, or PrisMCP asks. Nothing is
// stored; an answer is kept in memory for 10 minutes. Only for a student whose
// last alert sync found the Support Summary alert, through one of their current
// courses: the attendance LTI launch, the section roster (dcid → studentid), then
// the pop-up the alert icon opens, requested the way its dialog requests it
// (powerschoolWeb.page). Probed 18/10/2026: .claude/powerschool-api-reference.md
// "Alert pop-ups". For the teacher only: never on a roster.
import { cookieJar, WebSessionError } from './schoologyWeb.js';
import { PowerSchoolWeb } from './powerschoolWeb.js';
import { parseSupportSummary } from '../lib/parseSupportSummary.js';

export const SUPPORT_SUMMARY_ALERT_ID = '11290981';
const STUB = 'mbapop_studentsupportsummary.html';
const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // studentId → { rows, readAt, at }

export class SupportSummaryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const clearSupportSummaryCache = () => cache.clear();

export async function readSupportSummary(db, studentId, { jar, fetchImpl = fetch, now = Date.now } = {}) {
  const hit = cache.get(studentId);
  if (hit && now() - hit.at <= TTL_MS) return { rows: hit.rows, readAt: hit.readAt };

  const student = db.prepare('SELECT id, school_uid FROM students WHERE id = ?').get(studentId);
  if (!student) throw new SupportSummaryError('NOT_FOUND', 'Student not found');
  const hasAlert = db.prepare(`SELECT 1 FROM student_ps_alerts WHERE student_id = ? AND alert_key = 'support_summary'`).get(studentId);
  if (!hasAlert) throw new SupportSummaryError('NO_ALERT', 'PowerSchool shows no Student Support Summary for this student');
  const dcid = String(student.school_uid || '').match(/^1_(\d+)$/)?.[1];
  if (!dcid) throw new SupportSummaryError('NOT_LINKED', 'This student is not linked to PowerSchool');
  const course = db.prepare(`
    SELECT c.schoology_section_id FROM enrolments e JOIN courses c ON c.id = e.course_id
    WHERE e.student_id = ? AND e.dropped_at IS NULL AND c.archived = 0 AND c.excluded = 0
    ORDER BY c.id LIMIT 1`).get(studentId);
  if (!course) throw new SupportSummaryError('NO_COURSE', 'The Support Summary is read through a current course, and this student has none');

  const ps = new PowerSchoolWeb({ sgyJar: jar ?? cookieJar(), fetchImpl });
  try {
    const { sectionDcid } = await ps.launch(course.schoology_section_id);
    const roster = await ps.read('/teachers/mba_alerts/queries/getStudentsInSection.json', { sectionIds: sectionDcid });
    const me = (Array.isArray(roster) ? roster : []).find((r) => r && String(r.studentdcid) === dcid);
    if (!me) throw new SupportSummaryError('NOT_ON_ROSTER', 'This student is not on the PowerSchool roster of their course');
    const query = new URLSearchParams({ url: STUB, frn: `001${dcid}`, id: SUPPORT_SUMMARY_ALERT_ID, studentid: String(me.studentid) });
    const html = await ps.page(`/teachers/alerts/aet_customalert_custompopup.html?${query}`);
    if (/Security Violation/i.test(html)) {
      console.error('[psSupportSummary] PowerSchool answered with a Security Violation page; stopped');
      throw new SupportSummaryError('SECURITY_VIOLATION', 'PowerSchool refused the read');
    }
    const rows = parseSupportSummary(html);
    const readAt = new Date(now()).toISOString();
    cache.set(studentId, { rows, readAt, at: now() });
    return { rows, readAt };
  } catch (err) {
    if (err instanceof SupportSummaryError) throw err;
    if (err instanceof WebSessionError && err.code === 'SESSION_EXPIRED') {
      throw new SupportSummaryError('SESSION_EXPIRED', 'The Schoology session has expired: log in to Schoology in Settings');
    }
    throw new SupportSummaryError('PS_FAILED', `Could not read PowerSchool: ${err.message}`);
  }
}
