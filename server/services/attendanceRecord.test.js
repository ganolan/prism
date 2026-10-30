// #208: attendance marks this term, read from PowerSchool every night and stored for the roster and the student page.
import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import {
  attendanceKind, pieces, termStart, marksFrom, readSectionAttendance, storeCourseAttendance, storeLesson,
  syncAttendance, courseAttendance, studentAttendance, LAST_LESSONS,
} from './attendanceRecord.js';

const CATALOG = [
  { attCode: '', description: 'Present', sortOrder: 0 },
  { attCode: 'A', description: 'Absence', sortOrder: 1 },
  { attCode: 'X', description: 'Absence (Excused)', sortOrder: 2 },
  { attCode: 'I', description: 'Illness', sortOrder: 3 },
  { attCode: 'T', description: 'Tardy', sortOrder: 5 },
  { attCode: 'TX', description: 'Tardy (Excused)', sortOrder: 7 },
  { attCode: 'F2', description: 'Trip (Sports)', sortOrder: 9 },
];
const codes = CATALOG.map((c) => ({ code: c.attCode, description: c.description, sortOrder: c.sortOrder }));

let db;
let course;
const student = (dcid) => db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name, school_uid) VALUES (?, 'A', 'B', ?)`)
  .run(`u${dcid}`, `1_${dcid}`).lastInsertRowid;
const addCourse = (extra = {}) => db.prepare(`INSERT INTO courses (schoology_section_id, course_name, term_start, term_end, archived)
  VALUES (?, ?, ?, ?, ?)`).run(extra.section ?? '8001', extra.name ?? 'AP CSP', extra.start ?? '2026-08-13', extra.end ?? '2027-06-08', extra.archived ?? 0).lastInsertRowid;
const day = (date, marks) => ({
  date, sectionId: 1, periodId: 2,
  studentAttendance: marks.map(([dcid, code, readOnly = false, onTrack = true]) => ({ dcid, studentId: dcid, onTrack, meetingAttendance: [{ code, readOnly }] })),
});

beforeEach(() => { db = new Database(':memory:'); migrate(db); course = addCourse(); });

describe('attendanceKind', () => {
  test('by the catalog\'s description: blank Present, Tardy late, Excused excused, the rest absent', () => {
    expect(attendanceKind('', '')).toBe('present');
    expect(attendanceKind('T', 'Tardy')).toBe('late');
    expect(attendanceKind('TB', 'Tardy (For More Than 15 Mins)')).toBe('late');
    expect(attendanceKind('TX', 'Tardy (Excused)')).toBe('late');
    expect(attendanceKind('X', 'Absence (Excused)')).toBe('excused');
    expect(attendanceKind('A', 'Absence')).toBe('absent');
    expect(attendanceKind('I', 'Illness')).toBe('absent');
    expect(attendanceKind('F2', 'Trip (Sports)')).toBe('absent');
    expect(attendanceKind('Q', '')).toBe('absent'); // a code the catalog does not describe
  });
});

describe('pieces and termStart', () => {
  test('a range in 14-day pieces', () => {
    expect(pieces('2026-10-01', '2026-10-30')).toEqual([['2026-10-01', '2026-10-14'], ['2026-10-15', '2026-10-28'], ['2026-10-29', '2026-10-30']]);
    expect(pieces('2026-10-30', '2026-10-30')).toEqual([['2026-10-30', '2026-10-30']]);
  });

  test('the shortest semester-length term holding today, inside the course\'s own term', () => {
    const ranges = [{ start: '2026-08-13', end: '2027-06-08' }, { start: '2026-08-13', end: '2026-12-11' }, { start: '2027-01-04', end: '2027-06-08' }, { start: '2026-10-01', end: '2026-10-20' }];
    const year = { term_start: '2026-08-13', term_end: '2027-06-08' };
    expect(termStart(year, ranges, '2026-10-30')).toBe('2026-08-13');
    expect(termStart(year, ranges, '2027-02-01')).toBe('2027-01-04');
    expect(termStart({ term_start: '2027-01-04', term_end: '2027-06-08' }, ranges, '2026-10-30')).toBeNull(); // not started
    expect(termStart({ term_start: null, term_end: null }, [], '2026-10-30')).toBeNull();
  });
});

describe('marksFrom', () => {
  test('one mark per student per day, on-track students only; a day with two section-days keeps a mark that is not Present', () => {
    const marks = marksFrom([
      day('2026-10-27', [['5001', ''], ['5002', 'I', true], ['5003', 'A', false, false]]),
      day('2026-10-27', [['5001', 'T']]),
      day('2026-10-29', [['5001', 'A'], ['5002', '']]),
    ]);
    expect(marks).toEqual([
      { dcid: '5001', date: '2026-10-27', code: 'T', office: false },
      { dcid: '5002', date: '2026-10-27', code: 'I', office: true },
      { dcid: '5001', date: '2026-10-29', code: 'A', office: false },
      { dcid: '5002', date: '2026-10-29', code: '', office: false },
    ]);
  });
});

describe('readSectionAttendance', () => {
  test('reads the catalog, then the range in 14-day pieces', async () => {
    const calls = [];
    const ps = {
      read: async (path, params) => {
        calls.push([path, params.startDate, params.endDate]);
        if (path.endsWith('section_info')) return [{ attendanceCodes: CATALOG }];
        return { sectionAttendances: params.startDate === '2026-10-15' ? [day('2026-10-20', [['5001', 'A']])] : [] };
      },
    };
    const r = await readSectionAttendance(ps, { sectionDcid: '9', userDcid: '7' }, '2026-10-01', '2026-10-30');
    expect(calls).toEqual([
      ['/ws/attendance/section_info', '2026-10-30', '2026-10-30'],
      ['/ws/attendance/section_attendance', '2026-10-01', '2026-10-14'],
      ['/ws/attendance/section_attendance', '2026-10-15', '2026-10-28'],
      ['/ws/attendance/section_attendance', '2026-10-29', '2026-10-30'],
    ]);
    expect(r.marks).toEqual([{ dcid: '5001', date: '2026-10-20', code: 'A', office: false }]);
    expect(r.codes).toContainEqual({ code: 'X', description: 'Absence (Excused)', sortOrder: 2 });
  });
});

describe('storing and summing', () => {
  test('replaces the range read, counts by the catalog, and keeps the last 8 lessons', () => {
    const ana = student('5001');
    const ben = student('5002');
    storeCourseAttendance(db, course, { from: '2026-08-13', to: '2026-10-30', codes, marks: [
      { dcid: '5001', date: '2026-08-20', code: 'A', office: false },
      { dcid: '5009', date: '2026-08-20', code: 'A', office: false }, // not a Prism student: left out
    ] }, '2026-10-30T00:00:00Z');
    const dates = ['2026-10-01', '2026-10-05', '2026-10-07', '2026-10-09', '2026-10-13', '2026-10-15', '2026-10-19', '2026-10-21', '2026-10-27', '2026-10-29'];
    const anaCodes = ['', 'A', 'T', 'X', 'I', '', 'F2', 'TX', '', 'A'];
    const r = storeCourseAttendance(db, course, { from: '2026-08-13', to: '2026-10-30', codes, marks: [
      ...dates.map((d, i) => ({ dcid: '5001', date: d, code: anaCodes[i], office: anaCodes[i] === 'I' })),
      { dcid: '5002', date: '2026-10-29', code: '', office: false },
    ] }, '2026-10-30T01:00:00Z');
    expect(r.stored).toBe(11);
    const a = courseAttendance(db, course);
    expect(a.from).toBe('2026-08-13');
    expect(a.read_at).toBe('2026-10-30T01:00:00Z');
    // 20/08 was replaced; A, I, F2, A are absences; T, TX late; X excused.
    expect(a.students[ana]).toMatchObject({ absences: 4, lates: 2, excused: 1 });
    expect(a.students[ana].lessons).toHaveLength(LAST_LESSONS);
    expect(a.students[ana].lessons[0]).toEqual({ date: '2026-10-07', code: 'T', description: 'Tardy', kind: 'late', office: false });
    expect(a.students[ana].lessons[2]).toEqual({ date: '2026-10-13', code: 'I', description: 'Illness', kind: 'absent', office: true });
    expect(a.students[ana].lessons[6]).toMatchObject({ code: '', description: 'Present', kind: 'present' });
    expect(a.students[ben]).toEqual({ absences: 0, lates: 0, excused: 0, lessons: [{ date: '2026-10-29', code: '', description: 'Present', kind: 'present', office: false }] });
  });

  test('a course never read has no attendance', () => {
    expect(courseAttendance(db, course)).toBeNull();
  });

  test('a lesson read on the Attendance tab replaces that day, once the course has been read', () => {
    const ana = student('5001');
    const lesson = { date: '2026-10-30', lesson: true, codes: [{ code: '', description: 'Present' }, { code: 'A', description: 'Absence' }],
      students: [{ student_id: ana, code: 'A', office: false }, { student_id: null, code: '' }] };
    storeLesson(db, course, lesson);
    expect(db.prepare('SELECT COUNT(*) AS n FROM attendance_marks').get().n).toBe(0); // not read yet: nothing stored
    storeCourseAttendance(db, course, { from: '2026-08-13', to: '2026-10-29', codes, marks: [] });
    storeLesson(db, course, lesson);
    expect(courseAttendance(db, course).students[ana]).toMatchObject({ absences: 1 });
    storeLesson(db, course, { ...lesson, students: [{ student_id: ana, code: '', office: false }] });
    expect(courseAttendance(db, course).students[ana]).toMatchObject({ absences: 0, lessons: [{ date: '2026-10-30', kind: 'present' }] });
    storeLesson(db, course, { date: '2026-10-31', lesson: false, students: [] }); // no lesson: nothing
    expect(db.prepare('SELECT COUNT(*) AS n FROM attendance_marks').get().n).toBe(1);
  });

  test('the student page: each current course read with a mark for the student', () => {
    const ana = student('5001');
    const old = addCourse({ section: '8002', name: 'Old', archived: 1 });
    const other = addCourse({ section: '8003', name: 'AI & ML' });
    storeCourseAttendance(db, course, { from: '2026-08-13', to: '2026-10-30', codes, marks: [{ dcid: '5001', date: '2026-10-29', code: 'A', office: false }] });
    storeCourseAttendance(db, old, { from: '2026-08-13', to: '2026-10-30', codes, marks: [{ dcid: '5001', date: '2026-10-29', code: 'A', office: false }] });
    storeCourseAttendance(db, other, { from: '2026-08-13', to: '2026-10-30', codes, marks: [] });
    expect(studentAttendance(db, ana)).toEqual([{ course_id: course, course_name: 'AP CSP', from: '2026-08-13', read_at: expect.any(String),
      absences: 1, lates: 0, excused: 0, lessons: [{ date: '2026-10-29', code: 'A', description: 'Absence', kind: 'absent', office: false }] }]);
  });
});

describe('syncAttendance', () => {
  const section = (courseId, extra = {}) => ({ courseId, schoologySectionId: '8001', sectionDcid: '9', userDcid: '7', ...extra });

  test('reads each course\'s term so far and stores it (a course with no term of its own takes the school\'s); a section without a user is skipped', async () => {
    student('5001');
    const noTerm = addCourse({ section: '8004', name: 'No term', start: null, end: null });
    const ps = { read: async (path) => (path.endsWith('section_info') ? [{ attendanceCodes: CATALOG }] : { sectionAttendances: [day('2026-10-29', [['5001', 'A']])] }) };
    const r = await syncAttendance(db, ps, [section(course), section(noTerm), section(course, { userDcid: null })], { today: '2026-10-30' });
    expect(r).toEqual({ read: 2, failed: 0, skipped: 1, marks: 2 });
    expect(db.prepare('SELECT from_date, to_date FROM attendance_reads WHERE course_id = ?').get(course)).toEqual({ from_date: '2026-08-13', to_date: '2026-10-30' });
    expect(db.prepare('SELECT from_date FROM attendance_reads WHERE course_id = ?').get(noTerm)).toEqual({ from_date: '2026-08-13' });
  });

  test('a failed course keeps its marks; an ended session is launched again once; a security page stops', async () => {
    student('5001');
    storeCourseAttendance(db, course, { from: '2026-08-13', to: '2026-10-29', codes, marks: [{ dcid: '5001', date: '2026-10-29', code: 'A', office: false }] });
    const failing = { read: async () => { throw new Error('PowerSchool answered 500'); } };
    const r = await syncAttendance(db, failing, [section(course)], { today: '2026-10-30' });
    expect(r).toMatchObject({ read: 0, failed: 1 });
    expect(courseAttendance(db, course).students).not.toEqual({});

    let ended = true;
    const relaunched = [];
    const ending = { read: async (path) => {
      if (ended) { ended = false; throw Object.assign(new Error('302'), { code: 'PS_SESSION', sessionEnded: true }); }
      return path.endsWith('section_info') ? [{ attendanceCodes: CATALOG }] : { sectionAttendances: [] };
    } };
    expect(await syncAttendance(db, ending, [section(course)], { today: '2026-10-30', relaunch: async (id) => relaunched.push(id) })).toMatchObject({ read: 1 });
    expect(relaunched).toEqual(['8001']);

    const security = { read: async () => { throw Object.assign(new Error('Security Violation Logged'), { code: 'PS_SECURITY' }); } };
    await expect(syncAttendance(db, security, [section(course)], { today: '2026-10-30' })).rejects.toMatchObject({ code: 'PS_SECURITY' });
  });
});
