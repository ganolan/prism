import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../middleware/featureGate.js', async () => {
  const real = await vi.importActual('../middleware/featureGate.js');
  return { ...real, getFeatures: vi.fn(() => ({ powerschool_alerts: false })) };
});

import { getFeatures } from '../middleware/featureGate.js';
import router from './tools.js';
import { getDb } from '../db/index.js';

async function get(path) {
  const app = express();
  app.use('/api/tools', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

let courseA;
let courseB;

function addStudent({ first, last, preferred = null, teacher = null, courses = [courseA], dropped = null }) {
  const db = getDb();
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO students (first_name, last_name, preferred_name, preferred_name_teacher) VALUES (?,?,?,?)'
  ).run(first, last, preferred, teacher);
  for (const c of courses) {
    db.prepare('INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?,?,?)')
      .run(lastInsertRowid, c, dropped);
  }
  return lastInsertRowid;
}

beforeEach(() => {
  vi.mocked(getFeatures).mockReturnValue({ powerschool_alerts: false });
  const db = getDb();
  db.exec('DELETE FROM student_ps_guardians; DELETE FROM student_powerschool; DELETE FROM parents; DELETE FROM enrolments; DELETE FROM students; DELETE FROM courses;');
  courseA = db.prepare("INSERT INTO courses (schoology_section_id, course_name) VALUES ('secA', 'Course A')").run().lastInsertRowid;
  courseB = db.prepare("INSERT INTO courses (schoology_section_id, course_name) VALUES ('secB', 'Course B')").run().lastInsertRowid;
});

describe('GET /api/tools/roster/:courseId', () => {
  test('returns enrolled students ordered by surname, with a count', async () => {
    addStudent({ first: 'Zoe', last: 'Adams' });
    addStudent({ first: 'Alexander', last: 'Chen' });

    const { status, body } = await get(`/api/tools/roster/${courseA}`);

    expect(status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.students.map(s => s.last_name)).toEqual(['Adams', 'Chen']);
  });

  test('includes every name field the client needs to format a list', async () => {
    addStudent({ first: 'Alexander', last: 'Chen', preferred: 'Al', teacher: 'Alex' });

    const { body } = await get(`/api/tools/roster/${courseA}`);

    expect(body.students[0]).toMatchObject({
      first_name: 'Alexander',
      last_name: 'Chen',
      preferred_name: 'Al',
      preferred_name_teacher: 'Alex',
    });
    expect(body.students[0].id).toBeTypeOf('number');
  });

  test('excludes students who have dropped the course', async () => {
    addStudent({ first: 'Bao', last: 'Nguyen' });
    addStudent({ first: 'Gone', last: 'Away', dropped: '2026-01-15T00:00:00Z' });

    const { body } = await get(`/api/tools/roster/${courseA}`);

    expect(body.students.map(s => s.first_name)).toEqual(['Bao']);
  });

  test('spans several courses and lists a student enrolled in both only once', async () => {
    addStudent({ first: 'Dual', last: 'Enrolled', courses: [courseA, courseB] });
    addStudent({ first: 'Only', last: 'Bee', courses: [courseB] });

    const { body } = await get(`/api/tools/roster/${courseA},${courseB}`);

    expect(body.count).toBe(2);
    expect(body.students.map(s => s.last_name)).toEqual(['Bee', 'Enrolled']);
  });

  test('a course with no enrolments returns an empty roster, not an error', async () => {
    const { status, body } = await get(`/api/tools/roster/${courseB}`);

    expect(status).toBe(200);
    expect(body).toEqual({ students: [], count: 0 });
  });
});

describe('GET /api/tools/emails/:courseId', () => {
  test('returns bare deduped addresses alongside the named Outlook list', async () => {
    const db = getDb();
    const zoe = addStudent({ first: 'Zoe', last: 'Adams', courses: [courseA, courseB] });
    const alex = addStudent({ first: 'Alexander', last: 'Chen' });
    db.prepare('UPDATE students SET email = ? WHERE id = ?').run('zoe@example.com', zoe);
    db.prepare('UPDATE students SET email = ? WHERE id = ?').run('alex@example.com', alex);

    const { status, body } = await get(`/api/tools/emails/${courseA},${courseB}?type=student`);

    expect(status).toBe(200);
    expect(body.addresses).toEqual(['zoe@example.com', 'alex@example.com']);
    expect(body.formatted).toBe('Zoe Adams <zoe@example.com>; Alexander Chen <alex@example.com>');
    expect(body.count).toBe(2);
  });
});

// #66: guardians PowerSchool does not clear are left out of the copied list.
describe('GET /api/tools/emails/:courseId and guardian contact status', () => {
  const SYNCED = '2026-10-21T01:00:00.000Z';
  const addParent = (studentId, uid, first, email) => getDb().prepare(
    'INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)'
  ).run(studentId, uid, first, 'Sample', email).lastInsertRowid;
  const addSlot = (studentId, slot, name, email) => getDb().prepare(
    'INSERT INTO student_ps_guardians (student_id, slot, name, email) VALUES (?, ?, ?, ?)'
  ).run(studentId, slot, name, email);
  const setPs = (studentId, fields) => {
    const cols = ['guardians_synced_at', ...Object.keys(fields)];
    getDb().prepare(`INSERT INTO student_powerschool (student_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
      .run(studentId, SYNCED, ...Object.values(fields));
  };
  const on = () => vi.mocked(getFeatures).mockReturnValue({ powerschool_alerts: true });
  const parents = (courses = courseA) => get(`/api/tools/emails/${courses}?type=parent`);

  // Robin (slot 1, contactable by default) and Kit (slot 2, flagged) for one child.
  function familyWithOneFlagged() {
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    addParent(a, 'p1', 'Robin', 'robin@example.test');
    addParent(a, 'p2', 'Kit', 'kit@example.test');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test');
    addSlot(a, 2, 'Sample, Kit', 'kit@example.test');
    setPs(a, { dnc_g2: '1' });
    return a;
  }

  test('feature off: nothing is filtered and nothing is counted', async () => {
    familyWithOneFlagged();
    const { body } = await parents();
    expect(body.addresses).toEqual(['kit@example.test', 'robin@example.test']);
    expect(body.excluded).toBe(0);
  });

  test('feature off: the legacy parent_email is still copied', async () => {
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    getDb().prepare('UPDATE students SET parent_email = ? WHERE id = ?').run('legacy@example.test', a);
    const { body } = await parents();
    expect(body.addresses).toEqual(['legacy@example.test']);
    expect(body.excluded).toBe(0);
  });

  test('a student-only list reports no exclusions', async () => {
    on();
    familyWithOneFlagged();
    const { body } = await get(`/api/tools/emails/${courseA}?type=student`);
    expect(body.excluded).toBe(0);
  });

  test('feature on: leaves out not-contactable parents and counts them', async () => {
    on();
    familyWithOneFlagged();
    const { body } = await parents();
    expect(body.addresses).toEqual(['robin@example.test']);
    expect(body.emails).toEqual(['"Robin Sample (parent of Ada Sample)" <robin@example.test>']);
    expect(body.formatted).not.toContain('kit@');
    expect(body.count).toBe(1);
    expect(body.excluded).toBe(1);
  });

  test('feature on: a student not yet checked against PowerSchool contributes no addresses', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    addParent(a, 'p1', 'Robin', 'robin@example.test');
    const { body } = await parents();
    expect(body.addresses).toEqual([]);
    expect(body.excluded).toBe(1);
  });

  test('feature on: leaves out a guardian flagged through a sibling in the other course', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    const b = addStudent({ first: 'Ben', last: 'Sample', courses: [courseB] });
    // The same guardian (shared email) for two children: flagged for Ben, clear for Ada.
    addParent(a, 'p1', 'Robin', 'robin@example.test');
    addParent(b, 'p9', 'Robin', 'Robin@Example.test');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test');
    addSlot(b, 1, 'Sample, Robin', 'robin@example.test');
    setPs(a, {});
    setPs(b, { dnc_g1: '1' });
    const { body } = await parents(`${courseA},${courseB}`);
    expect(body.addresses).toEqual([]);
    expect(body.emails).toEqual([]);
    expect(body.formatted).toBe('');
    expect(body.excluded).toBe(1);
  });

  test('feature on: a left-out guardian does not take the place of a kept one with the same address', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    const b = addStudent({ first: 'Ben', last: 'Sample' });
    // Different people sharing a mailbox: Ada's guardian is unmatched, Ben's is cleared.
    addParent(a, 'p1', 'Jordan', 'home@example.test');
    addParent(b, 'p2', 'Robin', 'home@example.test');
    addSlot(b, 1, 'Sample, Robin', 'home@example.test');
    setPs(a, {});
    setPs(b, {});
    const { body } = await parents();
    expect(body.addresses).toEqual(['home@example.test']);
    expect(body.emails[0]).toContain('Robin Sample (parent of Ben Sample)');
    expect(body.excluded).toBe(0);
  });

  test('feature on: a left-out address copied through another guardian is not counted, whatever its spacing or case', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    const b = addStudent({ first: 'Ben', last: 'Sample' });
    addParent(a, 'p1', 'Jordan', 'home@example.test');
    addParent(b, 'p2', 'Robin', ' Home@example.test ');
    addSlot(b, 1, 'Sample, Robin', 'home@example.test');
    setPs(a, {});
    setPs(b, {});
    const { body } = await parents();
    expect(body.addresses).toEqual([' Home@example.test ']);
    expect(body.excluded).toBe(0);
  });

  test('feature on: the legacy parent_email is not copied and is counted', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    const b = addStudent({ first: 'Ben', last: 'Sample' });
    getDb().prepare('UPDATE students SET parent_email = ? WHERE id = ?').run('legacy-a@example.test', a);
    getDb().prepare('UPDATE students SET parent_email = ? WHERE id = ?').run('legacy-b@example.test', b);
    const { body } = await parents();
    expect(body.addresses).toEqual([]);
    expect(body.excluded).toBe(2);
  });

  test('feature on: "both" keeps the student address and drops the flagged parent', async () => {
    on();
    const a = familyWithOneFlagged();
    getDb().prepare('UPDATE students SET email = ? WHERE id = ?').run('ada@example.test', a);
    const { body } = await get(`/api/tools/emails/${courseA}?type=both`);
    expect(body.addresses).toEqual(['ada@example.test', 'robin@example.test']);
    expect(body.excluded).toBe(1);
  });
});
