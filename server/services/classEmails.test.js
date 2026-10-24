import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../middleware/featureGate.js', async () => {
  const real = await vi.importActual('../middleware/featureGate.js');
  return { ...real, getFeatures: vi.fn(() => ({ powerschool_alerts: true })) };
});

import { getFeatures } from '../middleware/featureGate.js';
import { classEmails } from './classEmails.js';
import { getDb } from '../db/index.js';

let courseA; let courseB;
const SYNCED = '2026-10-21T01:00:00.000Z';

function addStudent({ first, last, email = null, courses = [courseA], dropped = null }) {
  const db = getDb();
  const id = db.prepare('INSERT INTO students (first_name, last_name, email) VALUES (?,?,?)').run(first, last, email).lastInsertRowid;
  for (const c of courses) db.prepare('INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?,?,?)').run(id, c, dropped);
  return id;
}
const addParent = (studentId, uid, first, email) => getDb().prepare(
  'INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)'
).run(studentId, uid, first, 'Sample', email).lastInsertRowid;
const addSlot = (studentId, slot, name, email) => getDb().prepare(
  'INSERT INTO student_ps_guardians (student_id, slot, name, email, phone) VALUES (?, ?, ?, ?, NULL)'
).run(studentId, slot, name, email);
const setPs = (studentId, fields = {}) => {
  const cols = ['guardians_synced_at', ...Object.keys(fields)];
  getDb().prepare(`INSERT INTO student_powerschool (student_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
    .run(studentId, SYNCED, ...Object.values(fields));
};

beforeEach(() => {
  vi.mocked(getFeatures).mockReturnValue({ powerschool_alerts: true });
  const db = getDb();
  db.exec('DELETE FROM mastery_rollups; DELETE FROM student_ps_guardians; DELETE FROM student_powerschool; DELETE FROM parents; DELETE FROM enrolments; DELETE FROM students; DELETE FROM courses;');
  courseA = db.prepare("INSERT INTO courses (schoology_section_id, course_name) VALUES ('secA', 'Course A')").run().lastInsertRowid;
  courseB = db.prepare("INSERT INTO courses (schoology_section_id, course_name) VALUES ('secB', 'Course B')").run().lastInsertRowid;
});

describe('classEmails', () => {
  test('with studentIds returns only those students and their guardians, and keeps the do-not-contact and deceased rules', () => {
    const ada = addStudent({ first: 'Ada', last: 'Sample', email: 'ada@example.test' });
    const ben = addStudent({ first: 'Ben', last: 'Sample', email: 'ben@example.test' });
    const cat = addStudent({ first: 'Cat', last: 'Sample', email: 'cat@example.test' });
    // Ada: Robin is clear, Kit is do-not-contact. Ben: his guardian is deceased. Cat: not asked for.
    addParent(ada, 'p1', 'Robin', 'robin@example.test'); addSlot(ada, 1, 'Sample, Robin', 'robin@example.test');
    addParent(ada, 'p2', 'Kit', 'kit@example.test'); addSlot(ada, 2, 'Sample, Kit', 'kit@example.test');
    setPs(ada, { dnc_g2: '1' });
    addParent(ben, 'p3', 'Sam', 'sam@example.test'); addSlot(ben, 1, 'Sample, Sam', 'sam@example.test');
    setPs(ben, { g1_deceased: '1' });
    addParent(cat, 'p4', 'Pat', 'pat@example.test'); addSlot(cat, 1, 'Sample, Pat', 'pat@example.test');
    setPs(cat);

    const r = classEmails(getDb(), [courseA], { type: 'both', studentIds: [ada, ben] });

    expect(r.students.map((s) => s.id)).toEqual([ada, ben]);
    expect(r.addresses).toEqual(['ada@example.test', 'robin@example.test', 'ben@example.test']);
    expect(r.addresses.join(' ')).not.toMatch(/kit@|sam@|cat@|pat@/);
    expect(r.excluded).toBe(2);
    expect(r.count).toBe(3);
  });

  test('studentIds ignore a student who is not enrolled, or who dropped, and replace the roster filters', () => {
    const ada = addStudent({ first: 'Ada', last: 'Sample', email: 'ada@example.test' });
    const dropped = addStudent({ first: 'Dee', last: 'Sample', email: 'dee@example.test', dropped: '2026-09-01' });
    const other = addStudent({ first: 'Eve', last: 'Sample', email: 'eve@example.test', courses: [courseB] });

    const r = classEmails(getDb(), [courseA], { type: 'student', studentIds: [ada, dropped, other, 9999], filters: { gender: new Set(['F']) } });

    expect(r.addresses).toEqual(['ada@example.test']);
    expect(classEmails(getDb(), [courseA], { type: 'student', studentIds: [] }).addresses).toEqual([]);
  });
});
