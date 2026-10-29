// Taking attendance in Prism (#39): one lesson's marks read from PowerSchool and saved back, as PowerSchool's own
// attendance app (the Schoology Attendance page) reads and saves them. Proven live 29/10/2026 on AP CSP: re-saving,
// changing a mark (T, A) and a past lesson, each read back (.claude/powerschool-api-reference.md "Attendance: reading
// and marking (#39)").
//   read: GET /ws/attendance/section_info (the code catalog) and a one-day GET /ws/attendance/section_attendance
//         (each student's mark, readOnly for an office mark, and attendanceTakenBySectionId: a record per day saved).
//   save: POST /ws/attendance/section_attendance, a JSON array of section-days built from that read, every on-track
//         student's marks with the teacher's codes.
// Safety (quizWriteback.js's pattern): the save reads the lesson again and refuses when any mark differs from what
// the page was shown (the fingerprint); it refuses a change to an office mark or an unknown code; it writes, reads
// back and reports any mark that did not come back as sent. Nothing is stored in Prism.
import { createHash } from 'crypto';
import { cookieJar } from './schoologyWeb.js';
import { PowerSchoolWeb } from './powerschoolWeb.js';
import { studentFullName } from './studentNames.js';
import { loadClassTimes } from './schoolCalendar.js';

export class AttendanceError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map(); // schoology section id → { ps, ids, at }
export const clearAttendanceSessions = () => sessions.clear();

// A launched PowerSchool session for a section, kept 10 minutes so a read and its save share it.
async function session(sectionId, { makePs, fresh = false, now = Date.now() } = {}) {
  const hit = sessions.get(sectionId);
  if (hit && !fresh && now - hit.at < SESSION_TTL_MS) return hit;
  const ps = makePs ? makePs() : new PowerSchoolWeb({ sgyJar: cookieJar() });
  const ids = await ps.launchIds(sectionId);
  if (!ids.sectionDcid) throw new AttendanceError('NO_SECTION', 'This course has no PowerSchool section.');
  await ps.launch(sectionId, { form: ids.form });
  const entry = { ps, ids, at: now };
  sessions.set(sectionId, entry);
  return entry;
}

// A read on the section's session; a session that ended is started again once.
async function withSession(sectionId, opts, fn) {
  let s = await session(sectionId, opts);
  try {
    return await fn(s);
  } catch (err) {
    if (!err?.sessionEnded) throw err;
    s = await session(sectionId, { ...opts, fresh: true });
    return fn(s);
  }
}

const keyOf = (sa, st, m) => `${sa.sectionId}|${sa.periodId}|${st.studentId}|${m.intervalNumber}`;

// The marks' fingerprint: every on-track mark's code, comment and readOnly, in a fixed order.
export function fingerprint(sectionDays) {
  const lines = [];
  for (const sa of sectionDays) for (const st of sa.studentAttendance || []) {
    if (!st.onTrack) continue;
    for (const m of st.meetingAttendance || []) lines.push(`${keyOf(sa, st, m)}=${m.code ?? ''}|${m.comment ?? ''}|${m.readOnly ? 1 : 0}`);
  }
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex').slice(0, 16);
}

// The school's codes from section_info, in PowerSchool's order: [{ code, description }] ('' is Present).
export function catalog(info) {
  return [...(info?.attendanceCodes || [])]
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((c) => ({ code: c.attCode ?? '', description: c.descriptionTranslated || c.description || '' }));
}

// One lesson for the page. `nameOf(dcid)` → Prism's { id, name } for the student, or null.
export function lessonView(day, info, att, nameOf = () => null) {
  const sectionDays = [].concat(att?.sectionAttendances || []);
  const takenRecords = Object.values(att?.attendanceTakenBySectionId || {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  const sa = sectionDays[0] || null;
  const students = (sa?.studentAttendance || []).filter((st) => st.onTrack).map((st) => {
    const marks = st.meetingAttendance || [];
    const m = marks[0] || null;
    const prism = nameOf(String(st.dcid));
    return {
      ps_student_id: String(st.studentId),
      student_id: prism?.id ?? null,
      name: prism?.name || st.lastFirst || '',
      code: m ? (m.code ?? '') : null,
      comment: m?.comment || null,
      office: Boolean(m?.readOnly),
      markable: marks.length === 1, // one mark per student per lesson, as every lesson read so far (29/10/2026)
      sort: st.lastFirst || prism?.name || '',
    };
  }).sort((a, b) => a.sort.localeCompare(b.sort)).map(({ sort, ...st }) => st); // last name order, as rosters
  return {
    date: day,
    lesson: Boolean(sa),
    lessons: sectionDays.length,
    taken: takenRecords > 0,
    codes: catalog(info),
    students,
    fingerprint: fingerprint(sectionDays),
  };
}

function courseSection(db, courseId) {
  const c = db.prepare('SELECT id, schoology_section_id, archived, excluded FROM courses WHERE id = ?').get(courseId);
  if (!c) throw new AttendanceError('NOT_FOUND', 'No such course.');
  if (c.archived || c.excluded || !c.schoology_section_id) throw new AttendanceError('NOT_CURRENT', 'Attendance is taken only for a current course.');
  const linked = db.prepare('SELECT COUNT(*) AS n FROM linked_sections WHERE course_id = ?').get(c.id).n;
  if (linked) throw new AttendanceError('LINKED', 'This course joins linked sections; take attendance on Schoology for each section.');
  return String(c.schoology_section_id);
}

const prismNames = (db) => {
  const q = db.prepare('SELECT id, first_name, last_name, preferred_name, preferred_name_teacher FROM students WHERE school_uid = ?');
  return (dcid) => {
    const s = q.get(`1_${dcid}`);
    return s ? { id: s.id, name: studentFullName(s) } : null;
  };
};

async function readRaw(s, day) {
  const { ps, ids } = s;
  const info = await ps.read('/ws/attendance/section_info', { sectionDcid: ids.sectionDcid, multiSections: 'false', startDate: day, endDate: day }, { method: 'GET', accept: 'application/json' });
  const att = await ps.read('/ws/attendance/section_attendance', {
    sectionDcid: ids.sectionDcid, userDcid: ids.userDcid, startDate: day, endDate: day, includeStudentAlerts: 'false', multiSections: 'false',
  }, { method: 'GET', accept: 'application/json' });
  return { info: Array.isArray(info) ? info[0] : info, att };
}

const checkDay = (day) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new AttendanceError('BAD_VALUE', 'date must be YYYY-MM-DD');
};

export const MAX_DAYS_RANGE = 45;

/**
 * The calendar's lesson days (Graham, 29 Oct 2026: a month grid, each lesson marked taken or not): the class's lessons
 * from Prism's timetable (class_meetings, as GET /api/courses/:id/class-times), and for each one up to `today` a one-day
 * read of whether PowerSchool holds attendance for it (a range read answers no taken records). → [{ date, start, end,
 * taken: true | false | null }], null for a lesson after today or one PowerSchool has no lesson for.
 */
export async function lessonDays(db, courseId, from, to, { today, ...opts } = {}) {
  checkDay(from); checkDay(to);
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_DAYS_RANGE) throw new AttendanceError('BAD_VALUE', `A range is at most ${MAX_DAYS_RANGE} days.`);
  const sectionId = courseSection(db, courseId);
  const meetings = loadClassTimes(db, courseId, from, to);
  const past = meetings.filter((m) => m.date <= today);
  const taken = new Map();
  if (past.length) {
    await withSession(sectionId, opts, async (s) => {
      for (const m of past) {
        const att = await s.ps.read('/ws/attendance/section_attendance', {
          sectionDcid: s.ids.sectionDcid, userDcid: s.ids.userDcid, startDate: m.date, endDate: m.date, includeStudentAlerts: 'false', multiSections: 'false',
        }, { method: 'GET', accept: 'application/json' });
        const lesson = [].concat(att?.sectionAttendances || []).length > 0;
        const records = Object.values(att?.attendanceTakenBySectionId || {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
        taken.set(m.date, lesson ? records > 0 : null);
      }
    });
  }
  return meetings.map((m) => ({ date: m.date, start: m.start, end: m.end, taken: taken.has(m.date) ? taken.get(m.date) : null }));
}

/** One lesson's attendance for the Attendance tab. → lessonView. */
export async function readLesson(db, courseId, day, opts = {}) {
  checkDay(day);
  const sectionId = courseSection(db, courseId);
  const { info, att } = await withSession(sectionId, opts, (s) => readRaw(s, day));
  return lessonView(day, info, att, prismNames(db));
}

/**
 * Save a lesson's marks. `marks`: { [ps_student_id]: code } for every student the teacher marked ('' is Present);
 * a student left out keeps their mark. `fingerprint`: the one the page was shown. → { lesson (read back), changed }.
 * Throws CHANGED (with the fresh lesson) when PowerSchool's marks moved since, OFFICE / BAD_VALUE for a change Prism
 * refuses, MISMATCH when the read-back differs from what was sent.
 */
export async function saveLesson(db, courseId, { date: day, marks = {}, fingerprint: shown } = {}, opts = {}) {
  checkDay(day);
  const sectionId = courseSection(db, courseId);
  const names = prismNames(db);
  return withSession(sectionId, opts, async (s) => {
    const before = await readRaw(s, day);
    const sectionDays = [].concat(before.att?.sectionAttendances || []);
    if (sectionDays.length !== 1) throw new AttendanceError('NO_LESSON', 'The class has no single lesson on this date.');
    if (fingerprint(sectionDays) !== shown) {
      throw new AttendanceError('CHANGED', 'Attendance changed in PowerSchool since this lesson was opened. It has been read again: check it and save again.',
        { lesson: lessonView(day, before.info, before.att, names) });
    }
    const codes = new Set(catalog(before.info).map((c) => c.code));
    const sa = sectionDays[0];
    const byId = new Map((sa.studentAttendance || []).map((st) => [String(st.studentId), st]));
    for (const [id, code] of Object.entries(marks)) {
      const st = byId.get(String(id));
      if (!st || !st.onTrack) throw new AttendanceError('BAD_VALUE', 'A marked student is not in this lesson.');
      if (!codes.has(code)) throw new AttendanceError('BAD_VALUE', `"${code}" is not one of the school's attendance codes.`);
      const ms = st.meetingAttendance || [];
      if (ms.length !== 1) throw new AttendanceError('BAD_VALUE', 'A marked student has no single mark to set in this lesson.');
      if (ms[0].readOnly && (ms[0].code ?? '') !== code) throw new AttendanceError('OFFICE', 'An office mark cannot be changed in Prism.');
    }
    const expected = new Map();
    const body = [{
      commentsEnabled: sa.commentsEnabled, date: sa.date, meetingMode: sa.meetingMode, meetingType: sa.meetingType,
      periodId: sa.periodId, sectionId: sa.sectionId,
      studentAttendance: (sa.studentAttendance || []).map((st) => {
        const meetingAttendance = [];
        if (st.onTrack) for (const m of st.meetingAttendance || []) {
          const id = String(st.studentId);
          const code = Object.hasOwn(marks, id) && !m.readOnly ? marks[id] : m.code;
          expected.set(keyOf(sa, st, m), code ?? '');
          meetingAttendance.push({ code, comment: m.comment, intervalDuration: m.intervalDuration, intervalNumber: m.intervalNumber });
        }
        return { studentId: st.studentId, dcid: st.dcid, meetingAttendance };
      }),
    }];
    await s.ps.sendJson('/ws/attendance/section_attendance', body);
    const after = await readRaw(s, day);
    const backDays = [].concat(after.att?.sectionAttendances || []);
    const wrong = [];
    for (const bsa of backDays) for (const st of bsa.studentAttendance || []) for (const m of (st.onTrack ? st.meetingAttendance || [] : [])) {
      const k = keyOf(bsa, st, m);
      if (expected.has(k) && (m.code ?? '') !== expected.get(k)) wrong.push(k);
    }
    const lesson = lessonView(day, after.info, after.att, names);
    if (wrong.length || backDays.length !== 1) {
      throw new AttendanceError('MISMATCH', `PowerSchool did not keep ${wrong.length || 'every'} mark as sent. The lesson has been read again: check it before saving again.`, { lesson });
    }
    const changed = Object.entries(marks).filter(([id, code]) => (byId.get(String(id))?.meetingAttendance?.[0]?.code ?? '') !== code).length;
    return { lesson, changed };
  });
}
