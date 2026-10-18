import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../server/services/schoology.js', () => ({
  getSubmissionComments: vi.fn(), postSubmissionComment: vi.fn(), deleteSubmissionComment: vi.fn(),
  getMyUserId: vi.fn(), getSectionEnrollments: vi.fn(), getSubmissionRevisions: vi.fn(), openFile: vi.fn(),
}));

import { getDb } from '../server/db/index.js';
import { getAssignmentContextTool } from './handlers.js';
import { commentDeps, resetCommentCaches } from '../server/services/submissionComments.js';
import { fileDeps, resetFileQueues } from '../server/services/submissionFiles.js';

const ENV = { SCHOOLOGY_BASE_URL: 'https://api.schoology.test', SCHOOLOGY_CONSUMER_KEY: 'k', SCHOOLOGY_CONSUMER_SECRET: 's' };
let courseId; let ana; let cy; let clock;

// The shape observed on MGD Flappy Bird (F), 17 Oct 2026 (ids and names invented).
const file = (id, name, filemime, extra = {}) => ({
  id, fid: null, type: 'file', title: name, filename: name, filesize: 179260, md5_checksum: `md5-${id}`, timestamp: 1792300000,
  filemime, extension: name.split('.').pop(), download_path: `https://api.schoology.com/v1/submission/${id}/source/${name}`, ...extra,
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM submission_comments; DELETE FROM submission_comment_reads; DELETE FROM submission_revisions; DELETE FROM submission_revision_reads; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  resetCommentCaches();
  resetFileQueues();
  clock = 1792400000;
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('8458134323', 'MGD')`).run().lastInsertRowid;
  const aid = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, '8590105935', 'Flappy Bird (F)')`).run(courseId).lastInsertRowid;
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission) VALUES (?, '8590106104', 'Color Switch', 1)`).run(courseId);
  ana = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('555', 'Ana', 'Lee')`).run().lastInsertRowid;
  cy = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('777', 'Cy', 'Ng')`).run().lastInsertRowid;
  for (const s of [ana, cy]) db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(s, courseId);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, submitted_at, submission_type) VALUES (?, ?, 1792300000, 'drop')`).run(ana, aid);
  Object.assign(commentDeps, {
    getSubmissionComments: vi.fn(async () => []), getMyUserId: vi.fn(async () => '114956593'),
    getSectionEnrollments: vi.fn(async () => []), sleep: async () => {}, now: () => clock,
  });
  Object.assign(fileDeps, {
    getSubmissionRevisions: vi.fn(async () => [
      { revision_id: 1, uid: 555, created: 1792300000, num_items: 1, late: 0, draft: 0,
        attachments: { files: { file: [file(11, 'game.zip', 'application/zip')] } } },
      { revision_id: 2, uid: 555, created: 1792390000, num_items: 2, late: 1, draft: 0,
        attachments: { files: { file: [file(21, 'game-v2.zip', 'application/zip'), file(22, 'demo.mov', 'video/quicktime')] } } },
    ]),
    sleep: async () => {}, now: () => clock,
  });
});

describe('get_assignment_context submission files (#162)', () => {
  test('reads the students who uploaded first and lists their files, newest revision first', async () => {
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, ENV);
    expect(ctx.submission_files_source).toEqual({ refreshed: 1, failed: 0, cached_only: false });
    expect(fileDeps.getSubmissionRevisions).toHaveBeenCalledTimes(1);
    const a = ctx.students.find((s) => s.id === ana);
    const at = (s) => new Date(s * 1000).toISOString();
    expect(a.submission_files).toEqual([
      { filename: 'game-v2.zip', filemime: 'application/zip', extension: 'zip', filesize: 179260, revision_id: '2', submitted_at: at(1792390000), late: true, draft: false, latest: true },
      { filename: 'demo.mov', filemime: 'video/quicktime', extension: 'mov', filesize: 179260, revision_id: '2', submitted_at: at(1792390000), late: true, draft: false, latest: true },
      { filename: 'game.zip', filemime: 'application/zip', extension: 'zip', filesize: 179260, revision_id: '1', submitted_at: at(1792300000), late: false, draft: false, latest: false },
    ]);
    expect(a.submission_files_read_at).toBe(at(clock));
    expect(JSON.stringify(ctx)).not.toContain('download_path');
    // Cy uploaded nothing: not read, so an empty list and read_at null.
    expect(ctx.students.find((s) => s.id === cy)).toMatchObject({ submission_files: [], submission_files_read_at: null });
  });

  test('a fresh cache is used without a read', async () => {
    await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, ENV);
    clock += 120;
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, ENV);
    expect(ctx.submission_files_source).toEqual({ refreshed: 0, failed: 0, cached_only: false });
    expect(fileDeps.getSubmissionRevisions).toHaveBeenCalledTimes(1);
    expect(ctx.students.find((s) => s.id === ana).submission_files).toHaveLength(3);
  });

  test('without credentials it returns the cache and says so; a failed read is counted', async () => {
    const cached = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, {});
    expect(cached.submission_files_source).toMatchObject({ cached_only: true, refreshed: 0 });
    expect(cached.submission_files_source.note).toMatch(/SCHOOLOGY_BASE_URL/);
    expect(fileDeps.getSubmissionRevisions).not.toHaveBeenCalled();
    fileDeps.getSubmissionRevisions.mockRejectedValueOnce(new Error('Schoology API 503'));
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590105935' }, ENV);
    expect(ctx.submission_files_source).toEqual({ refreshed: 0, failed: 1, cached_only: false });
  });

  test('an OneDrive task reads nothing and says why', async () => {
    const ctx = await getAssignmentContextTool(getDb(), { course_id: courseId, assignment_id: '8590106104' }, ENV);
    expect(fileDeps.getSubmissionRevisions).not.toHaveBeenCalled();
    expect(ctx.submission_files_source).toMatchObject({ refreshed: 0, cached_only: true });
    expect(ctx.submission_files_source.note).toMatch(/OneDrive/);
  });
});
