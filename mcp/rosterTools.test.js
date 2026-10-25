// #195: what the roster redesign (#160) added, for agents: gender and confirmed extra time on
// list_students and get_support_summary, get_alert_detail, get_category_check and get_test_day.
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../server/db/index.js';
import { listStudents, getSupportSummaryTool, getAlertDetailTool, getCategoryCheckTool, getTestDayTool } from './handlers.js';

let course, ana, ben, cy;
const student = (db, uid, first, last, gender) =>
  db.prepare('INSERT INTO students (schoology_uid, first_name, last_name, gender) VALUES (?, ?, ?, ?)').run(uid, first, last, gender).lastInsertRowid;

beforeEach(() => {
  const db = getDb();
  db.exec(`DELETE FROM mastery_rollups; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; DELETE FROM measurement_topics;
    DELETE FROM reporting_categories; DELETE FROM student_extra_time; DELETE FROM student_ps_alerts; DELETE FROM grades;
    DELETE FROM assignments; DELETE FROM enrolments; DELETE FROM students; DELETE FROM courses;`);
  course = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec1', 'AP Computer Science Principles')`).run().lastInsertRowid;
  ana = student(db, 'u1', 'Ana', 'Lee', 'F');
  ben = student(db, 'u2', 'Ben', 'Ng', 'X');
  cy = student(db, 'u3', 'Cy', 'Wu', null);
  for (const id of [ana, ben, cy]) db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(id, course);
});

describe('list_students: gender and confirmed extra time', () => {
  test('gender is the roster code with PowerSchool\'s own value; extra time is the confirmed figure or null', () => {
    const db = getDb();
    db.prepare(`INSERT INTO student_extra_time (student_id, percent, updated_at) VALUES (?, 25, '2026-10-25T00:00:00Z')`).run(ana);
    const rows = listStudents(db, { course_id: course });
    const by = Object.fromEntries(rows.map((r) => [r.first_name, r]));
    expect(by.Ana.gender).toEqual({ code: 'F', value: 'F' });
    expect(by.Ben.gender).toEqual({ code: 'NB', value: 'X' });
    expect(by.Cy.gender).toEqual({ code: '?', value: null });
    expect(by.Ana.extra_time_percent).toBe(25);
    expect(by.Ben.extra_time_percent).toBeNull();
  });
});

describe('get_support_summary: the confirmed figure beside PowerSchool\'s rows', () => {
  test('confirmed_extra_time_percent is Prism\'s record', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO student_extra_time (student_id, percent, updated_at) VALUES (?, 50, '2026-10-25T00:00:00Z')`).run(ana);
    const read = vi.fn(async () => ({ rows: [], readAt: '2026-10-25T00:00:00Z' }));
    const r = await getSupportSummaryTool(db, { student: ana }, { read, features: { powerschool_alerts: true } });
    expect(r.confirmed_extra_time_percent).toBe(50);
  });
});

describe('get_alert_detail', () => {
  const features = { powerschool_alerts: true };

  test('reads one roster alert and labels it for the teacher only', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO student_extra_time (student_id, percent, updated_at) VALUES (?, 25, '2026-10-25T00:00:00Z')`).run(ana);
    const read = vi.fn(async () => ({ alertKey: 'accommodation_plan', kind: 'text', text: '25% extra time on tests.', suggestedPercent: 25, readAt: '2026-10-25T01:00:00Z' }));
    const r = await getAlertDetailTool(db, { student: ana, alert: 'accommodation_plan' }, { read, features });
    expect(read).toHaveBeenCalledWith(db, ana, 'accommodation_plan');
    expect(r).toMatchObject({
      student_id: ana, alert: 'accommodation_plan', label: 'Accommodation plan', category: 'learning', kind: 'text',
      text: '25% extra time on tests.', suggested_extra_time_percent: 25, confirmed_extra_time_percent: 25, read_at: '2026-10-25T01:00:00Z',
    });
    expect(r.note).toMatch(/teacher only/i);
  });

  test('a health alert has no extra time; its rows come back verbatim', async () => {
    const read = vi.fn(async () => ({ kind: 'rows', rows: [{ category: 'Allergy', description: 'Peanuts' }], suggestedPercent: null, readAt: 'x' }));
    const r = await getAlertDetailTool(getDb(), { student: ana, alert: 'allergies' }, { read, features });
    expect(r.rows).toEqual([{ category: 'Allergy', description: 'Peanuts' }]);
    expect(r.confirmed_extra_time_percent).toBeNull();
  });

  test('a family alert or an unknown key is refused before any read', async () => {
    const read = vi.fn();
    await expect(getAlertDetailTool(getDb(), { student: ana, alert: 'divorced' }, { read, features })).rejects.toThrow(/family alerts are not served/);
    await expect(getAlertDetailTool(getDb(), { student: ana, alert: 'nope' }, { read, features })).rejects.toThrow(/alert must be one of/);
    expect(read).not.toHaveBeenCalled();
  });

  test('refused while powerschool_alerts is off', async () => {
    const read = vi.fn();
    await expect(getAlertDetailTool(getDb(), { student: ana, alert: 'allergies' }, { read, features: { powerschool_alerts: false } })).rejects.toThrow(/off/);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('get_category_check', () => {
  function seedMastery(db) {
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('c1', ?, 'APCS.1', 'AP CS: Content Knowledge'), ('c2', ?, 'APCS.2', 'AP CS: Computational Thinking Practices')`).run(course, course);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, external_id, title) VALUES ('t1', 'c1', 'APCS.1.1', 'Knowledge'), ('t2', 'c2', 'APCS.2.1', 'Design')`).run();
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'a1', 'Project', 1)`).run(course);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('a1', 't1', ?), ('a1', 't2', ?)`).run(course, course);
    const score = db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES (?, 'a1', ?, ?, ?)`);
    const rollup = db.prepare(`INSERT INTO mastery_rollups (student_uid, objective_id, course_id, is_category, grade_scaled_rounded, override_value) VALUES (?, ?, ?, 1, ?, ?)`);
    // Ana: Prism ED and EX; Schoology the same. Ben: Prism ED and EX; Schoology EX (an override) and EX.
    for (const uid of ['u1', 'u2']) { score.run(uid, 't1', 100, 'ED'); score.run(uid, 't2', 75, 'EX'); }
    rollup.run('u1', 'c1', course, 87.5, null); rollup.run('u1', 'c2', course, 62.5, null);
    rollup.run('u2', 'c1', course, 87.5, 62.5); rollup.run('u2', 'c2', course, 62.5, null);
  }

  test('lists only the students whose levels differ, with both sides, the override and both grades', () => {
    const db = getDb();
    seedMastery(db);
    const r = getCategoryCheckTool(db, { course });
    expect(r.categories).toEqual([{ category: 'CK', name: 'Content Knowledge' }, { category: 'CTP', name: 'Computational Thinking Practices' }]);
    expect(r.students_checked).toBe(3);
    expect(r.differences.map((d) => d.name)).toEqual(['Ben Ng']); // Ana matches; Cy has no evidence
    const [ben2] = r.differences;
    expect(ben2.student_id).toBe(ben);
    expect(ben2.categories[0]).toEqual({
      category: 'CK', name: 'Content Knowledge', prism_level: 'ED', prism_percent: 100, schoology_level: 'EX', schoology_override: true, differs: true,
    });
    expect(ben2.categories[1].differs).toBe(false);
    expect(ben2.prism_grade).not.toBeNull();
    expect(ben2.grade_differs).toBe(ben2.prism_grade !== ben2.schoology_grade);
  });

  test('accepts part of the course name, and refuses no course', () => {
    const db = getDb();
    expect(getCategoryCheckTool(db, { course: 'computer science' }).course_id).toBe(Number(course));
    expect(() => getCategoryCheckTool(db, {})).toThrow(/course is required/);
  });
});

describe('get_test_day', () => {
  function seedTests(db) {
    const add = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, is_test, published) VALUES (?, ?, ?, ?, ?, 1)`);
    add.run(course, 's1', 'Unit 2 Test', '2026-10-28 08:00:00', 1);
    add.run(course, 's2', 'Unit 3 Test', '2026-11-02 08:00:00', 1);
    add.run(course, 's3', 'Far Test', '2026-12-20 08:00:00', 1);
    add.run(course, 's4', 'Project', '2026-10-27 08:00:00', 0);
    db.prepare(`INSERT INTO student_ps_alerts (student_id, alert_key) VALUES (?, 'accommodation_plan'), (?, 'learning_support_1'), (?, 'allergies')`).run(ana, ben, cy);
    db.prepare(`INSERT INTO student_extra_time (student_id, percent, updated_at) VALUES (?, 25, '2026-10-25T00:00:00Z')`).run(ana);
  }

  test('the next 14 days of tests, the nearest chosen, and each learning-plan student with minutes', () => {
    const db = getDb();
    seedTests(db);
    const r = getTestDayTool(db, { course, today: '2026-10-25', length_minutes: 60 });
    expect(r.tests.map((t) => t.title)).toEqual(['Unit 2 Test', 'Unit 3 Test']);
    expect(r.test).toEqual({ schoology_assignment_id: 's1', title: 'Unit 2 Test', due_date: '2026-10-28 08:00:00' });
    expect(r.length_minutes).toBe(60);
    expect(r.students).toEqual([
      { student_id: ana, name: 'Ana Lee', plans: ['Accommodation plan'], extra_time_percent: 25, extra_minutes: 15, total_minutes: 75 },
      { student_id: ben, name: 'Ben Ng', plans: ['Learning support 1'], extra_time_percent: null, extra_minutes: null, total_minutes: null },
    ]);
  });

  test('a test chosen by part of its title; one that matches nothing is refused with the list', () => {
    const db = getDb();
    seedTests(db);
    expect(getTestDayTool(db, { course, today: '2026-10-25', test: 'unit 3' }).test.title).toBe('Unit 3 Test');
    expect(() => getTestDayTool(db, { course, today: '2026-10-25', test: 'Far' })).toThrow(/No test in the next 14 days matches "Far": tests are s1 Unit 2 Test; s2 Unit 3 Test/);
    expect(() => getTestDayTool(db, { course, today: '2026-10-25', test: 'Unit' })).toThrow(/matches several/);
  });

  test('length_minutes defaults to 50 and must be a whole number in range', () => {
    const db = getDb();
    expect(getTestDayTool(db, { course, today: '2026-10-25' }).length_minutes).toBe(50);
    expect(() => getTestDayTool(db, { course, length_minutes: 0 })).toThrow(/length_minutes/);
    expect(() => getTestDayTool(db, { course, length_minutes: 12.5 })).toThrow(/length_minutes/);
  });
});
