// A student's PowerSchool Student Support Summary (#163), read on demand: when the
// teacher opens a learning alert's detail (the roster or student page, through psAlertDetail.js), or PrisMCP asks. Nothing is
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

// The pop-up link the MBA custom-alerts plugin builds for an alert (`api.makeAlert`), full form:
// the stub, the student's dcid and the alert id; an `sf` alert adds its student field and table,
// an `adv` alert its querystring and the PowerSchool studentid. `bare` leaves the extras off (what
// #163 first sent). `def` is a getAlertTypes.json entry. Shapes: .claude/powerschool-api-reference.md
// "Alert pop-up shapes, all kept alerts".
export function popupLink(def, dcid, studentid, bare = false) {
  const p = new URLSearchParams({ url: def.stub_url, frn: `001${dcid}`, id: String(def.id) });
  let out = `/teachers/alerts/aet_customalert_custompopup.html?${p}`;
  if (bare) return out;
  if (def.trigger_type === 'sf') {
    const field = String(def.student_field).includes('.') ? `${def.ext_table_name}.${String(def.student_field).split('.')[1]}` : def.student_field;
    const sf = new URLSearchParams({ mba_frn: `001${dcid}`, student_field: field });
    if (def.ext_table_name) sf.set('tableName', def.ext_table_name);
    out += `&${sf}`;
  }
  if (def.trigger_type === 'adv') {
    if (def.querystring) out += `&${def.querystring}`;
    out += `&${new URLSearchParams({ studentid })}`;
  }
  return out;
}

// Open one alert's pop-up for one student, as the alert icon's dialog does. Checks the student holds
// the alert (`alertKey`, refused before any request otherwise), launches through one of their current
// courses, finds them on that section's roster, then asks `linkFor(ps, { dcid, studentid })` for the
// pop-up path (it may read PowerSchool first; null = nothing to read) and GETs it.
// → the page's HTML, or null when `linkFor` gave no path. Throws SupportSummaryError.
export async function readAlertPopup(db, studentId, alertKey, { jar, fetchImpl = fetch } = {}, linkFor, { name = 'alert pop-up', noCourse = `The ${name} is read through a current course, and this student has none` } = {}) {
  const student = db.prepare('SELECT id, school_uid FROM students WHERE id = ?').get(studentId);
  if (!student) throw new SupportSummaryError('NOT_FOUND', 'Student not found');
  const hasAlert = db.prepare('SELECT 1 FROM student_ps_alerts WHERE student_id = ? AND alert_key = ?').get(studentId, alertKey);
  if (!hasAlert) throw new SupportSummaryError('NO_ALERT', `PowerSchool shows no ${name} for this student`);
  const dcid = String(student.school_uid || '').match(/^1_(\d+)$/)?.[1];
  if (!dcid) throw new SupportSummaryError('NOT_LINKED', 'This student is not linked to PowerSchool');
  const course = db.prepare(`
    SELECT c.schoology_section_id FROM enrolments e JOIN courses c ON c.id = e.course_id
    WHERE e.student_id = ? AND e.dropped_at IS NULL AND c.archived = 0 AND c.excluded = 0
    ORDER BY c.id LIMIT 1`).get(studentId);
  if (!course) throw new SupportSummaryError('NO_COURSE', noCourse);

  const ps = new PowerSchoolWeb({ sgyJar: jar ?? cookieJar(), fetchImpl });
  try {
    const { sectionDcid } = await ps.launch(course.schoology_section_id);
    const roster = await ps.read('/teachers/mba_alerts/queries/getStudentsInSection.json', { sectionIds: sectionDcid });
    const me = (Array.isArray(roster) ? roster : []).find((r) => r && String(r.studentdcid) === dcid);
    if (!me) throw new SupportSummaryError('NOT_ON_ROSTER', 'This student is not on the PowerSchool roster of their course');
    const link = await linkFor(ps, { dcid, studentid: String(me.studentid) });
    if (!link) return null;
    const html = await ps.page(link);
    if (/Security Violation/i.test(html)) {
      console.error('[psSupportSummary] PowerSchool answered with a Security Violation page; stopped');
      throw new SupportSummaryError('SECURITY_VIOLATION', 'PowerSchool refused the read');
    }
    return html;
  } catch (err) {
    if (err instanceof SupportSummaryError) throw err;
    if (err instanceof WebSessionError && err.code === 'PS_SECURITY') { // powerschoolWeb saw the page first
      console.error('[psSupportSummary] PowerSchool answered with a Security Violation page; stopped');
      throw new SupportSummaryError('SECURITY_VIOLATION', 'PowerSchool refused the read');
    }
    if (err instanceof WebSessionError && err.code === 'SESSION_EXPIRED') {
      throw new SupportSummaryError('SESSION_EXPIRED', 'The Schoology session has expired: log in to Schoology in Settings');
    }
    throw new SupportSummaryError('PS_FAILED', `Could not read PowerSchool: ${err.message}`);
  }
}

export async function readSupportSummary(db, studentId, deps = {}) {
  const { now = Date.now } = deps;
  const hit = cache.get(studentId);
  if (hit && now() - hit.at <= TTL_MS) return { rows: hit.rows, readAt: hit.readAt };

  const query = (dcid, studentid) => new URLSearchParams({ url: STUB, frn: `001${dcid}`, id: SUPPORT_SUMMARY_ALERT_ID, studentid });
  const html = await readAlertPopup(db, studentId, 'support_summary', deps,
    (ps, { dcid, studentid }) => `/teachers/alerts/aet_customalert_custompopup.html?${query(dcid, studentid)}`,
    { name: 'Student Support Summary', noCourse: 'The Support Summary is read through a current course, and this student has none' });
  const rows = parseSupportSummary(html);
  const readAt = new Date(now()).toISOString();
  cache.set(studentId, { rows, readAt, at: now() });
  return { rows, readAt };
}
