import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { addDays, isWeekday } from '../lib/schoolDays.js';
import { storeSchoolDays } from './schoolCalendar.js';
import { requestResubmission } from './resubmissions.js';
import { recordReferral } from './triage.js';
import { attentionByStudent } from './cardAttention.js';

const TODAY = '2026-10-16'; // Fri

// Calendar 01/09 to 30/10/2026: weekdays in session except 01/10 + 02/10 (as triage.test.js).
function seedCalendar(db) {
  const days = [];
  for (let d = '2026-09-01'; d <= '2026-10-30'; d = addDays(d, 1)) {
    const off = !isWeekday(d) || d === '2026-10-01' || d === '2026-10-02';
    days.push({ date: d, inSession: !off, cycleLetter: null, raw: '{}' });
  }
  storeSchoolDays(db, days, '2026-10-01T00:00:00Z');
}

let db, courseId, n;
function student(uid, first) {
  const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, 'X')`).run(uid, first).lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(id, courseId);
  return { id, schoology_uid: uid };
}
function assignment(due, { summative = true, lti = 0, accepts = 1, published = 1 } = {}) {
  n += 1;
  const sid = `a${n}`;
  const id = db.prepare(`
    INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, is_lti_submission, published, accepts_submissions)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(courseId, sid, `Task ${n}`, `${due} 15:30:00`, lti, published, accepts).lastInsertRowid;
  if (summative) {
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES (?, 'cat-1', ?, ?, 'T')`).run(`topic-${sid}`, courseId, `X.${n}`);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES (?, ?, ?)`).run(sid, `topic-${sid}`, courseId);
  }
  return db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
}
function grade(studentId, assignmentId, cols) {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(studentId, assignmentId, ...keys.map((k) => cols[k]));
}
const reasonsFor = (a, students) => {
  const m = attentionByStudent(db, { assignment: a, students, today: TODAY });
  return students.map((s) => m.get(s.id).reasons);
};

beforeEach(() => {
  db = getDb();
  db.exec(
    'DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM referrals; DELETE FROM extensions; DELETE FROM resubmissions; DELETE FROM settings; DELETE FROM school_days; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; ' +
    'DELETE FROM assignment_assignees; DELETE FROM grades; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
    'DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses; DELETE FROM sync_log;',
  );
  n = 0;
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AP CSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'X', 'Cat')`).run(courseId);
  seedCalendar(db);
});

describe('attentionByStudent: late work (summative)', () => {
  test('at the referral limit → referral; before it → late with the school-day count', () => {
    const maya = student('u1', 'Maya');
    const old = assignment('2026-10-05'); // 06 to 16/10 = 9 school days
    const recent = assignment('2026-10-12'); // 13 to 16/10 = 4 school days
    expect(reasonsFor(old, [maya])[0]).toEqual([{ id: 'referral', kind: 'outstanding', daysLate: 9, tone: 'red' }]);
    expect(reasonsFor(recent, [maya])[0]).toEqual([{ id: 'late', daysLate: 4, tone: 'green' }]);
  });

  test('a referred pair needs no decision', () => {
    const maya = student('u1', 'Maya');
    const a = assignment('2026-10-05');
    recordReferral(db, { studentId: maya.id, assignmentId: a.id, action: 'referred', today: TODAY });
    expect(reasonsFor(a, [maya])[0]).toEqual([]);
  });

  test('excused students, and submitted work, are left out', () => {
    const maya = student('u1', 'Maya');
    const bo = student('u2', 'Bo');
    const a = assignment('2026-10-12');
    grade(maya.id, a.id, { exception: 1 });
    grade(bo.id, a.id, { submission_type: 'drop', submitted_at: 1, late: 0 });
    expect(reasonsFor(a, [maya, bo])).toEqual([[], []]);
  });
});

describe('attentionByStudent: OneDrive / Google Drive watch reasons', () => {
  test('opened but not submitted after the due date → in progress, late (summative and formative)', () => {
    const maya = student('u1', 'Maya');
    const summ = assignment('2026-10-12', { lti: 1 });
    const form = assignment('2026-10-12', { lti: 1, summative: false });
    grade(maya.id, summ.id, { lti_submission_state: 'in_progress' });
    grade(maya.id, form.id, { lti_submission_state: 'in_progress' });
    expect(reasonsFor(summ, [maya])[0]).toEqual([{ id: 'in_progress_late', daysLate: 4, tone: 'green' }]);
    expect(reasonsFor(form, [maya])[0]).toEqual([{ id: 'in_progress_late', daysLate: 4, tone: 'green' }]);
  });

  test('never opened with the due date within 3 school days → not started, due soon', () => {
    const maya = student('u1', 'Maya');
    const soon = assignment('2026-10-20', { lti: 1 }); // Mon 19, Tue 20 → 2 school days left
    const later = assignment('2026-10-28', { lti: 1 });
    grade(maya.id, soon.id, { lti_submission_state: 'not_started' });
    grade(maya.id, later.id, { lti_submission_state: 'not_started' });
    expect(reasonsFor(soon, [maya])[0]).toEqual([{ id: 'not_started_soon', schoolDaysLeft: 2, tone: 'amber' }]);
    expect(reasonsFor(later, [maya])[0]).toEqual([]);
  });

  test('an extension moves the due date the watch reasons count from', () => {
    const maya = student('u1', 'Maya');
    const a = assignment('2026-10-12', { lti: 1, summative: false });
    grade(maya.id, a.id, { lti_submission_state: 'in_progress' });
    db.prepare(`INSERT INTO extensions (student_id, assignment_id, course_id, lessons, until) VALUES (?, ?, ?, 5, '2026-10-19')`).run(maya.id, a.id, courseId);
    expect(reasonsFor(a, [maya])[0]).toEqual([]);
  });
});

describe('attentionByStudent: resubmissions', () => {
  const sqlAt = (iso) => `${iso} 04:00:00`;
  test('waiting past the deadline → overdue; before it → pending', () => {
    const maya = student('u1', 'Maya');
    const bo = student('u2', 'Bo');
    const a = assignment('2026-09-21');
    grade(maya.id, a.id, { score: 60, submitted_at: 1758700000, submission_type: 'drop' });
    grade(bo.id, a.id, { score: 60, submitted_at: 1758700000, submission_type: 'drop' });
    requestResubmission(db, { studentId: maya.id, assignmentId: a.id, lessons: 3, requestedAt: sqlAt('2026-10-09') });
    requestResubmission(db, { studentId: bo.id, assignmentId: a.id, lessons: 3, requestedAt: sqlAt('2026-10-15') });
    const [m, b] = reasonsFor(a, [maya, bo]);
    expect(m).toEqual([{ id: 'resubmission_overdue', until: '2026-10-14', tone: 'red' }]);
    expect(b).toEqual([expect.objectContaining({ id: 'resubmission_pending', until: '2026-10-20' })]);
  });
});

describe('attentionByStudent: make-up tests and handed in', () => {
  test('a missed test → make-up; handedIn follows triage (test attempt, paper work after the due date)', () => {
    const maya = student('u1', 'Maya');
    const bo = student('u2', 'Bo');
    const t = assignment('2026-10-15', { accepts: 0 });
    db.prepare(`UPDATE assignments SET is_test = 1, test_fetch_status = 'ok', due_date = '2026-10-15 14:00:00' WHERE id = ?`).run(t.id);
    grade(maya.id, t.id, { test_attempt: 'none' });
    grade(bo.id, t.id, { submission_type: 'assessment', test_attempt: 'took' });
    const test = db.prepare('SELECT * FROM assignments WHERE id = ?').get(t.id);
    const m = attentionByStudent(db, { assignment: test, students: [maya, bo], today: TODAY });
    expect(m.get(maya.id)).toEqual({ handedIn: false, reasons: [{ id: 'make_up', daysSince: 1, tone: 'amber' }] });
    expect(m.get(bo.id)).toEqual({ handedIn: true, reasons: [] });

    const paper = assignment('2026-10-12', { accepts: 0, summative: false });
    expect(attentionByStudent(db, { assignment: paper, students: [maya], today: TODAY }).get(maya.id).handedIn).toBe(true);
  });

  test('archived courses and unpublished assignments get no calendar reasons', () => {
    const maya = student('u1', 'Maya');
    const draft = assignment('2026-10-05', { published: 0 });
    expect(reasonsFor(draft, [maya])[0]).toEqual([]);
    const a = assignment('2026-10-05');
    db.prepare('UPDATE courses SET archived = 1 WHERE id = ?').run(courseId);
    expect(reasonsFor(a, [maya])[0]).toEqual([]);
  });
});
