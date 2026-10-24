import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../services/schoology.js', () => ({
  getSubmissionComments: vi.fn(), postSubmissionComment: vi.fn(), deleteSubmissionComment: vi.fn(),
  getMyUserId: vi.fn(), getSectionEnrollments: vi.fn(),
}));

import router from './submissionComments.js';
import { getDb } from '../db/index.js';
import { commentDeps, resetCommentCaches } from '../services/submissionComments.js';
import { storeThread, markSeen, unreadCommentsForStudent } from '../services/submissionCommentStore.js';
import { fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';
import { createHash } from 'crypto';

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/submission-comments', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

let studentId; let courseId;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM submission_comments; DELETE FROM submission_comment_seen; DELETE FROM submission_comment_reads; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  resetCommentCaches();
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec', 'MGD')`).run().lastInsertRowid;
  const aid = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, '8590105935', 'Flappy')`).run(courseId).lastInsertRowid;
  studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('555', 'Ana', 'Lee')`).run().lastInsertRowid;
  db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(studentId, courseId);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, submitted_at, submission_type) VALUES (?, ?, 1, 'drop')`).run(studentId, aid);
  Object.assign(commentDeps, {
    getSubmissionComments: vi.fn(async () => [{ id: '1', uid: '555', comment: 'Revision 1 submitted\nMy notes', created: '1792300000' }]),
    postSubmissionComment: vi.fn(async () => ({ status: 201 })),
    deleteSubmissionComment: vi.fn(async () => ({ status: 204 })),
    getMyUserId: vi.fn(async () => '1'),
    getSectionEnrollments: vi.fn(async () => []),
    sleep: async () => {},
  });
});

describe('/api/submission-comments', () => {
  test('GET a thread', async () => {
    const r = await call('GET', `/api/submission-comments/8590105935/${studentId}`);
    expect(r.status).toBe(200);
    expect(r.body.comments[0]).toMatchObject({ student_text: 'My notes', author_role: 'student' });
  });

  test('GET the student returns their cached badges by Schoology assignment id and queues their reads (#135)', async () => {
    const first = await call('GET', `/api/submission-comments/student/${studentId}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ assignments: {}, refresh: { queued: 1, joined: false } });
    await vi.waitFor(() => expect(commentDeps.getSubmissionComments).toHaveBeenCalledWith('sec', '8590105935', '555'));
    await new Promise((r) => setTimeout(r, 20));
    const again = await call('GET', `/api/submission-comments/student/${studentId}?refresh=0`);
    expect(again.body.refresh).toBeNull();
    expect(again.body.assignments['8590105935']).toMatchObject({ count: 1, student_text: true });
  });

  test('GET an unknown student is a 404', async () => {
    const r = await call('GET', '/api/submission-comments/student/999999');
    expect(r.status).toBe(404);
  });

  test('GET the assignment queues a background read and returns badges', async () => {
    const first = await call('GET', '/api/submission-comments/assignment/8590105935');
    expect(first.body.refresh.queued).toBe(1);
    await vi.waitFor(() => expect(commentDeps.getSubmissionComments).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    const again = await call('GET', '/api/submission-comments/assignment/8590105935?refresh=0');
    expect(again.body.students[studentId]).toMatchObject({ count: 1, student_text: true });
    const course = await call('GET', `/api/submission-comments/course/${courseId}`);
    expect(course.body.assignments['8590105935'][studentId].count).toBe(1);
  });

  test('POST maps an empty comment to 400 and posts nothing', async () => {
    const r = await call('POST', `/api/submission-comments/8590105935/${studentId}`, { text: '' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('EMPTY');
    expect(commentDeps.postSubmissionComment).not.toHaveBeenCalled();
  });

  test('DELETE of a student comment is 403', async () => {
    await call('GET', `/api/submission-comments/8590105935/${studentId}`);
    const r = await call('DELETE', `/api/submission-comments/8590105935/${studentId}/1`);
    expect(r.status).toBe(403);
  });

  test('unknown assignment is 404', async () => {
    const r = await call('GET', '/api/submission-comments/assignment/nope');
    expect(r.status).toBe(404);
  });
});

describe('unread comments of one student in a course (#160)', () => {
  const row = (id, uid, role, body, created, attachments = null) => ({
    schoology_comment_id: id, author_uid: uid, author_role: role, author_name: null, is_mine: role === 'teacher' ? 1 : 0, body, created, attachments,
  });
  const file = JSON.stringify([{ fid: 7, filename: 'shot.png', filemime: 'image/png', filesize: 4 }]);
  let flappy; let second; let otherStudent;

  beforeEach(() => {
    const db = getDb();
    flappy = db.prepare("SELECT id FROM assignments WHERE schoology_assignment_id = '8590105935'").get().id;
    second = db.prepare("INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, '8590105936', 'Pong')").run(courseId).lastInsertRowid;
    otherStudent = db.prepare("INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('556', 'Bo', 'Kim')").run().lastInsertRowid;
  });

  test('lists only unread student comments, oldest first, never automatic or teacher comments', async () => {
    const db = getDb();
    storeThread(db, { assignmentId: flappy, studentId, rows: [
      row('11', '555', 'student', 'Revision 1 submitted', 1792300000),                 // automatic only
      row('12', '1', 'teacher', 'Nice work', 1792300100),                              // teacher
      row('13', '555', 'student', 'Revision 2 submitted\nLater question', 1792400000), // typed text
    ] });
    storeThread(db, { assignmentId: second, studentId, rows: [
      row('21', '555', 'student', 'Revision 1 submitted', 1792350000, file),           // file only
      row('22', '555', 'student', 'Revision 2 submitted', 1792360000),                 // automatic
    ] });
    storeThread(db, { assignmentId: second, studentId: otherStudent, rows: [row('31', '556', 'student', 'Not Ana', 1792370000)] });

    expect(unreadCommentsForStudent(db, courseId, studentId)).toEqual([
      { schoologyAssignmentId: '8590105936', title: 'Pong', created: new Date(1792350000 * 1000).toISOString(), studentText: null,
        attachments: [expect.objectContaining({ fid: '7', filename: 'shot.png' })] },
      { schoologyAssignmentId: '8590105935', title: 'Flappy', created: new Date(1792400000 * 1000).toISOString(), studentText: 'Later question', attachments: [] },
    ]);

    const r = await call('GET', `/api/submission-comments/course/${courseId}/student/${studentId}/unread`);
    expect(r.status).toBe(200);
    expect(r.body.comments.map((c) => c.title)).toEqual(['Pong', 'Flappy']);
    // Listing marks nothing seen.
    expect((await call('GET', `/api/submission-comments/course/${courseId}/student/${studentId}/unread`)).body.comments).toHaveLength(2);
  });

  test('a comment older than the last one seen is not listed, and a course with no threads is empty', () => {
    const db = getDb();
    storeThread(db, { assignmentId: flappy, studentId, rows: [row('41', '555', 'student', 'Old note', 1792300000)] });
    markSeen(db, { assignmentId: flappy, studentId });
    expect(unreadCommentsForStudent(db, courseId, studentId)).toEqual([]);
    expect(unreadCommentsForStudent(db, courseId + 99, studentId)).toEqual([]);
  });
});

describe('GET a comment file (#162: opens in Prism\'s viewer)', () => {
  const fetchFile = async (path, headers = {}) => {
    const app = express();
    app.use('/api/submission-comments', router);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://localhost:${server.address().port}${path}`, { headers });
      return { status: res.status, headers: res.headers, text: await res.text() };
    } finally { server.close(); }
  };
  const att = (fid, filename, filemime) => ({ fid, filename, filemime, filesize: 4, download_path: `https://api.schoology.com/v1/f/${filename}` });

  beforeEach(async () => {
    commentDeps.getSubmissionComments = vi.fn(async () => [{
      id: '1', uid: '555', comment: 'Revision 1 submitted', created: '1792300000',
      attachments: { files: { file: [att(7, 'shot.png', 'image/png'), att(8, 'clip.mp4', 'video/mp4'), att(9, 'page.html', 'text/html')] } },
    }]);
    commentDeps.openFile = vi.fn(async (_p, { range }) => (range
      ? { status: 206, contentType: 'video/mp4', contentLength: 2, contentRange: 'bytes 0-1/4', body: new Response('MP').body }
      : { status: 200, contentType: 'x', contentLength: 4, body: new Response('DATA').body }));
    await call('GET', `/api/submission-comments/8590105935/${studentId}`);
  });

  test('an image is inline; ?download=1 downloads it', async () => {
    const png = await fetchFile(`/api/submission-comments/8590105935/${studentId}/1/files/7`);
    expect(png.status).toBe(200);
    expect(png.text).toBe('DATA');
    expect(png.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''shot.png");
    expect(png.headers.get('content-security-policy')).toBeNull();
    const forced = await fetchFile(`/api/submission-comments/8590105935/${studentId}/1/files/7?download=1`);
    expect(forced.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  test('a video streams inline with its range as a 206', async () => {
    const part = await fetchFile(`/api/submission-comments/8590105935/${studentId}/1/files/8`, { Range: 'bytes=0-1' });
    expect(part.status).toBe(206);
    expect(part.text).toBe('MP');
    expect(part.headers.get('content-range')).toBe('bytes 0-1/4');
    expect(part.headers.get('accept-ranges')).toBe('bytes');
    expect(part.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(commentDeps.openFile).toHaveBeenLastCalledWith('https://api.schoology.com/v1/f/clip.mp4', { range: 'bytes=0-1' });
  });

  test('HTML downloads sandboxed; an unknown file is a 404', async () => {
    const html = await fetchFile(`/api/submission-comments/8590105935/${studentId}/1/files/9`);
    expect(html.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(html.headers.get('content-security-policy')).toBe('sandbox');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetchFile(`/api/submission-comments/8590105935/${studentId}/1/files/99`)).status).toBe(404);
  });
});

describe('POST a comment with a file', () => {
  test('writes the upload under its own name and posts it over HTTP', async () => {
    const sum = createHash('md5').update('PNGDATA').digest('hex');
    const web = fakeSchoologyWeb({ onSubmit: () => {
      commentDeps.getSubmissionComments = vi.fn(async () => [{ id: '9', uid: '1', comment: 'hi', created: '1792300500',
        attachments: { files: { file: [{ fid: 5, filename: 'Chen_Victor.png', md5_checksum: sum }] } } }]);
    } });
    commentDeps.cookieJar = () => web.jar; commentDeps.fetch = web.fetchImpl;
    const r = await call('POST', `/api/submission-comments/8590105935/${studentId}/file`,
      { text: 'hi', fileName: '../Chen, Victor.png', data: Buffer.from('PNGDATA').toString('base64') });
    expect(r.status).toBe(200);
    expect(r.body.posted_id).toBe('9');
    expect(web.requests.find((q) => q.path === '/s_attachment_upload_chunked/2').form).toMatchObject({ name: 'Chen, Victor.png', file: '<blob 7>' });
  });

  test('no file is a 400', async () => {
    const r = await call('POST', `/api/submission-comments/8590105935/${studentId}/file`, { text: 'hi' });
    expect(r.status).toBe(400);
  });
});
