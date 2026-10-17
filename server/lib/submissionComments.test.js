import { describe, test, expect } from 'vitest';
import { commentPlainText, splitAutomatic, authorRole, describeComment, threadSummary } from './submissionComments.js';

describe('commentPlainText', () => {
  test('removes tags, keeps line breaks and decodes entities', () => {
    expect(commentPlainText('<p>Revision 1 submitted</p><p>Gap &amp; speed<br/>next line</p>'))
      .toBe('Revision 1 submitted\nGap & speed\nnext line');
  });
  test('normalises CRLF and trims trailing spaces', () => {
    expect(commentPlainText('a  \r\nb\r\n')).toBe('a\nb');
  });
  test('null is empty', () => expect(commentPlainText(null)).toBe(''));
});

describe('splitAutomatic', () => {
  test('separates Schoology\'s Revision lines from typed text', () => {
    expect(splitAutomatic('Revision 2 submitted\nPlaytest: 5 rounds.\nEvaluation: harder.'))
      .toEqual({ automatic: ['Revision 2 submitted'], text: 'Playtest: 5 rounds.\nEvaluation: harder.' });
  });
  test('only the automatic line', () => {
    expect(splitAutomatic('Revision 1 submitted')).toEqual({ automatic: ['Revision 1 submitted'], text: '' });
  });
  test('a sentence that mentions a revision is typed text', () => {
    expect(splitAutomatic('Revision 1 submitted late, sorry')).toEqual({ automatic: [], text: 'Revision 1 submitted late, sorry' });
  });
});

describe('authorRole', () => {
  const teachers = new Set(['114956593']);
  test('the student, a teacher, someone else', () => {
    expect(authorRole('555', { studentUid: 555, teacherUids: teachers })).toBe('student');
    expect(authorRole('114956593', { studentUid: '555', teacherUids: teachers })).toBe('teacher');
    expect(authorRole('42', { studentUid: '555', teacherUids: teachers })).toBe('other');
  });
});

describe('describeComment', () => {
  const row = (over) => ({
    schoology_comment_id: '9001', author_uid: '555', author_role: 'student', author_name: 'Ana Lee',
    is_mine: 0, body: 'Revision 1 submitted', created: 1792300000, ...over,
  });
  test('automatic-only student comment', () => {
    expect(describeComment(row())).toEqual({
      id: '9001', author_uid: '555', author_role: 'student', author_name: 'Ana Lee', is_mine: false,
      created: new Date(1792300000 * 1000).toISOString(),
      text: 'Revision 1 submitted', automatic_lines: ['Revision 1 submitted'], is_automatic: true, student_text: null,
      attachments: [],
    });
  });
  test('student-written text after the automatic line', () => {
    const d = describeComment(row({ body: 'Revision 2 submitted\nMy playtest notes' }));
    expect(d.is_automatic).toBe(false);
    expect(d.student_text).toBe('My playtest notes');
  });
  test('a teacher comment is never student text, even with a Revision line', () => {
    const d = describeComment(row({ author_role: 'teacher', is_mine: 1, body: 'Your rubric feedback is attached.' }));
    expect(d).toMatchObject({ is_automatic: false, student_text: null, is_mine: true, automatic_lines: [] });
  });
});

describe('comment files', () => {
  const png = JSON.stringify([{ fid: 123, filename: 'Chen_Victor.png', title: 'Chen_Victor.png', filesize: 671044, filemime: 'image/png', extension: 'png', md5: 'x', download_path: 'https://api.schoology.com/v1/system/files/x.png' }]);
  const row = (over) => ({ schoology_comment_id: '1', author_uid: '555', author_role: 'student', is_mine: 0, body: 'Revision 1 submitted', created: 1, ...over });
  test('a student file makes a Revision-only comment the student\'s own, and hides the download path', () => {
    const d = describeComment(row({ attachments: png }));
    expect(d.is_automatic).toBe(false);
    expect(d.attachments).toEqual([{ fid: '123', filename: 'Chen_Victor.png', title: 'Chen_Victor.png', filesize: 671044, filemime: 'image/png', extension: 'png' }]);
    expect(JSON.stringify(d)).not.toContain('download_path');
  });
  test('summary counts student files apart from teacher files', () => {
    const c = [describeComment(row({ attachments: png })), describeComment(row({ schoology_comment_id: '2', author_role: 'teacher', attachments: png }))];
    expect(threadSummary(c)).toMatchObject({ student_files: 1, files: 2, student_text: false });
  });
  test('bad JSON reads as no files', () => {
    expect(describeComment(row({ attachments: '{oops' })).attachments).toEqual([]);
  });
});

describe('threadSummary', () => {
  test('counts comments and flags student text', () => {
    const c = [
      { is_automatic: true, student_text: null },
      { is_automatic: false, student_text: 'one two three' },
    ];
    expect(threadSummary(c)).toEqual({ count: 2, student_text: true, student_words: 3, student_files: 0, files: 0 });
    expect(threadSummary([])).toEqual({ count: 0, student_text: false, student_words: 0, student_files: 0, files: 0 });
  });
});
