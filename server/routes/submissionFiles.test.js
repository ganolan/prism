import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../services/schoology.js', () => ({ getSubmissionRevisions: vi.fn(), openFile: vi.fn() }));

import router from './submissionFiles.js';
import { getDb } from '../db/index.js';
import { fileDeps, resetFileQueues } from '../services/submissionFiles.js';

async function call(path, headers = {}) {
  const app = express();
  app.use('/api/submission-files', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, { headers });
    const type = res.headers.get('content-type') || '';
    return {
      status: res.status, headers: res.headers,
      body: type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer()),
    };
  } finally { server.close(); }
}

const rev = (id, files) => ({
  revision_id: id, uid: 555, created: 1792300000 + id, num_items: files.length, late: 0, draft: 0,
  attachments: { files: { file: files } },
});
const file = (id, filename, filemime) => ({
  id, fid: null, title: filename, filename, filesize: 7, filemime, md5_checksum: 'x', extension: filename.split('.').pop(),
  download_path: `https://api.schoology.com/v1/submission/${id}/source/${filename}`,
});

let studentId;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM submission_revisions; DELETE FROM submission_revision_reads; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec', 'MGD')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, '8590105935', 'Flappy')`).run(courseId);
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission) VALUES (?, '8590106104', 'Color Switch', 1)`).run(courseId);
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('555', 'Ana', 'Lee')`).run().lastInsertRowid;
  db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(studentId, courseId);
  Object.assign(fileDeps, {
    getSubmissionRevisions: vi.fn(async () => [
      rev(1, [file(11, 'game.zip', 'application/zip')]),
      rev(2, [file(21, 'shot.png', 'image/png'), file(22, 'page.html', 'text/html'), {
        ...file(23, 'demo.mov', 'video/quicktime'), converted_status: '1', converted_filename: 'demo.mp4', converted_filemime: 'video/mp4',
        converted_extension: 'mp4', converted_filesize: 100, converted_download_path: 'https://api.schoology.com/v1/submission/23/conversion/demo.mp4',
      }]),
    ]),
    openFile: vi.fn(async () => ({ status: 200, contentType: 'x', contentLength: 7, body: new Response('BODYDAT').body })),
    now: () => 1792400000,
    sleep: async () => {},
  });
  resetFileQueues();
});

describe('/api/submission-files', () => {
  test('GET a student: revisions newest first, then the assignment summaries from the cache', async () => {
    const r = await call(`/api/submission-files/8590105935/${studentId}`);
    expect(r.status).toBe(200);
    expect(r.body.revisions.map((x) => x.revision_id)).toEqual(['2', '1']);
    expect(r.body.summary).toEqual({ revisions: 2, files: 4 });
    const s = await call('/api/submission-files/assignment/8590105935');
    expect(s.body.students[studentId]).toMatchObject({ revisions: 2, files: 4 });
    expect(fileDeps.getSubmissionRevisions).toHaveBeenCalledTimes(1);
    await call(`/api/submission-files/8590105935/${studentId}?refresh=1`);
    expect(fileDeps.getSubmissionRevisions).toHaveBeenCalledTimes(2);
  });

  test('a file streams through with its name; an image opens inline, HTML downloads sandboxed', async () => {
    await call(`/api/submission-files/8590105935/${studentId}`);
    const zip = await call(`/api/submission-files/8590105935/${studentId}/1/files/11`);
    expect(zip.status).toBe(200);
    expect(zip.body.toString()).toBe('BODYDAT');
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''game.zip");
    expect(fileDeps.openFile).toHaveBeenCalledWith('https://api.schoology.com/v1/submission/11/source/game.zip', { range: null });
    expect(zip.headers.get('content-security-policy')).toBe('sandbox');
    const png = await call(`/api/submission-files/8590105935/${studentId}/2/files/21`);
    expect(png.headers.get('content-disposition')).toMatch(/^inline;/);
    const html = await call(`/api/submission-files/8590105935/${studentId}/2/files/22`);
    expect(html.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(html.headers.get('content-security-policy')).toBe('sandbox');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');
    const forced = await call(`/api/submission-files/8590105935/${studentId}/2/files/21?download=1`);
    expect(forced.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  test('a video plays in the page: inline, ranges passed through as 206, and the converted copy on request', async () => {
    await call(`/api/submission-files/8590105935/${studentId}`);
    fileDeps.openFile.mockResolvedValueOnce({ status: 206, contentType: 'video/mp4', contentLength: 4, contentRange: 'bytes 0-3/100', body: new Response('MP4!').body });
    const part = await call(`/api/submission-files/8590105935/${studentId}/2/files/23?copy=converted`, { Range: 'bytes=0-3' });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe('MP4!');
    expect(part.headers.get('content-range')).toBe('bytes 0-3/100');
    expect(part.headers.get('content-length')).toBe('4');
    expect(part.headers.get('accept-ranges')).toBe('bytes');
    expect(part.headers.get('content-type')).toBe('video/mp4');
    expect(part.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''demo.mp4");
    expect(part.headers.get('content-security-policy')).toBeNull();
    expect(fileDeps.openFile).toHaveBeenLastCalledWith('https://api.schoology.com/v1/submission/23/conversion/demo.mp4', { range: 'bytes=0-3' });
    const original = await call(`/api/submission-files/8590105935/${studentId}/2/files/23`);
    expect(original.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''demo.mov");
    expect((await call(`/api/submission-files/8590105935/${studentId}/1/files/11?copy=converted`)).status).toBe(404);
  });

  test('an unknown file is a 404, a refused download a 502, an OneDrive task a 409, an unknown assignment a 404', async () => {
    await call(`/api/submission-files/8590105935/${studentId}`);
    expect((await call(`/api/submission-files/8590105935/${studentId}/1/files/99`)).status).toBe(404);
    fileDeps.openFile.mockResolvedValueOnce({ status: 403, body: null });
    const refused = await call(`/api/submission-files/8590105935/${studentId}/1/files/11`);
    expect(refused.status).toBe(502);
    expect(refused.body.code).toBe('SCHOOLOGY');
    const onedrive = await call(`/api/submission-files/8590106104/${studentId}`);
    expect(onedrive.status).toBe(409);
    expect(onedrive.body.code).toBe('NOT_NATIVE');
    expect((await call('/api/submission-files/assignment/nope')).status).toBe(404);
  });

  test('GET /student/:id: this student\'s cached summaries by Schoology id, and a background read of their uploads', async () => {
    const db = getDb();
    const aid = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = '8590105935'`).get().id;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, submitted_at, submission_type) VALUES (?, ?, 1792300000, 'drop')`).run(studentId, aid);
    const first = await call(`/api/submission-files/student/${studentId}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ assignments: {}, refresh: { queued: 1, joined: false } });
    await vi.waitFor(() => expect(fileDeps.getSubmissionRevisions).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      const later = await call(`/api/submission-files/student/${studentId}?refresh=0`);
      expect(later.body).toEqual({ assignments: { 8590105935: { revisions: 2, files: 4, read_at: new Date(1792400000 * 1000).toISOString() } }, refresh: null });
    });
    expect(fileDeps.getSubmissionRevisions).toHaveBeenCalledTimes(1);
    expect((await call('/api/submission-files/student/99999')).status).toBe(404);
  });
});
