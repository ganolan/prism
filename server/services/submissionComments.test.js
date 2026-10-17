import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
// Every Schoology call goes through commentDeps, replaced below; never for real.
vi.mock('./schoology.js', () => ({
  getSubmissionComments: vi.fn(), postSubmissionComment: vi.fn(), deleteSubmissionComment: vi.fn(),
  getMyUserId: vi.fn(), getSectionEnrollments: vi.fn(),
}));

import { getDb } from '../db/index.js';
import {
  commentDeps, resetCommentCaches, threadFor, refreshAssignment, postComment, deleteComment, studentsToRefresh, CommentError,
  postCommentWithFile, commentFile,
} from './submissionComments.js';
import { readThread, summariesForCourse } from './submissionCommentStore.js';
import { fakeSchoologyWeb } from '../testing/fakeSchoologyWeb.js';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEACHER = '114956593';
let clock;
let threads; // uid → raw Schoology comments

function seed(db) {
  const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('8458134323', 'MGD')`).run().lastInsertRowid;
  const assignmentId = db.prepare(
    `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, '8590105935', 'Flappy Bird (F)')`,
  ).run(courseId).lastInsertRowid;
  const mk = (uid, first) => {
    const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, 'Lee')`).run(uid, first).lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(id, courseId);
    return id;
  };
  const ana = mk('555', 'Ana');
  const ben = mk('666', 'Ben');
  const cy = mk('777', 'Cy');
  // Ana and Ben submitted; Cy did not.
  db.prepare(`INSERT INTO grades (student_id, assignment_id, submitted_at, submission_type) VALUES (?, ?, 1792300000, 'drop')`).run(ana, assignmentId);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, submitted_at, submission_type) VALUES (?, ?, 1792300000, 'drop')`).run(ben, assignmentId);
  return { courseId, assignmentId, ana, ben, cy };
}

beforeEach(() => {
  getDb().exec(
    'DELETE FROM submission_comments; DELETE FROM submission_comment_reads; DELETE FROM grades; ' +
    'DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;',
  );
  resetCommentCaches();
  clock = 1792400000;
  threads = {
    555: [
      { id: '2', uid: '555', comment: 'Revision 2 submitted\nPlaytest: 5 rounds.', created: '1792300100' },
      { id: '1', uid: '555', comment: 'Revision 1 submitted', created: '1792300000' },
    ],
    666: [{ id: '3', uid: TEACHER, comment: 'Your rubric feedback is attached.', created: '1792300200' }],
  };
  Object.assign(commentDeps, {
    getSubmissionComments: vi.fn(async (_s, _a, uid) => [...(threads[uid] || [])]
      .sort((a, b) => Number(a.created) - Number(b.created))),
    postSubmissionComment: vi.fn(async () => ({ status: 201, data: {} })),
    deleteSubmissionComment: vi.fn(async () => ({ status: 204 })),
    getMyUserId: vi.fn(async () => TEACHER),
    getSectionEnrollments: vi.fn(async () => [
      { uid: TEACHER, admin: 1, name_display: 'Graham Nolan' },
      { uid: '555', admin: 0, status: '1' },
    ]),
    sleep: vi.fn(async () => {}),
    now: () => clock,
    cookieJar: () => { throw new Error('tests must inject a fake web session'); },
    fetch: async () => { throw new Error('tests must inject a fake fetch'); },
  });
});

describe('threadFor', () => {
  test('reads from Schoology, classifies and caches the thread oldest first', async () => {
    const db = getDb(); const { ana } = seed(db);
    const t = await threadFor(db, { assignmentId: '8590105935', studentId: ana });
    expect(t.comments.map((c) => c.id)).toEqual(['1', '2']);
    expect(t.comments[0]).toMatchObject({ author_role: 'student', author_name: 'Ana Lee', is_automatic: true, student_text: null });
    expect(t.comments[1]).toMatchObject({ is_automatic: false, student_text: 'Playtest: 5 rounds.' });
    expect(t.summary).toEqual({ count: 2, student_text: true, student_words: 3, student_files: 0, files: 0 });
    expect(t.read_at).toBe(new Date(clock * 1000).toISOString());
  });

  test('a fresh cache is served without a call; force or age re-reads', async () => {
    const db = getDb(); const { ana } = seed(db);
    await threadFor(db, { assignmentId: '8590105935', studentId: ana });
    clock += 60;
    await threadFor(db, { assignmentId: '8590105935', studentId: ana });
    expect(commentDeps.getSubmissionComments).toHaveBeenCalledTimes(1);
    await threadFor(db, { assignmentId: '8590105935', studentId: ana, force: true });
    clock += 400;
    await threadFor(db, { assignmentId: '8590105935', studentId: ana });
    expect(commentDeps.getSubmissionComments).toHaveBeenCalledTimes(3);
  });

  test('teacher comments: role, name and is_mine', async () => {
    const db = getDb(); const { ben } = seed(db);
    const t = await threadFor(db, { assignmentId: '8590105935', studentId: ben });
    expect(t.comments[0]).toMatchObject({ author_role: 'teacher', author_name: 'Graham Nolan', is_mine: true, student_text: null });
  });

  test('a failed read keeps the cache and reports the error', async () => {
    const db = getDb(); const { ana } = seed(db);
    await threadFor(db, { assignmentId: '8590105935', studentId: ana });
    commentDeps.getSubmissionComments.mockRejectedValueOnce(new Error('Schoology API 503'));
    const t = await threadFor(db, { assignmentId: '8590105935', studentId: ana, force: true });
    expect(t.comments).toHaveLength(2);
    expect(t.error).toMatch(/503/);
  });

  test('an empty thread is stored as read, not as never read', async () => {
    const db = getDb(); const { cy, assignmentId } = seed(db);
    const t = await threadFor(db, { assignmentId: '8590105935', studentId: cy });
    expect(t.comments).toEqual([]);
    expect(readThread(db, { assignmentId, studentId: cy }).read_at).not.toBeNull();
  });

  test('a student outside the course is refused', async () => {
    const db = getDb(); seed(db);
    const stranger = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('999', 'X', 'Y')`).run().lastInsertRowid;
    await expect(threadFor(db, { assignmentId: '8590105935', studentId: stranger })).rejects.toBeInstanceOf(CommentError);
  });
});

describe('refreshAssignment', () => {
  test('reads only submitted students (and ones with cached comments), skipping fresh ones', async () => {
    const db = getDb(); const { assignmentId, ana, ben, cy } = seed(db);
    expect(studentsToRefresh(db, db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId)).map((s) => s.id))
      .toEqual(expect.arrayContaining([ana, ben]));
    const job = refreshAssignment(db, '8590105935');
    expect(job.queued).toBe(2);
    expect(await job.done).toEqual({ refreshed: 2, failed: 0 });
    expect(commentDeps.getSubmissionComments.mock.calls.map((c) => c[2]).sort()).toEqual(['555', '666']);
    expect(readThread(db, { assignmentId, studentId: cy }).read_at).toBeNull();
    // Fresh now: a second run queues nothing.
    expect(refreshAssignment(db, '8590105935').queued).toBe(0);
  });

  test('a second call joins the running job', async () => {
    const db = getDb(); seed(db);
    const a = refreshAssignment(db, '8590105935');
    const b = refreshAssignment(db, '8590105935');
    expect(b.joined).toBe(true);
    await a.done;
  });

  test('summariesForCourse feeds the badges', async () => {
    const db = getDb(); const { courseId, ana, ben } = seed(db);
    await refreshAssignment(db, '8590105935').done;
    const s = summariesForCourse(db, courseId)['8590105935'];
    expect(s[ana]).toMatchObject({ count: 2, student_text: true });
    expect(s[ben]).toMatchObject({ count: 1, student_text: false });
  });
});

describe('postComment', () => {
  test('posts the flat text body, then re-reads the thread', async () => {
    const db = getDb(); const { cy } = seed(db);
    threads[777] = [];
    commentDeps.postSubmissionComment.mockImplementationOnce(async (_s, _a, uid, text) => {
      threads[uid].push({ id: '9', uid: TEACHER, comment: text, created: String(clock) });
      return { status: 201, data: {} };
    });
    const t = await postComment(db, { assignmentId: '8590105935', studentId: cy, text: '  Thank you for the notes.  ' });
    expect(commentDeps.postSubmissionComment).toHaveBeenCalledWith('8458134323', '8590105935', '777', 'Thank you for the notes.');
    expect(t.comments).toEqual([expect.objectContaining({ id: '9', is_mine: true, text: 'Thank you for the notes.' })]);
  });

  test('refuses an empty comment and reports a Schoology refusal', async () => {
    const db = getDb(); const { cy } = seed(db);
    await expect(postComment(db, { assignmentId: '8590105935', studentId: cy, text: '   ' })).rejects.toMatchObject({ code: 'EMPTY' });
    commentDeps.postSubmissionComment.mockResolvedValueOnce({ status: 403, data: {} });
    await expect(postComment(db, { assignmentId: '8590105935', studentId: cy, text: 'hi' })).rejects.toMatchObject({ code: 'SCHOOLOGY' });
    expect(commentDeps.postSubmissionComment).toHaveBeenCalledTimes(1);
  });
});

describe('deleteComment', () => {
  test('deletes the teacher\'s own comment and re-reads', async () => {
    const db = getDb(); const { ben } = seed(db);
    await threadFor(db, { assignmentId: '8590105935', studentId: ben });
    commentDeps.deleteSubmissionComment.mockImplementationOnce(async () => { threads[666] = []; return { status: 204 }; });
    const t = await deleteComment(db, { assignmentId: '8590105935', studentId: ben, commentId: '3' });
    expect(commentDeps.deleteSubmissionComment).toHaveBeenCalledWith('8458134323', '8590105935', '666', '3');
    expect(t.comments).toEqual([]);
  });

  test('refuses a student\'s comment and an unknown id without calling Schoology', async () => {
    const db = getDb(); const { ana } = seed(db);
    await threadFor(db, { assignmentId: '8590105935', studentId: ana });
    await expect(deleteComment(db, { assignmentId: '8590105935', studentId: ana, commentId: '1' })).rejects.toMatchObject({ code: 'NOT_YOURS' });
    await expect(deleteComment(db, { assignmentId: '8590105935', studentId: ana, commentId: '42' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(commentDeps.deleteSubmissionComment).not.toHaveBeenCalled();
  });
});

describe('postCommentWithFile (plain HTTP, no browser)', () => {
  const md5 = (b) => createHash('md5').update(b).digest('hex');
  let dir; let file;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prism-test-'));
    file = join(dir, 'Chen, Victor.png');
    writeFileSync(file, 'PNGBYTES');
  });
  const use = (web) => { commentDeps.cookieJar = () => web.jar; commentDeps.fetch = web.fetchImpl; };
  const withFile = (id, sum) => ({ id, uid: TEACHER, comment: 'Your rubric', created: String(clock),
    attachments: { files: { file: [{ fid: 4242, filename: 'Chen_Victor.png', filesize: 8, filemime: 'image/png', md5_checksum: sum, download_path: 'https://api.schoology.com/v1/f/x.png' }] } } });

  test('reads the page, uploads with the CSRF headers, submits the form, and confirms by checksum', async () => {
    const db = getDb(); const { ben } = seed(db);
    const web = fakeSchoologyWeb({ onSubmit: () => { threads[666].push(withFile('50', md5('PNGBYTES'))); } });
    use(web);
    const t = await postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, text: 'Your rubric', filePath: file });
    const [get, upload, submit] = web.requests;
    expect(get).toMatchObject({ method: 'GET', path: '/assignment/8590105935/dropbox/view/666' });
    expect(upload.headers).toMatchObject({ 'X-Csrf-Token': 'tok', 'X-Csrf-Key': 'key', cookie: 'SESS=new' });
    expect(upload.form).toEqual({ use_plain: '1', name: 'Chen, Victor.png', chunk: '0', chunks: '1', file: '<blob 8>' });
    expect(submit.headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(submit.form).toMatchObject({
      comment: 'Your rubric', 'file[files]': '{"4242":""}', op: 'Post', drupal_ajax: '1',
      sid: 's&1', form_build_id: 'form-abc', form_token: 'ftok', form_id: 's_drop_item_add_comment_form',
    });
    expect(t.posted_id).toBe('50');
  });

  test('a file Schoology stored with a different checksum is reported, not passed as posted', async () => {
    const db = getDb(); const { ben } = seed(db);
    use(fakeSchoologyWeb({ onSubmit: () => { threads[666].push(withFile('51', 'other')); } }));
    await expect(postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, filePath: file })).rejects.toMatchObject({ code: 'FILE_MISSING' });
  });

  test('no session, an expired session, a refused upload or a page without the form posts nothing', async () => {
    const db = getDb(); const { ben } = seed(db);
    commentDeps.cookieJar = () => null;
    await expect(postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, filePath: file })).rejects.toMatchObject({ code: 'SCHOOLOGY_SESSION' });
    let web = fakeSchoologyWeb({ loginRedirect: true }); use(web);
    await expect(postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, filePath: file })).rejects.toMatchObject({ code: 'SCHOOLOGY_SESSION' });
    web = fakeSchoologyWeb({ uploadAnswer: () => new Response(JSON.stringify({ error: { message: 'too big' } }), { status: 200 }) }); use(web);
    await expect(postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, filePath: file })).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
    expect(web.requests.some((r) => r.method === 'POST' && r.path.includes('/dropbox/view/'))).toBe(false);
    web = fakeSchoologyWeb({ html: '<html>no form</html>' }); use(web);
    await expect(postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, filePath: file })).rejects.toMatchObject({ code: 'NO_UPLOAD' });
  });

  test('a submit that adds no comment is reported as unconfirmed', async () => {
    const db = getDb(); const { ben } = seed(db);
    use(fakeSchoologyWeb());
    await expect(postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, filePath: file })).rejects.toMatchObject({ code: 'UNCONFIRMED' });
  });
});

describe('commentFile', () => {
  test('downloads a cached file with the signed path; an unknown fid is a 404', async () => {
    const db = getDb(); const { ben } = seed(db);
    threads[666][0].attachments = { files: { file: [{ fid: 77, filename: 'Chen_Victor.png', filemime: 'image/png', filesize: 3, download_path: 'https://api.schoology.com/v1/f/x.png' }] } };
    await threadFor(db, { assignmentId: '8590105935', studentId: ben });
    commentDeps.downloadFile = vi.fn(async () => ({ status: 200, contentType: 'image/png', body: Buffer.from('PNG') }));
    const f = await commentFile(db, { assignmentId: '8590105935', studentId: ben, commentId: '3', fid: '77' });
    expect(commentDeps.downloadFile).toHaveBeenCalledWith('https://api.schoology.com/v1/f/x.png');
    expect(f).toMatchObject({ filename: 'Chen_Victor.png', filemime: 'image/png' });
    await expect(commentFile(db, { assignmentId: '8590105935', studentId: ben, commentId: '3', fid: '1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
