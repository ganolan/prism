// Attendance tracking (#208): each current course's attendance marks this term, read from PowerSchool every night in
// the alerts pass (psAlertsSync.js, on its PowerSchool session) and stored, so the Roster tab and the student page can
// show absences and the last lessons without a PowerSchool read. The Attendance tab's save stores the lesson it read
// back (storeLesson), so a mark made in Prism shows on the roster at once.
//   read: GET /ws/attendance/section_info (the code catalog) and GET /ws/attendance/section_attendance over the term,
//         in 14-day pieces (the range verified 29/10/2026; .claude/powerschool-api-reference.md "Attendance: reading
//         and marking (#39)").
// A code is counted by the school's catalog, never a list of codes kept in Prism: blank is Present, a description that
// starts "Tardy" is late, one that says "Excused" is excused, and every other code is an absence (an illness, a trip,
// an exam out of class: the student missed the lesson). The strip shows PowerSchool's own code and description.
import { loadTermRanges } from '../lib/semesters.js';

export const PIECE_DAYS = 14;
export const LAST_LESSONS = 8;
const MIN_TERM_DAYS = 100; // a semester or longer (lib/semesters.js)

// → 'present' | 'late' | 'excused' | 'absent'.
export function attendanceKind(code, description = '') {
  if (!code) return 'present';
  if (/^\s*tardy/i.test(description)) return 'late';
  if (/excused/i.test(description)) return 'excused';
  return 'absent';
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;

// [from, to] in pieces of at most PIECE_DAYS days.
export function pieces(from, to, size = PIECE_DAYS) {
  const out = [];
  for (let start = from; start <= to; start = addDays(start, size)) {
    const end = addDays(start, size - 1);
    out.push([start, end < to ? end : to]);
  }
  return out;
}

// The first day of this term for a course: the start of the shortest semester-length term (stored or a full year's
// half, lib/semesters.js) that holds today and lies inside the course's own term; else the course's term start.
// → 'YYYY-MM-DD' or null (no term stored).
export function termStart(course, ranges, today) {
  const within = course.term_start && course.term_end ? { start: course.term_start, end: course.term_end } : null;
  let best = null;
  for (const r of ranges) {
    if (daysBetween(r.start, r.end) < MIN_TERM_DAYS || !(r.start <= today && today <= r.end)) continue;
    if (within && (r.start < within.start || r.end > within.end)) continue;
    if (!best || daysBetween(r.start, r.end) < daysBetween(best.start, best.end)) best = r;
  }
  if (best) return best.start;
  return within && within.start <= today ? within.start : null;
}

// One mark per student per lesson day from section_attendance's section-days; a day with two section-days keeps a
// mark that is not Present. → [{ dcid, date, code, office }].
export function marksFrom(sectionDays) {
  const byKey = new Map();
  for (const sa of sectionDays) {
    for (const st of sa.studentAttendance || []) {
      if (!st.onTrack) continue;
      for (const m of st.meetingAttendance || []) {
        const key = `${st.dcid}|${sa.date}`;
        const mark = { dcid: String(st.dcid), date: sa.date, code: m.code ?? '', office: Boolean(m.readOnly) };
        const had = byKey.get(key);
        if (!had || (had.code === '' && mark.code !== '')) byKey.set(key, mark);
      }
    }
  }
  return [...byKey.values()];
}

// The catalog from section_info, in PowerSchool's order. → [{ code, description, sortOrder }].
export function codesFrom(info) {
  return (info?.attendanceCodes || []).map((c) => ({
    code: c.attCode ?? '', description: c.descriptionTranslated || c.description || '', sortOrder: c.sortOrder ?? null,
  }));
}

/**
 * Read a section's marks from `from` to `to` on a launched PowerSchool session. ids: { sectionDcid, userDcid }.
 * Throws on a failed read, so a partial answer never replaces stored marks. → { codes, marks }.
 */
export async function readSectionAttendance(ps, ids, from, to) {
  const get = (path, params) => ps.read(path, params, { method: 'GET', accept: 'application/json' });
  const info = await get('/ws/attendance/section_info', { sectionDcid: ids.sectionDcid, multiSections: 'false', startDate: to, endDate: to });
  const sectionDays = [];
  for (const [start, end] of pieces(from, to)) {
    const att = await get('/ws/attendance/section_attendance', {
      sectionDcid: ids.sectionDcid, userDcid: ids.userDcid, startDate: start, endDate: end, includeStudentAlerts: 'false', multiSections: 'false',
    });
    sectionDays.push(...[].concat(att?.sectionAttendances || []));
  }
  return { codes: codesFrom(Array.isArray(info) ? info[0] : info), marks: marksFrom(sectionDays) };
}

function storeCodes(db, codes) {
  const up = db.prepare(`INSERT INTO attendance_codes (code, description, sort_order) VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET description = excluded.description, sort_order = excluded.sort_order`);
  for (const c of codes) up.run(c.code, c.description, c.sortOrder);
}

/**
 * Replace a course's stored marks from `from` to `to` with `marks` (students matched by PowerSchool dcid, school_uid
 * "1_" + dcid; a mark for a student Prism does not hold is left out). → { stored }.
 */
export function storeCourseAttendance(db, courseId, { from, to, codes = [], marks = [] }, now = new Date().toISOString()) {
  const idOf = db.prepare('SELECT id FROM students WHERE school_uid = ?');
  const ins = db.prepare('INSERT OR REPLACE INTO attendance_marks (course_id, student_id, date, code, office) VALUES (?, ?, ?, ?, ?)');
  let stored = 0;
  db.transaction(() => {
    storeCodes(db, codes);
    db.prepare('DELETE FROM attendance_marks WHERE course_id = ? AND date BETWEEN ? AND ?').run(courseId, from, to);
    for (const m of marks) {
      const s = idOf.get(`1_${m.dcid}`);
      if (!s) continue;
      ins.run(courseId, s.id, m.date, m.code, m.office ? 1 : 0);
      stored += 1;
    }
    db.prepare(`INSERT INTO attendance_reads (course_id, from_date, to_date, read_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(course_id) DO UPDATE SET from_date = excluded.from_date, to_date = excluded.to_date, read_at = excluded.read_at`)
      .run(courseId, from, to, now);
  })();
  return { stored };
}

// After a save on the Attendance tab: the lesson as read back (attendanceMarking.js lessonView) replaces that day's
// stored marks, for a lesson inside the range already read.
export function storeLesson(db, courseId, lesson) {
  if (!lesson?.lesson) return;
  const read = db.prepare('SELECT from_date FROM attendance_reads WHERE course_id = ?').get(courseId);
  if (!read || lesson.date < read.from_date) return;
  const ins = db.prepare('INSERT OR REPLACE INTO attendance_marks (course_id, student_id, date, code, office) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    storeCodes(db, (lesson.codes || []).map((c, i) => ({ code: c.code, description: c.description, sortOrder: i })));
    db.prepare('DELETE FROM attendance_marks WHERE course_id = ? AND date = ?').run(courseId, lesson.date);
    for (const st of lesson.students || []) {
      if (st.student_id == null || st.code == null) continue;
      ins.run(courseId, st.student_id, lesson.date, st.code, st.office ? 1 : 0);
    }
  })();
}

/**
 * The nightly read for the sections the alerts pass launched: each current course's term so far, stored. Best-effort
 * per course; `relaunch(schoologySectionId)` starts a new session when PowerSchool ended one.
 * sections: [{ courseId, schoologySectionId, sectionDcid, userDcid }]. → { read, failed, skipped, marks }.
 */
export async function syncAttendance(db, ps, sections, { today, log = () => {}, relaunch } = {}) {
  const summary = { read: 0, failed: 0, skipped: 0, marks: 0 };
  const ranges = loadTermRanges(db);
  const course = db.prepare('SELECT id, course_name, term_start, term_end FROM courses WHERE id = ?');
  for (const s of sections) {
    const c = course.get(s.courseId);
    const from = c && termStart(c, ranges, today);
    if (!from || !s.userDcid) { summary.skipped += 1; continue; }
    try {
      let read;
      try {
        read = await readSectionAttendance(ps, s, from, today);
      } catch (err) {
        if (!(err.code === 'PS_SESSION' || err.sessionEnded || err.status === 401) || !relaunch) throw err;
        await relaunch(s.schoologySectionId);
        read = await readSectionAttendance(ps, s, from, today);
      }
      summary.marks += storeCourseAttendance(db, s.courseId, { from, to: today, ...read }).stored;
      summary.read += 1;
    } catch (err) {
      if (err.code === 'PS_SECURITY' || err.code === 'SESSION_EXPIRED') throw err;
      summary.failed += 1;
      log(`${c.course_name}: attendance not read (${err.message}), kept the last marks`);
    }
  }
  log(`Attendance: ${summary.read} courses read, ${summary.marks} marks (${summary.failed} not read, ${summary.skipped} without a term).`);
  return summary;
}

/**
 * Each student's attendance in a course from the stored marks. → { from, read_at, students: { [student id]:
 * { absences, lates, excused, lessons: [{ date, code, description, kind, office }] } } } (lessons: the last
 * LAST_LESSONS, oldest first), or null when the course has never been read.
 */
export function courseAttendance(db, courseId, studentIds = null) {
  const read = db.prepare('SELECT from_date, read_at FROM attendance_reads WHERE course_id = ?').get(courseId);
  if (!read) return null;
  const rows = db.prepare(`
    SELECT m.student_id, m.date, m.code, m.office, c.description FROM attendance_marks m
    LEFT JOIN attendance_codes c ON c.code = m.code
    WHERE m.course_id = ? AND m.date >= ? ORDER BY m.date`).all(courseId, read.from_date);
  const keep = studentIds ? new Set(studentIds.map(Number)) : null;
  const students = {};
  for (const r of rows) {
    if (keep && !keep.has(r.student_id)) continue;
    const s = (students[r.student_id] ||= { absences: 0, lates: 0, excused: 0, lessons: [] });
    const kind = attendanceKind(r.code, r.description || '');
    if (kind === 'absent') s.absences += 1;
    else if (kind === 'late') s.lates += 1;
    else if (kind === 'excused') s.excused += 1;
    s.lessons.push({ date: r.date, code: r.code, description: r.code ? r.description || '' : 'Present', kind, office: Boolean(r.office) });
  }
  for (const s of Object.values(students)) s.lessons = s.lessons.slice(-LAST_LESSONS);
  return { from: read.from_date, read_at: read.read_at, students };
}

// One student's attendance in each current course read. → [{ course_id, course_name, from, read_at, absences, lates,
// excused, lessons }].
export function studentAttendance(db, studentId) {
  const courses = db.prepare(`
    SELECT DISTINCT c.id, c.course_name FROM attendance_reads r JOIN courses c ON c.id = r.course_id
    JOIN attendance_marks m ON m.course_id = c.id AND m.student_id = ?
    WHERE c.archived = 0 AND c.excluded = 0 ORDER BY c.course_name`).all(studentId);
  return courses.map((c) => {
    const a = courseAttendance(db, c.id, [studentId]);
    const s = a?.students[studentId] || { absences: 0, lates: 0, excused: 0, lessons: [] };
    return { course_id: c.id, course_name: c.course_name, from: a?.from ?? null, read_at: a?.read_at ?? null, ...s };
  }).filter((c) => c.lessons.length);
}
