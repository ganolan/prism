import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../middleware/featureGate.js', async () => {
  const real = await vi.importActual('../middleware/featureGate.js');
  return { ...real, getFeatures: vi.fn(() => ({ powerschool_alerts: true })) };
});

import { getFeatures } from '../middleware/featureGate.js';
import router from './students.js';
import { getDb } from '../db/index.js';
import { captureFeedbackSnapshots } from '../services/feedbackSnapshots.js';

async function get(path) {
  const app = express();
  app.use('/api/students', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

async function put(path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/students', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

let studentId, assignmentId;
beforeEach(() => {
  vi.mocked(getFeatures).mockReturnValue({ powerschool_alerts: true });
  const db = getDb();
  db.exec('DELETE FROM student_ps_guardians; DELETE FROM parents; DELETE FROM student_ps_alerts; DELETE FROM student_powerschool; DELETE FROM feedback_snapshots; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AIML')`).run().lastInsertRowid;
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(studentId, courseId);
  assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'a1', 'Project', 1)`).run(courseId).lastInsertRowid;
  db.prepare(`INSERT INTO grades (student_id, assignment_id, score, submitted_at, latest_revision_at) VALUES (?, ?, 80, 1000, 2000)`).run(studentId, assignmentId);
});

describe('GET /api/students/:id — resubmitted follows arrivedKeys', () => {
  const resubmitted = async () => (await get(`/api/students/${studentId}`)).body.grades.find((g) => g.assignment_id === assignmentId).resubmitted;

  test('false before a snapshot, true once captured as arrived, false once regraded', async () => {
    const db = getDb();
    expect(await resubmitted()).toBe(false);
    captureFeedbackSnapshots(db);
    expect(await resubmitted()).toBe(true);
    db.prepare('UPDATE grades SET score = 90, submitted_at = 3000').run(); // a regrade sets the grade time
    expect(await resubmitted()).toBe(false);
  });
});

describe('GET /api/students/:id — a flagged task\'s saved grade and reason line (#40)', () => {
  test('saved_level is the waiting copy\'s summary; flag_line the flag\'s status line; null otherwise', async () => {
    const db = getDb();
    db.exec('DELETE FROM excused_grades; DELETE FROM status_lines;');
    const row = async () => (await get(`/api/students/${studentId}`)).body.grades.find((g) => g.assignment_id === assignmentId);
    expect(await row()).toMatchObject({ saved_level: null, flag_line: null });
    db.prepare('UPDATE grades SET exception = 6, score = NULL').run();
    db.prepare(`INSERT INTO excused_grades (student_id, assignment_id, flag, saved_json, saved_at) VALUES (?, ?, 6, ?, '2026-10-21 02:00:00')`)
      .run(studentId, assignmentId, JSON.stringify({ score: 80, max_points: 100, topics: {}, rows: {} }));
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, 'Marked late on Wed 21/10.', 'flag')`).run(studentId, assignmentId);
    try {
      expect(await row()).toMatchObject({ saved_level: '80 / 100', flag_line: 'Marked late on Wed 21/10.' });
    } finally {
      db.exec('DELETE FROM excused_grades; DELETE FROM status_lines;');
    }
  });
});

describe('GET /api/students/:id — submission timeline per assignment', () => {
  test('each assignment row carries the timeline (late day from the stored first submission)', async () => {
    const db = getDb();
    db.exec('DELETE FROM school_days;');
    db.prepare(`UPDATE assignments SET due_date = '2026-10-06 15:00:00', is_lti_submission = 1, accepts_submissions = 1 WHERE id = ?`).run(assignmentId);
    const first = Math.floor(new Date('2026-10-08T09:00:00').getTime() / 1000); // weekday fallback: 07 = day 2, 08 = day 3
    db.prepare(`UPDATE grades SET lti_submission_state = 'submitted', first_submitted_at = ?, late = 1`).run(first);

    const { body } = await get(`/api/students/${studentId}`);
    const row = body.grades.find((g) => g.assignment_id === assignmentId);
    expect(row.timeline).toMatchObject({ due: { date: '2026-10-06' }, submission: { state: 'submitted', late: true, day: 3 } });
  });
});

// A task unpublished in Schoology after it was graded (Graham unpublished most of a past AP CSP
// section's tasks, 28 Oct 2026): the student page still lists it while the student holds a grade on it,
// and marks it. An unpublished task the student holds nothing on stays hidden.
describe('GET /api/students/:id — graded tasks unpublished in Schoology', () => {
  const titles = async () => (await get(`/api/students/${studentId}`)).body.grades.map((g) => g.assignment_title);
  const task = (sid, title) => getDb().prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title, published) SELECT course_id, ?, ?, 0 FROM assignments WHERE id = ?`
  ).run(sid, title, assignmentId).lastInsertRowid;

  test('a score, a comment, a flag, a topic level or a row level keeps it listed, marked published 0', async () => {
    const db = getDb();
    db.exec('DELETE FROM mastery_scores; DELETE FROM rubric_row_levels; DELETE FROM measurement_topics; DELETE FROM reporting_categories;');
    const scored = task('u-score', 'Scored');
    const commented = task('u-comment', 'Commented');
    const flagged = task('u-flag', 'Flagged');
    task('u-topic', 'Topic level');
    task('u-row', 'Row level');
    const blank = task('u-blank', 'Blank comment');
    task('u-none', 'No grade row');
    db.prepare('INSERT INTO grades (student_id, assignment_id, score) VALUES (?, ?, 3)').run(studentId, scored);
    db.prepare(`INSERT INTO grades (student_id, assignment_id, grade_comment) VALUES (?, ?, 'Well done')`).run(studentId, commented);
    db.prepare('INSERT INTO grades (student_id, assignment_id, exception) VALUES (?, ?, 3)').run(studentId, flagged);
    db.prepare(`INSERT INTO grades (student_id, assignment_id, grade_comment) VALUES (?, ?, '  ')`).run(studentId, blank);
    const courseId = db.prepare('SELECT course_id FROM assignments WHERE id = ?').get(assignmentId).course_id;
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('c1', ?, 'X.1', 'Cat')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'c1', ?, 'X.1.1', 'Topic')`).run(courseId);
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, grade) VALUES ('u1', 'u-topic', 't1', 'EX')`).run();
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, grade) VALUES ('other', 'u-blank', 't1', 'EX')`).run();
    db.prepare(`INSERT INTO rubric_row_levels (assignment_schoology_id, student_uid, criterion_name, level) VALUES ('u-row', 'u1', 'Design', 'D')`).run();
    try {
      const listed = await titles();
      expect(listed).toEqual(expect.arrayContaining(['Project', 'Scored', 'Commented', 'Flagged', 'Topic level', 'Row level']));
      expect(listed).not.toContain('Blank comment');
      expect(listed).not.toContain('No grade row');
      const { body } = await get(`/api/students/${studentId}`);
      expect(body.grades.find((g) => g.assignment_title === 'Scored').published).toBe(0);
      expect(body.grades.find((g) => g.assignment_title === 'Project').published).toBe(1);
    } finally {
      db.exec('DELETE FROM mastery_scores; DELETE FROM rubric_row_levels; DELETE FROM measurement_topics; DELETE FROM reporting_categories;');
    }
  });
});

describe('GET /api/students/:id — notes from a People profile (#203)', () => {
  test('a profile written before the teacher taught the student: its notes arrive on the student page', async () => {
    const db = getDb();
    db.exec('DELETE FROM people_notes; DELETE FROM people; DELETE FROM notes;');
    db.prepare("INSERT INTO people (schoology_uid, name_display, read_at, last_viewed_at) VALUES ('u1', 'Maya Chen', 'x', 'x')").run();
    db.prepare("INSERT INTO people_notes (schoology_uid, content, created_at) VALUES ('u1', 'Met at Robotics', '2026-10-01T00:00:00.000Z')").run();
    const { body } = await get(`/api/students/${studentId}`);
    expect(body.notes.map((n) => n.content)).toEqual(['Met at Robotics']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM people WHERE schoology_uid = 'u1'").get().n).toBe(0);
    db.exec('DELETE FROM notes;');
  });
});

describe('GET /api/students/:id — counselors (#190)', () => {
  test('the primary first, with the matched email; none stored is an empty list', async () => {
    const db = getDb();
    db.exec('DELETE FROM student_counselors');
    expect((await get(`/api/students/${studentId}`)).body.counselors).toEqual([]);
    const add = db.prepare("INSERT INTO student_counselors (student_id, ps_user_dcid, first_name, last_name, is_primary, email, read_at) VALUES (?, ?, ?, ?, ?, ?, 'x')");
    add.run(studentId, '72', 'Ann', 'Chan', 0, null);
    add.run(studentId, '71', 'Sam', 'Lee', 1, 'slee@hkis.edu.hk');
    expect((await get(`/api/students/${studentId}`)).body.counselors).toEqual([
      { id: '71', first_name: 'Sam', last_name: 'Lee', primary: true, email: 'slee@hkis.edu.hk' },
      { id: '72', first_name: 'Ann', last_name: 'Chan', primary: false, email: null },
    ]);
    db.exec('DELETE FROM student_counselors');
  });
});

describe('GET /api/students/:id — PowerSchool alerts (#117)', () => {
  test('ps_alerts and when they were last read; never the contact fields', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO student_ps_alerts (student_id, alert_key) VALUES (?, 'ilp')`).run(studentId);
    db.prepare(`INSERT INTO student_powerschool (student_id, alerts_synced_at, g2_deceased) VALUES (?, '2026-10-17T01:00:00.000Z', '1')`).run(studentId);
    const { body } = await get(`/api/students/${studentId}`);
    expect(body.ps_alerts).toEqual([{ key: 'ilp', label: 'ILP', category: 'learning', title: 'Individual learning plan' }]);
    expect(body.ps_alerts_synced_at).toBe('2026-10-17T01:00:00.000Z');
    expect(body).not.toHaveProperty('g2_deceased');
  });

  test('the student page gets every alert, family ones included', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO student_ps_alerts (student_id, alert_key) VALUES (?, 'siblings'), (?, 'epipen')`).run(studentId, studentId);
    const { body } = await get(`/api/students/${studentId}`);
    expect(body.ps_alerts.map((a) => [a.key, a.category])).toEqual([['epipen', 'health'], ['siblings', 'family']]);
  });

  test('never read: an empty list and no time', async () => {
    const { body } = await get(`/api/students/${studentId}`);
    expect(body.ps_alerts).toEqual([]);
    expect(body.ps_alerts_synced_at).toBeNull();
  });
});

describe('GET /api/students/:id — guardian contact status (#66)', () => {
  const SYNCED = '2026-10-21T01:00:00.000Z';
  function addFamily() {
    const db = getDb();
    db.prepare(`INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?, 'p1', 'Robin', 'Sample', 'robin@example.test'), (?, 'p2', 'Kit', 'Sample', 'kit@example.test')`).run(studentId, studentId);
    db.prepare(`INSERT INTO student_ps_guardians (student_id, slot, name, email) VALUES (?, 1, 'Sample, Robin', 'robin@example.test'), (?, 2, 'Sample, Kit', 'kit@example.test')`).run(studentId, studentId);
    db.prepare(`INSERT INTO student_powerschool (student_id, guardians_synced_at, dnc_g2, correspondence) VALUES (?, ?, '1', '1')`).run(studentId, SYNCED);
  }

  test('feature off: parents carry no contact and the body has no guardians_synced_at', async () => {
    vi.mocked(getFeatures).mockReturnValue({ powerschool_alerts: false });
    addFamily();
    const { body } = await get(`/api/students/${studentId}`);
    expect(body.parents).toHaveLength(2);
    for (const p of body.parents) expect(p).not.toHaveProperty('contact');
    expect(body).not.toHaveProperty('guardians_synced_at');
  });

  test('feature on: each parent carries contact and the body the guardian read time', async () => {
    addFamily();
    const { body } = await get(`/api/students/${studentId}`);
    const byName = Object.fromEntries(body.parents.map((p) => [p.first_name, p.contact]));
    expect(byName.Robin).toEqual({ status: 'contactable', primary: true, reason: null, ps: { email: 'robin@example.test', phone: null, slot: 1 }, email: 'robin@example.test', tel: [], copy: ['robin@example.test'] });
    expect(byName.Kit).toEqual({ status: 'do_not_contact', primary: false, reason: 'Do not contact (PowerSchool)', ps: { email: 'kit@example.test', phone: null, slot: 2 }, email: 'kit@example.test', tel: [], copy: [] });
    expect(body.guardians_synced_at).toBe(SYNCED);
  });

  test('feature on, never read: not_checked and a null guardians_synced_at', async () => {
    getDb().prepare(`INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?, 'p1', 'Robin', 'Sample', 'robin@example.test')`).run(studentId);
    const { body } = await get(`/api/students/${studentId}`);
    expect(body.parents[0].contact.status).toBe('not_checked');
    expect(body).toHaveProperty('guardians_synced_at', null);
  });
});

// #173: the PowerSchool slot's email and phone, and the teacher's extra phone and email.
describe('/api/students/:id parents: PowerSchool details and the teacher\'s additions (#173)', () => {
  const SYNCED = '2026-10-21T01:00:00.000Z';
  let robin;
  let kit;
  beforeEach(() => {
    const db = getDb();
    robin = db.prepare(`INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?, 'p1', 'Robin', 'Sample', 'robin.login@example.test')`).run(studentId).lastInsertRowid;
    kit = db.prepare(`INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email, phone, extra_email) VALUES (?, 'p2', 'Kit', 'Sample', 'kit@example.test', '5550 0199', 'kit.work@example.test')`).run(studentId).lastInsertRowid;
    db.prepare(`INSERT INTO student_ps_guardians (student_id, slot, name, email, phone) VALUES (?, 1, 'Sample, Robin', 'robin@example.test', '5550 0100'), (?, 2, 'Sample, Kit', NULL, '5550 0101')`).run(studentId, studentId);
    db.prepare(`INSERT INTO student_powerschool (student_id, guardians_synced_at) VALUES (?, ?)`).run(studentId, SYNCED);
  });
  const byName = (body) => Object.fromEntries(body.parents.map((p) => [p.first_name, p]));

  test('GET sends contact.ps', async () => {
    const { body } = await get(`/api/students/${studentId}`);
    const { Robin, Kit } = byName(body);
    expect(Robin.contact).toMatchObject({ ps: { email: 'robin@example.test', phone: '5550 0100' }, email: 'robin@example.test', copy: ['robin@example.test'] });
    expect(Robin.extra_email).toBeNull();
    expect(Kit).toMatchObject({ email: 'kit@example.test', phone: '5550 0199', extra_email: 'kit.work@example.test' });
  });

  test('a slot with no email falls back to the Schoology email: ps.email is null beside the Schoology email', async () => {
    const { Kit } = byName((await get(`/api/students/${studentId}`)).body);
    expect(Kit.contact).toMatchObject({ status: 'contactable', ps: { email: null, phone: '5550 0101' }, email: 'kit@example.test', copy: ['kit@example.test', 'kit.work@example.test'] });
    expect(Kit.email).toBe('kit@example.test');
  });

  test('feature off: no contact, but the extra email arrives on the row', async () => {
    vi.mocked(getFeatures).mockReturnValue({ powerschool_alerts: false });
    const { Kit } = byName((await get(`/api/students/${studentId}`)).body);
    expect(Kit).not.toHaveProperty('contact');
    expect(Kit.extra_email).toBe('kit.work@example.test');
  });

  test('PUT updates only the keys sent', async () => {
    let r = await put(`/api/students/${studentId}/parents/${kit}`, { extra_email: 'kit.home@example.test' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: kit, phone: '5550 0199', extra_email: 'kit.home@example.test' });
    r = await put(`/api/students/${studentId}/parents/${kit}`, { phone: '5550 0198' });
    expect(r.body).toMatchObject({ phone: '5550 0198', extra_email: 'kit.home@example.test' });
    r = await put(`/api/students/${studentId}/parents/${kit}`, { phone: '', extra_email: null });
    expect(r.body).toMatchObject({ phone: null, extra_email: null });
    r = await put(`/api/students/${studentId}/parents/${robin}`, { phone: ' 5550 0197 ', extra_email: ' robin.home@example.test ' });
    expect(r.body).toMatchObject({ phone: '5550 0197', extra_email: 'robin.home@example.test' });
    r = await put(`/api/students/${studentId}/parents/${robin}`, {});
    expect(r.body).toMatchObject({ phone: '5550 0197', extra_email: 'robin.home@example.test' });
  });

  test('PUT refuses an extra email without @', async () => {
    const r = await put(`/api/students/${studentId}/parents/${kit}`, { phone: '5550 0198', extra_email: 'kit at example' });
    expect(r).toEqual({ status: 400, body: { error: 'Extra email must be an email address' } });
    expect(getDb().prepare('SELECT phone, extra_email FROM parents WHERE id = ?').get(kit)).toEqual({ phone: '5550 0199', extra_email: 'kit.work@example.test' });
  });

  test('PUT refuses an extra email that is more than one address', async () => {
    for (const extra of ['a@example.test b@example.test', 'a@example.test;b@example.test', 'a@example.test, b@example.test', 'Kit <kit@example.test>']) {
      const r = await put(`/api/students/${studentId}/parents/${kit}`, { extra_email: extra });
      expect(r).toEqual({ status: 400, body: { error: 'Extra email must be an email address' } });
    }
    expect(getDb().prepare('SELECT extra_email FROM parents WHERE id = ?').get(kit).extra_email).toBe('kit.work@example.test');
  });

  test('PUT refuses an extra email that is not exactly one address', async () => {
    for (const extra of ['@example.test', 'kit@', 'kit@@example.test', 'kit@home@example.test', 'kit?@example.test', 'kit&kat@example.test', '"kit"@example.test', 'kit@example.test?cc=x@example.test']) {
      const r = await put(`/api/students/${studentId}/parents/${kit}`, { extra_email: extra });
      expect(r, extra).toEqual({ status: 400, body: { error: 'Extra email must be an email address' } });
    }
    expect(getDb().prepare('SELECT extra_email FROM parents WHERE id = ?').get(kit).extra_email).toBe('kit.work@example.test');
    const r = await put(`/api/students/${studentId}/parents/${kit}`, { extra_email: 'kit.o+home@mail.example.test' });
    expect(r.body).toMatchObject({ extra_email: 'kit.o+home@mail.example.test' });
  });

  test('PUT for another student\'s parent is not found', async () => {
    const r = await put(`/api/students/${studentId + 1}/parents/${kit}`, { phone: '5550 0198' });
    expect(r.status).toBe(404);
  });
});

describe('GET /api/students/:id — attendance this term (#208)', () => {
  test('each current course read, with the attendance feature on; absent with it off', async () => {
    const db = getDb();
    db.exec('DELETE FROM attendance_marks; DELETE FROM attendance_reads;');
    const courseId = db.prepare('SELECT id FROM courses').get().id;
    db.prepare(`INSERT OR REPLACE INTO attendance_codes (code, description) VALUES ('A', 'Absence')`).run();
    db.prepare(`INSERT INTO attendance_reads (course_id, from_date, to_date, read_at) VALUES (?, '2026-08-13', '2026-10-30', '2026-10-30T01:00:00Z')`).run(courseId);
    db.prepare(`INSERT INTO attendance_marks (course_id, student_id, date, code) VALUES (?, ?, '2026-10-27', 'A')`).run(courseId, studentId);
    expect((await get(`/api/students/${studentId}`)).body.attendance).toBeUndefined();
    vi.mocked(getFeatures).mockReturnValue({ powerschool_alerts: true, attendance: true });
    expect((await get(`/api/students/${studentId}`)).body.attendance).toEqual([{
      course_id: courseId, course_name: 'AIML', from: '2026-08-13', read_at: '2026-10-30T01:00:00Z', absences: 1, lates: 0, excused: 0,
      lessons: [{ date: '2026-10-27', code: 'A', description: 'Absence', kind: 'absent', office: false }],
    }]);
    db.exec('DELETE FROM attendance_marks; DELETE FROM attendance_reads;');
  });
});
