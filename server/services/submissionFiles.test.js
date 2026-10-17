import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
// Every Schoology call goes through fileDeps, replaced below; never for real.
vi.mock('./schoology.js', () => ({ getSubmissionRevisions: vi.fn(), openFile: vi.fn() }));

import { getDb } from '../db/index.js';
import { fileDeps, revisionsFor, openSubmissionFile, FileError } from './submissionFiles.js';
import { readRevisions, fileSummariesForAssignment } from './submissionFileStore.js';

let clock;
let revisions; // uid → raw Schoology revisions

// The shape observed on MGD Flappy Bird (F), 17 Oct 2026 (ids and names invented).
const file = (id, name, extra = {}) => ({
  id, fid: null, type: 'file', title: name, filename: name, filesize: 179260, md5_checksum: `md5-${id}`, timestamp: 1792300000,
  filemime: 'application/zip', extension: 'zip', download_path: `https://api.schoology.com/v1/submission/${id}/source/${name}`, ...extra,
});

function seed(db, { lti = 0 } = {}) {
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('8458134323', 'MGD')`).run().lastInsertRowid;
  const assignmentId = db.prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission) VALUES (?, '8590105935', 'Flappy Bird (F)', ?)`,
  ).run(courseId, lti).lastInsertRowid;
  const mk = (uid, first) => {
    const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, 'Lee')`).run(uid, first).lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(id, courseId);
    return id;
  };
  return { courseId, assignmentId, ana: mk('555', 'Ana'), cy: mk('777', 'Cy') };
}

beforeEach(() => {
  getDb().exec(
    'DELETE FROM submission_revisions; DELETE FROM submission_revision_reads; DELETE FROM grades; ' +
    'DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;',
  );
  clock = 1792400000;
  revisions = {
    555: [
      { revision_id: 1, uid: 555, created: 1792300000, num_items: 2, late: 0, draft: 0,
        attachments: { files: { file: [file(11, 'game.zip'), file(12, 'demo.mov', {
          filemime: 'video/quicktime', extension: 'mov', converted_status: '1', converted_type: 1, converted_filename: 'demo.mp4',
          converted_extension: 'mp4', converted_filemime: 'video/mp4', converted_filesize: 1082365, converted_md5_checksum: 'c-md5',
          converted_download_path: 'https://api.schoology.com/v1/submission/12/conversion/demo.mp4',
        })] } } },
      { revision_id: 2, uid: 555, created: 1792390000, num_items: 1, late: 1, draft: 0,
        attachments: { files: { file: [file(21, 'game-v2.zip')] } } },
    ],
  };
  Object.assign(fileDeps, {
    getSubmissionRevisions: vi.fn(async (_s, _a, uid) => [...(revisions[uid] || [])]),
    openFile: vi.fn(async () => ({ status: 200, contentType: 'application/zip', contentLength: 7, body: new Response('ZIPDATA').body })),
    now: () => clock,
  });
});

describe('revisionsFor', () => {
  test('reads every revision with its files, newest first, and caches them', async () => {
    const db = getDb(); const { ana } = seed(db);
    const r = await revisionsFor(db, { assignmentId: '8590105935', studentId: ana });
    expect(fileDeps.getSubmissionRevisions).toHaveBeenCalledWith('8458134323', '8590105935', '555');
    expect(r.revisions.map((x) => x.revision_id)).toEqual(['2', '1']);
    expect(r.revisions[0]).toMatchObject({ late: true, draft: false, created: new Date(1792390000 * 1000).toISOString() });
    expect(r.revisions[1].files).toEqual([
      { id: 11, filename: 'game.zip', title: 'game.zip', filesize: 179260, filemime: 'application/zip', extension: 'zip', converted: null },
      expect.objectContaining({ id: 12, filemime: 'video/quicktime', converted: { filesize: 1082365, filemime: 'video/mp4', extension: 'mp4' } }),
    ]);
    // The download path stays on the server.
    expect(JSON.stringify(r)).not.toContain('download_path');
    expect(r.summary).toEqual({ revisions: 2, files: 3 });
    expect(r.read_at).toBe(new Date(clock * 1000).toISOString());
  });

  test('a fresh cache is served without a call; force or age re-reads', async () => {
    const db = getDb(); const { ana } = seed(db);
    await revisionsFor(db, { assignmentId: '8590105935', studentId: ana });
    clock += 60;
    await revisionsFor(db, { assignmentId: '8590105935', studentId: ana });
    expect(fileDeps.getSubmissionRevisions).toHaveBeenCalledTimes(1);
    await revisionsFor(db, { assignmentId: '8590105935', studentId: ana, force: true });
    clock += 400;
    await revisionsFor(db, { assignmentId: '8590105935', studentId: ana });
    expect(fileDeps.getSubmissionRevisions).toHaveBeenCalledTimes(3);
  });

  test('a refresh replaces the cached revisions', async () => {
    const db = getDb(); const { ana, assignmentId } = seed(db);
    await revisionsFor(db, { assignmentId: '8590105935', studentId: ana });
    revisions[555] = [revisions[555][0]];
    const r = await revisionsFor(db, { assignmentId: '8590105935', studentId: ana, force: true });
    expect(r.revisions.map((x) => x.revision_id)).toEqual(['1']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM submission_revisions WHERE assignment_id = ?').get(assignmentId).n).toBe(1);
  });

  test('a failed read keeps the cache and reports the error', async () => {
    const db = getDb(); const { ana } = seed(db);
    await revisionsFor(db, { assignmentId: '8590105935', studentId: ana });
    fileDeps.getSubmissionRevisions.mockRejectedValueOnce(new Error('Schoology API 503'));
    const r = await revisionsFor(db, { assignmentId: '8590105935', studentId: ana, force: true });
    expect(r.revisions).toHaveLength(2);
    expect(r.error).toMatch(/503/);
  });

  test('no revisions is stored as read, not as never read; summaries feed the chips', async () => {
    const db = getDb(); const { ana, cy, assignmentId } = seed(db);
    const r = await revisionsFor(db, { assignmentId: '8590105935', studentId: cy });
    expect(r.revisions).toEqual([]);
    expect(readRevisions(db, { assignmentId, studentId: cy }).read_at).not.toBeNull();
    await revisionsFor(db, { assignmentId: '8590105935', studentId: ana });
    const s = fileSummariesForAssignment(db, assignmentId);
    expect(s[ana]).toMatchObject({ revisions: 2, files: 3 });
    expect(s[cy]).toMatchObject({ revisions: 0, files: 0 });
  });

  test('an OneDrive task and a student outside the course are refused without a call', async () => {
    const db = getDb(); seed(db, { lti: 1 });
    const ana = db.prepare(`SELECT id FROM students WHERE schoology_uid = '555'`).get().id;
    await expect(revisionsFor(db, { assignmentId: '8590105935', studentId: ana })).rejects.toMatchObject({ code: 'NOT_NATIVE', status: 409 });
    const stranger = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('999', 'X', 'Y')`).run().lastInsertRowid;
    await expect(revisionsFor(db, { assignmentId: '8590105935', studentId: stranger })).rejects.toBeInstanceOf(FileError);
    expect(fileDeps.getSubmissionRevisions).not.toHaveBeenCalled();
  });
});

describe('openSubmissionFile', () => {
  test('opens a cached file through the signed path', async () => {
    const db = getDb(); const { ana } = seed(db);
    await revisionsFor(db, { assignmentId: '8590105935', studentId: ana });
    const f = await openSubmissionFile(db, { assignmentId: '8590105935', studentId: ana, revisionId: '2', fileId: '21' });
    expect(fileDeps.openFile).toHaveBeenCalledWith('https://api.schoology.com/v1/submission/21/source/game-v2.zip', { range: null });
    expect(f).toMatchObject({ status: 200, filename: 'game-v2.zip', filemime: 'application/zip', filesize: 7, contentRange: null });
    expect(await new Response(f.body).text()).toBe('ZIPDATA');
  });

  test('the converted copy, with a range passed on; a file with no converted copy is a 404', async () => {
    const db = getDb(); const { ana } = seed(db);
    await revisionsFor(db, { assignmentId: '8590105935', studentId: ana });
    fileDeps.openFile.mockResolvedValueOnce({ status: 206, contentType: 'video/mp4', contentLength: 100, contentRange: 'bytes 0-99/1082365', body: new Response('x').body });
    const f = await openSubmissionFile(db, { assignmentId: '8590105935', studentId: ana, revisionId: '1', fileId: '12', copy: 'converted', range: 'bytes=0-99' });
    expect(fileDeps.openFile).toHaveBeenCalledWith('https://api.schoology.com/v1/submission/12/conversion/demo.mp4', { range: 'bytes=0-99' });
    expect(f).toMatchObject({ status: 206, filename: 'demo.mp4', filemime: 'video/mp4', contentRange: 'bytes 0-99/1082365' });
    await expect(openSubmissionFile(db, { assignmentId: '8590105935', studentId: ana, revisionId: '1', fileId: '11', copy: 'converted' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    fileDeps.openFile.mockResolvedValueOnce({ status: 416, body: null });
    await expect(openSubmissionFile(db, { assignmentId: '8590105935', studentId: ana, revisionId: '1', fileId: '12', range: 'bytes=999999999-' }))
      .rejects.toMatchObject({ code: 'RANGE', status: 416 });
  });

  test('a file of another revision or an unknown id is a 404; a refused download is a 502', async () => {
    const db = getDb(); const { ana } = seed(db);
    await revisionsFor(db, { assignmentId: '8590105935', studentId: ana });
    await expect(openSubmissionFile(db, { assignmentId: '8590105935', studentId: ana, revisionId: '2', fileId: '11' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    const cancel = vi.fn(async () => {});
    fileDeps.openFile.mockResolvedValueOnce({ status: 403, body: { cancel } });
    await expect(openSubmissionFile(db, { assignmentId: '8590105935', studentId: ana, revisionId: '1', fileId: '11' }))
      .rejects.toMatchObject({ code: 'SCHOOLOGY', status: 502 });
    expect(cancel).toHaveBeenCalled();
  });
});
