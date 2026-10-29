// #39: reading a lesson's attendance and saving it to PowerSchool, with the re-read, refusals and read-back.
import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { readLesson, saveLesson, clearAttendanceSessions, fingerprint, catalog } from './attendanceMarking.js';

const DAY = '2026-10-29';
const CODES = [
  { attCode: 'A', description: 'Absence', sortOrder: 2 },
  { attCode: '', description: 'Present', sortOrder: 1 },
  { attCode: 'T', description: 'Tardy', sortOrder: 6 },
  { attCode: 'I', description: 'Illness', sortOrder: 4 },
];
const mark = (code, extra = {}) => ({ code, intervalNumber: 0, intervalDuration: 70, readOnly: false, ...extra });
const student = (id, dcid, m, extra = {}) => ({ studentId: id, dcid, onTrack: true, enrolled: true, lastFirst: `Student, ${id}`, meetingAttendance: [m], ...extra });
const lessonOf = (students, taken = 1) => ({
  sectionAttendances: [{ sectionId: 4100, date: DAY, periodId: 4454, meetingMode: 'ATT_ModeMeeting', meetingType: 'Meeting', commentsEnabled: true, studentAttendance: students }],
  attendanceTakenBySectionId: { 4100: Array.from({ length: taken }, () => ({ attendanceDate: '2026-10-28' })) },
});

let db;
let course;
// A PowerSchoolWeb stand-in: section_info and section_attendance from `state`; a save replaces the marks.
function fakePs(state, { onSave = null } = {}) {
  const calls = { launches: 0, saves: [] };
  const ps = {
    launchIds: async () => ({ sectionDcid: '777', userDcid: '9', form: {} }),
    launch: async () => { calls.launches += 1; },
    read: async (path) => {
      if (path.endsWith('section_info')) return [{ attendanceCodes: CODES }];
      return structuredClone(state.att);
    },
    sendJson: async (path, body) => {
      calls.saves.push({ path, body });
      if (onSave) onSave(body);
      else {
        const sent = body[0].studentAttendance;
        for (const st of state.att.sectionAttendances[0].studentAttendance) {
          const s = sent.find((x) => x.studentId === st.studentId);
          st.meetingAttendance = st.meetingAttendance.map((m, i) => ({ ...m, code: s.meetingAttendance[i].code }));
        }
      }
      return { status: 200, text: '' };
    },
  };
  return { ps, calls, opts: { makePs: () => ps } };
}

beforeEach(() => {
  clearAttendanceSessions();
  db = new Database(':memory:');
  migrate(db);
  course = db.prepare("INSERT INTO courses (schoology_section_id, course_name) VALUES ('8458134140', 'AP CSP')").run().lastInsertRowid;
  db.prepare("INSERT INTO students (schoology_uid, first_name, last_name, preferred_name_teacher, school_uid) VALUES ('u1', 'Yee', 'Choi', 'Yeeun', '1_501')").run();
});

describe('readLesson', () => {
  test('the codes in PowerSchool\'s order, each student\'s mark, office marks flagged, whether attendance was taken', async () => {
    const state = { att: lessonOf([student(11, 501, mark('')), student(12, 502, mark('I', { readOnly: true, comment: 'Called in sick' }))]) };
    const { opts } = fakePs(state);
    const r = await readLesson(db, course, DAY, opts);
    expect(r).toMatchObject({ date: DAY, lesson: true, taken: true });
    expect(r.codes.map((c) => c.code)).toEqual(['', 'A', 'I', 'T']);
    expect(r.students).toEqual([
      { ps_student_id: '11', student_id: 1, name: 'Yeeun Choi', code: '', comment: null, office: false, markable: true },
      { ps_student_id: '12', student_id: null, name: 'Student, 12', code: 'I', comment: 'Called in sick', office: true, markable: true },
    ]);
  });

  test('a day the class does not meet: no lesson', async () => {
    const { opts } = fakePs({ att: { sectionAttendances: [], attendanceTakenBySectionId: { 4100: [] } } });
    expect(await readLesson(db, course, DAY, opts)).toMatchObject({ lesson: false, taken: false, students: [] });
  });

  test('an archived or linked course is refused', async () => {
    const { opts } = fakePs({ att: lessonOf([]) });
    db.prepare('UPDATE courses SET archived = 1').run();
    await expect(readLesson(db, course, DAY, opts)).rejects.toMatchObject({ code: 'NOT_CURRENT' });
    db.prepare('UPDATE courses SET archived = 0').run();
    db.prepare("INSERT INTO linked_sections (course_id, schoology_section_id) VALUES (?, '999')").run(course);
    await expect(readLesson(db, course, DAY, opts)).rejects.toMatchObject({ code: 'LINKED' });
  });
});

describe('saveLesson', () => {
  const setup = (students, taken = 0, extra) => {
    const state = { att: lessonOf(students, taken) };
    return { state, ...fakePs(state, extra) };
  };

  test('sends every on-track student\'s mark with the teacher\'s codes, office marks as they are, and reads back', async () => {
    const { calls, opts } = setup([student(11, 501, mark('')), student(12, 502, mark('I', { readOnly: true, comment: 'Called in sick' })), student(13, 503, mark(''))]);
    const shown = await readLesson(db, course, DAY, opts);
    const r = await saveLesson(db, course, { date: DAY, marks: { 11: 'T', 13: '' }, fingerprint: shown.fingerprint }, opts);
    expect(calls.saves).toHaveLength(1);
    expect(calls.saves[0].path).toBe('/ws/attendance/section_attendance');
    expect(calls.saves[0].body[0]).toMatchObject({ date: DAY, periodId: 4454, sectionId: 4100, commentsEnabled: true });
    expect(calls.saves[0].body[0].studentAttendance.map((s) => s.meetingAttendance[0].code)).toEqual(['T', 'I', '']);
    expect(calls.saves[0].body[0].studentAttendance[1].meetingAttendance[0].comment).toBe('Called in sick');
    expect(r.changed).toBe(1);
    expect(r.lesson.students.find((s) => s.ps_student_id === '11').code).toBe('T');
    expect(calls.launches).toBe(1); // the read and the save share one session
  });

  test('refused when PowerSchool changed since the page was shown: nothing sent, the fresh lesson returned', async () => {
    const { state, calls, opts } = setup([student(11, 501, mark(''))]);
    const shown = await readLesson(db, course, DAY, opts);
    state.att.sectionAttendances[0].studentAttendance[0].meetingAttendance[0] = mark('I', { readOnly: true });
    await expect(saveLesson(db, course, { date: DAY, marks: { 11: 'A' }, fingerprint: shown.fingerprint }, opts))
      .rejects.toMatchObject({ code: 'CHANGED', lesson: { students: [{ code: 'I', office: true }] } });
    expect(calls.saves).toHaveLength(0);
  });

  test('refuses an office mark changed, an unknown code or a student not in the lesson', async () => {
    const { calls, opts } = setup([student(11, 501, mark('')), student(12, 502, mark('I', { readOnly: true }))]);
    const { fingerprint: fp } = await readLesson(db, course, DAY, opts);
    await expect(saveLesson(db, course, { date: DAY, marks: { 12: '' }, fingerprint: fp }, opts)).rejects.toMatchObject({ code: 'OFFICE' });
    await expect(saveLesson(db, course, { date: DAY, marks: { 11: 'ZZ' }, fingerprint: fp }, opts)).rejects.toMatchObject({ code: 'BAD_VALUE' });
    await expect(saveLesson(db, course, { date: DAY, marks: { 99: 'A' }, fingerprint: fp }, opts)).rejects.toMatchObject({ code: 'BAD_VALUE' });
    expect(calls.saves).toHaveLength(0);
    // The office mark sent unchanged is fine.
    await expect(saveLesson(db, course, { date: DAY, marks: { 11: 'A', 12: 'I' }, fingerprint: fp }, opts)).resolves.toMatchObject({ changed: 1 });
  });

  test('a read-back that differs from what was sent is reported', async () => {
    const { opts } = setup([student(11, 501, mark(''))], 0, { onSave: () => {} }); // PowerSchool keeps nothing
    const { fingerprint: fp } = await readLesson(db, course, DAY, opts);
    await expect(saveLesson(db, course, { date: DAY, marks: { 11: 'A' }, fingerprint: fp }, opts)).rejects.toMatchObject({ code: 'MISMATCH' });
  });

  test('a session that ended is started again once', async () => {
    const { ps, calls, opts } = setup([student(11, 501, mark(''))]);
    const { fingerprint: fp } = await readLesson(db, course, DAY, opts);
    const read = ps.read;
    let ended = false;
    ps.read = async (...a) => { if (!ended) { ended = true; throw Object.assign(new Error('302'), { sessionEnded: true }); } return read(...a); };
    await saveLesson(db, course, { date: DAY, marks: { 11: 'A' }, fingerprint: fp }, opts);
    expect(calls.launches).toBe(2);
  });
});

describe('helpers', () => {
  test('the fingerprint follows codes, comments and office flags, not order', () => {
    const a = lessonOf([student(11, 501, mark('')), student(12, 502, mark('T'))]).sectionAttendances;
    const b = lessonOf([student(12, 502, mark('T')), student(11, 501, mark(''))]).sectionAttendances;
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(lessonOf([student(11, 501, mark('A'))]).sectionAttendances)).not.toBe(fingerprint(lessonOf([student(11, 501, mark(''))]).sectionAttendances));
  });
  test('catalog keeps PowerSchool\'s order', () => {
    expect(catalog({ attendanceCodes: CODES }).map((c) => c.description)).toEqual(['Present', 'Absence', 'Illness', 'Tardy']);
  });
});
