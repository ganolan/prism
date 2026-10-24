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
  db.exec('DELETE FROM mastery_rollups; DELETE FROM student_ps_guardians; DELETE FROM student_powerschool; DELETE FROM parents; DELETE FROM enrolments; DELETE FROM students; DELETE FROM courses;');
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

describe('GET /api/tools/emails/:courseId?students= (#160)', () => {
  test('lists just those students, ignoring the roster filters and any id not enrolled', async () => {
    const db = getDb();
    const zoe = addStudent({ first: 'Zoe', last: 'Adams' });
    const alex = addStudent({ first: 'Alexander', last: 'Chen' });
    const other = addStudent({ first: 'Olly', last: 'Other', courses: [courseB] });
    db.prepare('UPDATE students SET email = ? WHERE id = ?').run('zoe@example.com', zoe);
    db.prepare('UPDATE students SET email = ? WHERE id = ?').run('alex@example.com', alex);
    db.prepare('UPDATE students SET email = ? WHERE id = ?').run('olly@example.com', other);

    const { body } = await get(`/api/tools/emails/${courseA}?type=student&gender=F&students=${alex},${other},x`);

    expect(body.addresses).toEqual(['alex@example.com']);
    expect(body.students.map(s => s.id)).toEqual([alex]);
  });
});

// #66: guardians PowerSchool does not clear are left out of the copied list.
describe('GET /api/tools/emails/:courseId and guardian contact status', () => {
  const SYNCED = '2026-10-21T01:00:00.000Z';
  const addParent = (studentId, uid, first, email) => getDb().prepare(
    'INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)'
  ).run(studentId, uid, first, 'Sample', email).lastInsertRowid;
  const addSlot = (studentId, slot, name, email, phone = null) => getDb().prepare(
    'INSERT INTO student_ps_guardians (student_id, slot, name, email, phone) VALUES (?, ?, ?, ?, ?)'
  ).run(studentId, slot, name, email, phone);
  const setExtra = (parentId, extra) => getDb().prepare('UPDATE parents SET extra_email = ? WHERE id = ?').run(extra, parentId);
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
    addSlot(b, 1, 'Sample, Robin', null); // placed by name; no PowerSchool email, so the Schoology one is copied
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

  // #173: the PowerSchool address, and the teacher's extra email.
  test('feature on: copies the PowerSchool address instead of the Schoology one', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    addParent(a, 'p1', 'Robin', 'robin.login@example.test');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test', '5550 0100');
    setPs(a, {});
    const { body } = await parents();
    expect(body.emails).toEqual(['"Robin Sample (parent of Ada Sample)" <robin@example.test>']);
    expect(body.excluded).toBe(0);
  });

  test('feature on: a slot with no email falls back to the Schoology email', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    addParent(a, 'p1', 'Robin', 'robin.login@example.test');
    addSlot(a, 1, 'Sample, Robin', null, '5550 0100');
    setPs(a, {});
    expect((await parents()).body.addresses).toEqual(['robin.login@example.test']);
  });

  test('feature on: a parent with only a PowerSchool email is copied', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    addParent(a, 'p1', 'Robin', null);
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test');
    setPs(a, {});
    const { body } = await parents();
    expect(body.addresses).toEqual(['robin@example.test']);
    expect(body.excluded).toBe(0);
  });

  test('feature on: copies a copyable parent\'s extra email', async () => {
    on();
    const a = familyWithOneFlagged();
    const robin = getDb().prepare("SELECT id FROM parents WHERE student_id = ? AND first_name = 'Robin'").get(a).id;
    setExtra(robin, 'robin.work@example.test');
    const { body } = await parents();
    expect(body.emails).toEqual([
      '"Robin Sample (parent of Ada Sample)" <robin@example.test>',
      '"Robin Sample (parent of Ada Sample)" <robin.work@example.test>',
    ]);
    expect(body.excluded).toBe(1);
  });

  test('feature on: a left-out guardian\'s extra email is withheld and counted once', async () => {
    on();
    const a = familyWithOneFlagged();
    const kit = getDb().prepare("SELECT id FROM parents WHERE student_id = ? AND first_name = 'Kit'").get(a).id;
    setExtra(kit, 'kit.work@example.test');
    const { body } = await parents();
    expect(body.addresses).toEqual(['robin@example.test']);
    expect(body.formatted).not.toContain('kit');
    expect(body.excluded).toBe(1);
  });

  test('feature on: a left-out guardian\'s Schoology, PowerSchool and extra addresses are one guardian not copied', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    const kit = addParent(a, 'p2', 'Kit', 'kit.login@example.test');
    setExtra(kit, 'kit.work@example.test');
    addSlot(a, 2, 'Sample, Kit', 'kit@example.test');
    setPs(a, { dnc_g2: '1' });
    const { body } = await parents();
    expect(body.addresses).toEqual([]);
    expect(body.excluded).toBe(1);
  });

  test('feature off: the extra email is copied', async () => {
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    const robin = addParent(a, 'p1', 'Robin', 'robin@example.test');
    setExtra(robin, 'robin.work@example.test');
    const kit = addParent(a, 'p2', 'Kit', null);
    setExtra(kit, 'kit.work@example.test');
    const { body } = await parents();
    expect(body.addresses).toEqual(['kit.work@example.test', 'robin@example.test', 'robin.work@example.test']);
    expect(body.excluded).toBe(0);
  });

  test('feature on: a student with only a legacy parent_email is counted in a mixed class', async () => {
    on();
    familyWithOneFlagged();
    const b = addStudent({ first: 'Ben', last: 'Sample' });
    getDb().prepare('UPDATE students SET parent_email = ? WHERE id = ?').run('legacy-b@example.test', b);
    const { body } = await parents();
    expect(body.addresses).toEqual(['robin@example.test']);
    expect(body.excluded).toBe(2); // Kit and Ben's legacy address
  });

  // Controller's ruling (#173): an address a flagged guardian holds is never copied, for any guardian.
  test('feature on: a do-not-contact guardian\'s PowerSchool address is not copied through the other guardian\'s slot', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    addParent(a, 'p1', 'Robin', 'robin@example.test');
    addParent(a, 'p2', 'Kit', 'kit@example.test');
    addSlot(a, 1, 'Sample, Robin', 'family@example.test');
    addSlot(a, 2, 'Sample, Kit', 'family@example.test');
    setPs(a, { dnc_g1: '1' });
    const { body } = await parents();
    expect(body.addresses).toEqual(['kit@example.test']);
    expect(body.emails.join(' ')).not.toContain('family@');
    expect(body.formatted).not.toContain('family@');
    expect(body.excluded).toBe(1);
  });

  test('feature on: an extra email a flagged guardian holds is not copied', async () => {
    on();
    const a = familyWithOneFlagged();
    const robin = getDb().prepare("SELECT id FROM parents WHERE student_id = ? AND first_name = 'Robin'").get(a).id;
    setExtra(robin, 'KIT@example.test');
    const { body } = await parents();
    expect(body.addresses).toEqual(['robin@example.test']);
    expect(body.excluded).toBe(1);
  });

  test('feature on: a contactable guardian whose every address is blocked counts as not copied', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    addParent(a, 'p1', 'Robin', null);
    addSlot(a, 1, 'Sample, Robin', 'family@example.test');
    addSlot(a, 2, 'Other, Pat', 'family@example.test'); // deceased, and no Prism parent is this guardian
    setPs(a, { g2_deceased: '1' });
    const { body } = await parents();
    expect(body.addresses).toEqual([]);
    expect(body.excluded).toBe(1);
  });

  test('feature on: two different left-out guardians sharing an address count as two', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    const b = addStudent({ first: 'Ben', last: 'Sample' });
    addParent(a, 'p1', 'Jordan', 'home@example.test');
    addParent(b, 'p2', 'Pat', 'home@example.test');
    setPs(a, {});
    setPs(b, {});
    const { body } = await parents();
    expect(body.addresses).toEqual([]);
    expect(body.excluded).toBe(2);
  });

  test('feature on: a student whose contactable parents have no address has a legacy parent_email counted', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    addParent(a, 'p1', 'Robin', null);
    addSlot(a, 1, 'Sample, Robin', null);
    setPs(a, {});
    getDb().prepare('UPDATE students SET parent_email = ? WHERE id = ?').run('legacy-a@example.test', a);
    const { body } = await parents();
    expect(body.addresses).toEqual([]);
    expect(body.excluded).toBe(1);
  });

  test('feature on: a legacy parent_email equal to a left-out guardian\'s address counts once', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    addParent(a, 'p1', 'Robin', 'robin@example.test');
    addSlot(a, 1, 'Sample, Robin', 'robin@example.test');
    setPs(a, { dnc_g1: '1' });
    getDb().prepare('UPDATE students SET parent_email = ? WHERE id = ?').run('ROBIN@example.test', a);
    const { body } = await parents();
    expect(body.excluded).toBe(1);
  });

  test('feature on: a legacy address shared by two left-out guardians does not join them', async () => {
    on();
    const a = addStudent({ first: 'Ada', last: 'Sample' });
    const b = addStudent({ first: 'Ben', last: 'Sample' });
    const c = addStudent({ first: 'Cy', last: 'Sample' });
    addParent(a, 'p1', 'Jordan', 'home@example.test');
    addParent(b, 'p2', 'Pat', 'home@example.test');
    setPs(a, {});
    setPs(b, {});
    getDb().prepare('UPDATE students SET parent_email = ? WHERE id = ?').run('home@example.test', c);
    const { body } = await parents();
    expect(body.excluded).toBe(2);
  });
});

// #73: every tool narrows the combined roster by the same filters; /filters lists the choices.
describe('roster filters', () => {
  function seed() {
    const db = getDb();
    const set = (id, uid, gender, gradYear, email) => db.prepare(
      'UPDATE students SET schoology_uid = ?, gender = ?, grad_year = ?, email = ? WHERE id = ?',
    ).run(uid, gender, gradYear, email, id);
    const ann = addStudent({ first: 'Ann', last: 'Adams' });
    const ben = addStudent({ first: 'Ben', last: 'Burns', courses: [courseA, courseB] });
    const cat = addStudent({ first: 'Cat', last: 'Cole', courses: [courseB] });
    const year = new Date().getMonth() >= 7 ? new Date().getFullYear() + 1 : new Date().getFullYear();
    set(ann, 'u-ann', 'F', year + 3, 'ann@example.com'); // grade 9
    set(ben, 'u-ben', 'M', year + 3, 'ben@example.com'); // grade 9
    set(cat, 'u-cat', null, year, 'cat@example.com'); // grade 12, no gender
    db.prepare('INSERT INTO mastery_rollups (student_uid, course_id, objective_id, is_category, grade_percentage) VALUES (?,?,?,1,?)')
      .run('u-ann', courseA, 'c1', 90);
    db.prepare('INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?,?,?,?,?)')
      .run(ben, 'p-ben', 'Pat', 'Burns', 'pat@example.com');
    return { ann, ben, cat };
  }

  test('/filters counts each value across the selected courses', async () => {
    seed();
    const { status, body } = await get(`/api/tools/filters/${courseA},${courseB}`);
    expect(status).toBe(200);
    expect(body).toEqual({
      total: 3,
      matched: 3,
      facets: {
        gender: [{ value: 'F', count: 1 }, { value: 'M', count: 1 }, { value: 'none', count: 1 }],
        grade: [{ value: '9', count: 2 }, { value: '12', count: 1 }],
        level: [{ value: 'ED', count: 1 }, { value: 'none', count: 2 }],
      },
    });
    const narrowed = await get(`/api/tools/filters/${courseA},${courseB}?grade=9&gender=M`);
    expect(narrowed.body).toMatchObject({ total: 3, matched: 1 });
    expect(narrowed.body.facets.gender).toHaveLength(3); // facets still count everyone
  });

  test('roster, random and groups keep only matching students, and send no filter facts', async () => {
    seed();
    const both = `${courseA},${courseB}`;
    const roster = await get(`/api/tools/roster/${both}?gender=F,none`);
    expect(roster.body.students.map((s) => s.first_name)).toEqual(['Ann', 'Cat']);
    expect(roster.body.students[0]).not.toHaveProperty('gender');
    const random = await get(`/api/tools/random/${both}?count=5&grade=9`);
    expect(random.body.total).toBe(2);
    expect(random.body.picked.map((s) => s.first_name).sort()).toEqual(['Ann', 'Ben']);
    const groups = await get(`/api/tools/groups/${both}?count=2&level=ED`);
    expect(groups.body.groups.flat().map((s) => s.first_name)).toEqual(['Ann']);
  });

  test('emails: a filtered-out student\'s parents are left out too', async () => {
    seed();
    const kept = await get(`/api/tools/emails/${courseA},${courseB}?type=both&gender=F`);
    expect(kept.body.addresses).toEqual(['ann@example.com']);
    const ben = await get(`/api/tools/emails/${courseA},${courseB}?type=both&gender=M`);
    expect(ben.body.addresses).toEqual(['ben@example.com', 'pat@example.com']);
  });
});
