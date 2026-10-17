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
  postCommentWithFile,
} from './submissionComments.js';
import { readThread, summariesForCourse } from './submissionCommentStore.js';

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
    openPage: async () => { throw new Error('tests must inject a fake page'); },
  });
});

describe('threadFor', () => {
  test('reads from Schoology, classifies and caches the thread oldest first', async () => {
    const db = getDb(); const { ana } = seed(db);
    const t = await threadFor(db, { assignmentId: '8590105935', studentId: ana });
    expect(t.comments.map((c) => c.id)).toEqual(['1', '2']);
    expect(t.comments[0]).toMatchObject({ author_role: 'student', author_name: 'Ana Lee', is_automatic: true, student_text: null });
    expect(t.comments[1]).toMatchObject({ is_automatic: false, student_text: 'Playtest: 5 rounds.' });
    expect(t.summary).toEqual({ count: 2, student_text: true, student_words: 3 });
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

// A stand-in for the Schoology dropbox view page: records what the service does.
function fakeFormPage({ url = 'https://schoology.hkis.edu.hk/assignment/8590105935/dropbox/view/666', hasInput = true, uploadValue = '987', onSubmit } = {}) {
  const calls = []; let html = '';
  const loc = (sel) => ({
    locator: (s) => loc(`${sel} ${s}`),
    first() { return this; },
    waitFor: async () => {},
    count: async () => (sel.includes('type=file') ? (hasInput ? 1 : 0) : 1),
    setInputFiles: async (p) => { calls.push(['file', p]); },
    inputValue: async () => uploadValue,
    fill: async (t) => { calls.push(['fill', t]); },
    click: async () => { calls.push(['click']); html = onSubmit?.() ?? html; },
  });
  const page = {
    goto: async (u) => { calls.push(['goto', u]); }, url: () => url, locator: loc,
    waitForTimeout: async () => {}, waitForLoadState: async () => {}, content: async () => html,
  };
  return { calls, session: { page, close: vi.fn(async () => {}) } };
}

describe('postCommentWithFile', () => {
  test('uploads through the form, fills the text, posts, and confirms from the thread', async () => {
    const db = getDb(); const { ben } = seed(db);
    const fake = fakeFormPage({ onSubmit: () => {
      threads[666].push({ id: '50', uid: TEACHER, comment: 'Your rubric', created: String(clock) });
      return '<div class="comment">Your rubric <a>Chen, Victor.png</a></div>';
    } });
    commentDeps.openPage = async () => fake.session;
    const t = await postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, text: 'Your rubric', filePath: '/tmp/x/Chen, Victor.png' });
    expect(fake.calls[0]).toEqual(['goto', 'https://schoology.hkis.edu.hk/assignment/8590105935/dropbox/view/666']);
    expect(fake.calls).toContainEqual(['file', '/tmp/x/Chen, Victor.png']);
    expect(fake.calls).toContainEqual(['fill', 'Your rubric']);
    expect(fake.calls.filter((c) => c[0] === 'click')).toHaveLength(1);
    expect(t).toMatchObject({ posted_id: '50', file_shown: true });
    expect(fake.session.close).toHaveBeenCalled();
  });

  test('a dead session, a page with no upload, or a failed upload posts nothing', async () => {
    const db = getDb(); const { ben } = seed(db);
    commentDeps.openPage = async () => null;
    await expect(postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, filePath: '/tmp/a.png' })).rejects.toMatchObject({ code: 'SCHOOLOGY_SESSION' });
    let fake = fakeFormPage({ url: 'https://login.microsoftonline.com/x' });
    commentDeps.openPage = async () => fake.session;
    await expect(postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, filePath: '/tmp/a.png' })).rejects.toMatchObject({ code: 'SCHOOLOGY_SESSION' });
    fake = fakeFormPage({ hasInput: false });
    commentDeps.openPage = async () => fake.session;
    await expect(postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, filePath: '/tmp/a.png' })).rejects.toMatchObject({ code: 'NO_UPLOAD' });
    fake = fakeFormPage({ uploadValue: '' });
    commentDeps.openPage = async () => fake.session;
    await expect(postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, filePath: '/tmp/a.png' })).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
    expect(fake.calls.some((c) => c[0] === 'click')).toBe(false);
    expect(fake.session.close).toHaveBeenCalled();
  }, 70000);

  test('a submit that adds no comment is reported as unconfirmed', async () => {
    const db = getDb(); const { ben } = seed(db);
    const fake = fakeFormPage();
    commentDeps.openPage = async () => fake.session;
    await expect(postCommentWithFile(db, { assignmentId: '8590105935', studentId: ben, filePath: '/tmp/a.png' })).rejects.toMatchObject({ code: 'UNCONFIRMED' });
  });
});
