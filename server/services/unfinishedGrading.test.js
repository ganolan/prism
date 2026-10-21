import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
// The /assessment/ route (for the draft parity check) imports these; none run here.
vi.mock('./masterySync.js', () => ({
  hasMasterySession: () => true, syncMasteryForCourse: vi.fn(), syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn(), writeMasteryScoresBatch: vi.fn(), writeMasteryOverride: vi.fn(),
  getMasteryForCourse: vi.fn(), getRubricScoresForStudent: vi.fn(), interactiveLogin: vi.fn(),
}));
vi.mock('./schoology.js', () => ({ pushGradeComments: vi.fn(), getSectionGrades: vi.fn() }));
vi.mock('./oneDriveLinks.js', () => ({ getAssignmentFiles: vi.fn() }));

import { getDb } from '../db/index.js';
import masteryRouter from '../routes/mastery.js';
import { draftBaseline } from '../../client/src/lib/assessmentDraft.js';
import { getUnfinishedGrading, UNFINISHED_GRADING_REASONS } from './unfinishedGrading.js';
import { markSeen } from './submissionCommentStore.js';

let db, courseId, n;
function student(uid, first, { dropped = false } = {}) {
  const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, 'X')`).run(uid, first).lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?, ?, ?)`).run(id, courseId, dropped ? '2026-09-10' : null);
  return id;
}
function assignment(title, { summative = true } = {}) {
  n += 1;
  const sid = `sa-${n}`;
  const id = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, published) VALUES (?, ?, ?, '2026-10-12 15:00:00', 1)`)
    .run(courseId, sid, title).lastInsertRowid;
  if (summative) {
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES (?, 'cat-1', ?, ?, 'T')`).run(`topic-${sid}`, courseId, `X.${n}`);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES (?, ?, ?)`).run(sid, `topic-${sid}`, courseId);
  }
  return { id, sid };
}
const grade = (sid, aid, cols) => {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(sid, aid, ...keys.map((k) => cols[k]));
};
const saveDraft = (aid, sid, base, updatedAt = '2026-10-10 02:00:00') => db.prepare(
  `INSERT INTO assessment_drafts (assignment_id, student_id, draft_json, updated_at) VALUES (?, ?, ?, ?)`,
).run(aid, sid, JSON.stringify({ pending: { t: 'EX' }, comment: 'Draft', base }), updatedAt);

// The /assessment/ card's own baseline for a student, from the page's real payload.
async function cardBase(sa, uid) {
  const app = express();
  app.use('/api/mastery', masteryRouter);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}/api/mastery/${courseId}/assignment/${sa}`);
    const body = await res.json();
    const s = body.students.find((x) => x.schoology_uid === uid);
    return draftBaseline(s, body.scoreScale ? [] : body.topics, { includeScore: !!body.scoreScale, rowLevels: body.scoreScale ? s.row_levels : undefined });
  } finally {
    server.close();
  }
}

beforeEach(() => {
  db = getDb();
  db.exec(
    'DELETE FROM submission_comment_seen; DELETE FROM submission_comments; DELETE FROM submission_comment_reads; DELETE FROM assessment_drafts; DELETE FROM status_lines; DELETE FROM mastery_scores; DELETE FROM mastery_alignments; ' +
    'DELETE FROM assignment_assignees; DELETE FROM grades; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
    'DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;',
  );
  n = 0;
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, block_number) VALUES ('sec-1', 'AP CSP', '7')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'X', 'Cat')`).run(courseId);
});

describe('getUnfinishedGrading: Prism drafts', () => {
  test('a live draft counts (same baseline as the card); one Schoology changed under is stale', async () => {
    const maya = student('u1', 'Maya');
    const a = assignment('CPT 2');
    grade(maya, a.id, { grade_comment: 'Good start.', comment_status: 1 });
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', ?, ?, 75, 'EX')`).run(a.sid, `topic-${a.sid}`);
    saveDraft(a.id, maya, await cardBase(a.sid, 'u1'));

    expect(getUnfinishedGrading(db)).toEqual([expect.objectContaining({
      courseName: 'AP CSP', blockNumber: '7', title: 'CPT 2', schoologyAssignmentId: a.sid, aligned: true,
      drafts: 1, feedbackHidden: 0, oldestDraftOn: '2026-10-10',
      students: [{ studentId: maya, studentName: 'Maya X', reasons: ['draft'] }],
    })]);

    db.prepare(`UPDATE grades SET grade_comment = 'Changed in Schoology.' WHERE student_id = ?`).run(maya);
    expect(getUnfinishedGrading(db)).toEqual([]);
  });

  test('a dropped student\'s draft is left out', async () => {
    const bo = student('u2', 'Bo', { dropped: true });
    const a = assignment('CPT 2');
    saveDraft(a.id, bo, 'anything');
    expect(getUnfinishedGrading(db)).toEqual([]);
  });
});

describe('getUnfinishedGrading: unread student comments', () => {
  test('a student comment with typed text since the thread was last opened counts; seeing it clears it', async () => {
    const ana = student('u1', 'Ana');
    const a = assignment('Brick Breaker');
    const add = (id, body, created) => db.prepare(
      `INSERT INTO submission_comments (schoology_comment_id, assignment_id, student_id, author_uid, author_role, body, created) VALUES (?, ?, ?, 'u1', 'student', ?, ?)`,
    ).run(id, a.id, ana, body, created);
    add('1', 'Revision 1 submitted', 100); // automatic: never unread
    expect(getUnfinishedGrading(db)).toEqual([]);
    add('2', 'I fixed the loop, can you check?', 200);
    expect(getUnfinishedGrading(db)[0]).toMatchObject({ unreadComments: 1, students: [{ studentName: 'Ana X', reasons: ['unread_comment'] }] });
    markSeen(db, { assignmentId: a.id, studentId: ana });
    expect(getUnfinishedGrading(db)).toEqual([]);
  });
});

describe('getUnfinishedGrading: feedback hidden and several reasons', () => {
  test('hidden = a teacher comment the student cannot see (not exempt or absent, not a status line alone)', () => {
    const ids = ['Ana', 'Ben', 'Cal', 'Dee', 'Eve', 'Fay'].map((name, i) => student(`u${i}`, name));
    const a = assignment('Brick Breaker');
    grade(ids[0], a.id, { grade_comment: 'Nice work.', comment_status: null }); // hidden
    grade(ids[1], a.id, { grade_comment: 'Nice work.', comment_status: 1 }); // visible
    grade(ids[2], a.id, { grade_comment: 'Nice work.', comment_status: 0, exception: 1 }); // excused
    grade(ids[3], a.id, { grade_comment: '', comment_status: 0 }); // nothing to show
    grade(ids[4], a.id, { grade_comment: 'Resubmission requested - due Thu 15/10.', comment_status: 0 });
    grade(ids[5], a.id, { grade_comment: 'Nice work.', comment_status: 0, exception: 5 }); // absent, like exempt
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, 'Resubmission requested - due Thu 15/10.', 'ask')`).run(ids[4], a.id);
    const [row] = getUnfinishedGrading(db);
    expect(row).toMatchObject({ feedbackHidden: 1, drafts: 0 });
    expect(row).not.toHaveProperty('flagged');
    expect(row.students.map((s) => s.studentName)).toEqual(['Ana X']);
  });

  test('the reasons are draft, feedback_hidden and unread_comment (Flag for review is gone, #40)', () => {
    expect(UNFINISHED_GRADING_REASONS).toEqual(['draft', 'feedback_hidden', 'unread_comment']);
  });

  test('several tasks, and the student filter recounts', () => {
    const ana = student('u1', 'Ana');
    const ben = student('u2', 'Ben');
    const a = assignment('Notebook 4');
    grade(ana, a.id, { grade_comment: 'Check sources.', comment_status: 0 });
    grade(ben, a.id, { grade_comment: 'Fine.', comment_status: 0 });
    expect(getUnfinishedGrading(db)[0]).toMatchObject({
      feedbackHidden: 2,
      students: [
        { studentName: 'Ana X', reasons: ['feedback_hidden'] },
        { studentName: 'Ben X', reasons: ['feedback_hidden'] },
      ],
    });
    expect(getUnfinishedGrading(db, { studentId: ben })[0]).toMatchObject({ feedbackHidden: 1, students: [{ studentName: 'Ben X' }] });
  });

  test('tasks with drafts first (oldest first), then the most unfinished grading; archived courses are left out', async () => {
    const ana = student('u1', 'Ana');
    const ben = student('u2', 'Ben');
    const single = assignment('A one hidden');
    const busy = assignment('B two hidden');
    const drafted = assignment('C drafted', { summative: false });
    grade(ana, single.id, { grade_comment: 'Only one.', comment_status: 0 });
    grade(ana, busy.id, { grade_comment: 'One.', comment_status: 0 });
    grade(ben, busy.id, { grade_comment: 'Two.', comment_status: 0 });
    saveDraft(drafted.id, ana, await cardBase(drafted.sid, 'u1'));
    expect(getUnfinishedGrading(db).map((r) => r.title)).toEqual(['C drafted', 'B two hidden', 'A one hidden']);
    db.prepare('UPDATE courses SET archived = 1').run();
    expect(getUnfinishedGrading(db)).toEqual([]);
  });
});
