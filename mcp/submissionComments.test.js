import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../server/services/schoology.js', () => ({
  getSubmissionComments: vi.fn(), postSubmissionComment: vi.fn(), deleteSubmissionComment: vi.fn(),
  getMyUserId: vi.fn(), getSectionEnrollments: vi.fn(),
}));

import { getDb } from '../server/db/index.js';
import { getAssignmentContextTool } from './handlers.js';
import { commentDeps, resetCommentCaches } from '../server/services/submissionComments.js';

const ENV = { SCHOOLOGY_BASE_URL: 'https://api.schoology.test', SCHOOLOGY_CONSUMER_KEY: 'k', SCHOOLOGY_CONSUMER_SECRET: 's' };
let courseId; let ana; let cy;

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM submission_comments; DELETE FROM submission_comment_reads; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  resetCommentCaches();
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('8458134323', 'MGD')`).run().lastInsertRowid;
  const aid = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, '8590105935', 'Flappy Bird (F)')`).run(courseId).lastInsertRowid;
  ana = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('555', 'Ana', 'Lee')`).run().lastInsertRowid;
  cy = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('777', 'Cy', 'Ng')`).run().lastInsertRowid;
  for (const s of [ana, cy]) db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(s, courseId);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, submitted_at, submission_type) VALUES (?, ?, 1792300000, 'drop')`).run(ana, aid);
  Object.assign(commentDeps, {
    getSubmissionComments: vi.fn(async () => [
      { id: '1', uid: '555', comment: 'Revision 1 submitted\nPlaytest: my brother played 5 rounds.', created: '1792300000' },
      { id: '2', uid: '114956593', comment: 'Thank you.', created: '1792300500' },
    ]),
    getMyUserId: vi.fn(async () => '114956593'),
    getSectionEnrollments: vi.fn(async () => []),
    sleep: async () => {},
  });
});

describe('get_assignment_context submission comments', () => {
  test('refreshes submitted students first and returns their threads', async () => {
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, ENV);
    expect(ctx.submission_comments_source).toEqual({ refreshed: 1, failed: 0, cached_only: false });
    const a = ctx.students.find((s) => s.id === ana);
    expect(a.submission_comments).toEqual([
      { id: '1', author_uid: '555', author_role: 'student', created: new Date(1792300000 * 1000).toISOString(),
        text: 'Revision 1 submitted\nPlaytest: my brother played 5 rounds.', is_automatic: false,
        student_text: 'Playtest: my brother played 5 rounds.' },
      expect.objectContaining({ id: '2', author_role: 'teacher', student_text: null, is_automatic: false }),
    ]);
    expect(a.submission_comments_read_at).not.toBeNull();
    // Cy has not submitted: not read, so an empty list and read_at null.
    const c = ctx.students.find((s) => s.id === cy);
    expect(c).toMatchObject({ submission_comments: [], submission_comments_read_at: null });
  });

  test('without credentials it returns the cache and says so', async () => {
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, {});
    expect(ctx.submission_comments_source).toMatchObject({ cached_only: true, refreshed: 0 });
    expect(ctx.submission_comments_source.note).toMatch(/SCHOOLOGY_BASE_URL/);
    expect(commentDeps.getSubmissionComments).not.toHaveBeenCalled();
  });

  test('a failed read is counted and the context still returns', async () => {
    commentDeps.getSubmissionComments.mockRejectedValueOnce(new Error('Schoology API 503'));
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, ENV);
    expect(ctx.submission_comments_source).toEqual({ refreshed: 0, failed: 1, cached_only: false });
    expect(ctx.students).toHaveLength(2);
  });

  test('an unknown assignment returns null', async () => {
    expect(await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: 'nope' }, ENV)).toBeNull();
  });
});
