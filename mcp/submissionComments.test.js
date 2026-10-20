import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
// A feature switched off in config.yaml (null = the real config).
const h = vi.hoisted(() => ({ features: null }));
vi.mock('../server/middleware/featureGate.js', async (orig) => {
  const real = await orig();
  return { ...real, getFeatures: () => h.features ?? real.getFeatures() };
});
vi.mock('../server/services/schoology.js', () => ({
  getSubmissionComments: vi.fn(), postSubmissionComment: vi.fn(), deleteSubmissionComment: vi.fn(),
  getMyUserId: vi.fn(), getSectionEnrollments: vi.fn(),
}));

import { getDb } from '../server/db/index.js';
import { getAssignmentContextTool } from './handlers.js';
import { commentDeps, resetCommentCaches, refreshAssignment } from '../server/services/submissionComments.js';

const AT = '2026-10-20T09:58:00.000Z';
// The grading sync is the queue's (gradingSync.test.js, taskSyncRun.test.js): here it is stubbed to
// answer as it would after the run, and the thread cache is filled by the same read the run waits for.
const synced = () => vi.fn(async () => ({ state: 'synced', runId: 7, dataAsOf: AT, summary: { comments: { refreshed: 1, failed: 0 }, files: { refreshed: 0, failed: 0 } } }));
const stored = () => vi.fn(async () => ({ state: 'stored', dataAsOf: AT }));
let courseId; let ana; let cy;

beforeEach(() => {
  h.features = null;
  const db = getDb();
  db.exec('DELETE FROM submission_comments; DELETE FROM submission_comment_reads; DELETE FROM submission_revisions; DELETE FROM submission_revision_reads; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
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
      { id: '2', uid: '114956593', comment: 'Thank you.', created: '1792300500',
        attachments: { files: { file: [{ fid: 9, filename: 'Lee_Ana.png', filemime: 'image/png', filesize: 12, download_path: 'https://api.schoology.com/v1/f/a.png' }] } } },
    ]),
    getMyUserId: vi.fn(async () => '114956593'),
    getSectionEnrollments: vi.fn(async () => []),
    sleep: async () => {},
  });
});

describe('get_assignment_context submission comments', () => {
  test('lists the cached threads of the students who submitted, oldest first', async () => {
    await refreshAssignment(getDb(), '8590105935', { maxAgeSec: 0 }).done;
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, { sync: synced() });
    expect(ctx.submission_comments_source).toEqual({ refreshed: 1, failed: 0, cached_only: false });
    const a = ctx.students.find((s) => s.id === ana);
    expect(a.submission_comments).toEqual([
      { id: '1', author_uid: '555', author_role: 'student', created: new Date(1792300000 * 1000).toISOString(),
        text: 'Revision 1 submitted\nPlaytest: my brother played 5 rounds.', is_automatic: false,
        student_text: 'Playtest: my brother played 5 rounds.', attachments: [] },
      expect.objectContaining({ id: '2', author_role: 'teacher', student_text: null, is_automatic: false,
        attachments: [{ filename: 'Lee_Ana.png', filemime: 'image/png', filesize: 12 }] }),
    ]);
    expect(a.submission_comments_read_at).not.toBeNull();
    // Cy has not submitted: not read, so an empty list and read_at null.
    const c = ctx.students.find((s) => s.id === cy);
    expect(c).toMatchObject({ submission_comments: [], submission_comments_read_at: null });
  });

  test('the tool itself reads no thread: the sync did', async () => {
    await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, { sync: synced() });
    expect(commentDeps.getSubmissionComments).not.toHaveBeenCalled();
  });

  test('stored data: the cache as it is, and the source says so', async () => {
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935', use_stored_data: true }, { sync: stored() });
    expect(ctx.submission_comments_source).toEqual({ refreshed: 0, failed: 0, cached_only: true, note: `Data as of ${AT}. Sign in to Schoology for a fresh sync.` });
  });

  test('submission_comments off in config.yaml: cached only, whatever the sync did', async () => {
    h.features = { submission_comments: false, submission_files: true };
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, { sync: synced() });
    expect(ctx.submission_comments_source).toEqual({ refreshed: 0, failed: 0, cached_only: true, note: 'submission_comments is off in config.yaml' });
    expect(ctx.submission_files_source).toMatchObject({ cached_only: false });
  });

  test('an unknown assignment is NOT_FOUND from the sync step, nothing read', async () => {
    await expect(getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('get_assignment_context mastery source (#52, #131)', () => {
  test('after a sync it says the levels and comments were read, and when', async () => {
    const sync = synced();
    const db = getDb();
    const localId = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = '8590105935'`).get().id;
    // Either kind of id finds the assignment.
    for (const assignment_id of ['8590105935', localId]) {
      const ctx = await getAssignmentContextTool(db, { course_id: courseId, assignment_id }, { sync });
      expect(ctx.mastery_source).toEqual({ refreshed: true, synced_at: AT, cached_only: false });
      expect(ctx.data_as_of).toBe(AT);
    }
    expect(sync).toHaveBeenCalledWith(db, '8590105935', { useStoredData: false });
  });

  test('a fresh task (synced under 5 minutes ago) is not read again', async () => {
    getDb().prepare(`UPDATE assignments SET grading_synced_at = ? WHERE schoology_assignment_id = '8590105935'`).run(AT);
    const sync = vi.fn(async () => ({ state: 'fresh', dataAsOf: AT }));
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, { sync });
    expect(ctx.mastery_source).toEqual({ refreshed: false, synced_at: AT, cached_only: false, note: `read by the grading sync at ${AT}, under 5 minutes ago` });
    expect(ctx).not.toHaveProperty('stale_data');
  });

  test('stored data: stale_data is the first key, and the levels are as last read', async () => {
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935', use_stored_data: true }, { sync: stored() });
    expect(Object.keys(ctx)[0]).toBe('stale_data');
    expect(ctx.stale_data).toBe(`Data as of ${AT}. Sign in to Schoology for a fresh sync.`);
    expect(ctx.mastery_source).toMatchObject({ refreshed: false, synced_at: AT, cached_only: true });
    expect(ctx.data_as_of).toBe(AT);
  });
});
