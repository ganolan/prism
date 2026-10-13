import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import {
  schoologyMarkOf, sameMark, resolveCells, writeFrqSuggestions, setFrqMark, recordWriteback, reconcileMarks,
} from './frqMarks.js';

const RUBRIC = { id: 'r1', title: 'FRQ', totalPoints: 4, rows: [{ id: '146', title: 'Content Knowledge', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth', descriptionHtml: 'Exhibiting Depth: all correct' },
  { points: 3, name: 'Exhibiting', descriptionHtml: 'Exhibiting: main ideas correct' },
  { points: 2, name: 'Developing', descriptionHtml: 'Developing: one part' },
  { points: 1, name: 'Emerging', descriptionHtml: 'Emerging: attempted' }] }] };

let db, g, q, qNoRubric, a1, a2;
const cellsOf = (row) => JSON.parse(row);
const mark = (attempt, question = q) => db.prepare('SELECT * FROM frq_marks WHERE attempt_id = ? AND question_id = ?').get(attempt, question);
const setSchoology = (attempt, points, comment) => db.prepare('UPDATE quiz_responses SET schoology_rubric_cells_json = ?, schoology_comment = ? WHERE attempt_id = ? AND question_id = ?')
  .run(points == null ? null : JSON.stringify({ 146: { points, comment: '' } }), comment, attempt, q);

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM frq_marks; DELETE FROM quiz_tag_texts; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
  const t = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1)`).run(c).lastInsertRowid;
  g = db.prepare(`INSERT INTO quiz_groups (course_id, title) VALUES (?, 'T')`).run(c).lastInsertRowid;
  db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, t);
  q = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 21, 'frq', 'Explain', 4, ?)`).run(g, JSON.stringify(RUBRIC)).lastInsertRowid;
  qNoRubric = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points) VALUES (?, 22, 'frq', 'Describe', 5)`).run(g).lastInsertRowid;
  const ids = [];
  for (const [uid, last] of [['u1', 'Lee'], ['u2', 'Ng']]) {
    const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Ana', ?)`).run(uid, last).lastInsertRowid;
    const a = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, ?, 'now')`).run(g, t, s, `9${uid}`).lastInsertRowid;
    for (const qq of [q, qNoRubric]) db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, answer_html, max_points) VALUES (?, ?, ?, 4)').run(a, qq, '<p>answer</p>');
    ids.push(a);
  }
  [a1, a2] = ids;
});

describe('Schoology mark and comparison', () => {
  test('the stored Schoology copy as cells in points and the comment', () => {
    setSchoology(a1, 2, 'Good start');
    const r = db.prepare('SELECT * FROM quiz_responses WHERE attempt_id = ? AND question_id = ?').get(a1, q);
    expect(schoologyMarkOf(r, RUBRIC)).toEqual({ cells: { 146: 2 }, comment: 'Good start' });
    expect(schoologyMarkOf({ points: null, schoology_comment: null }, null)).toBeNull();
  });
  test('sameMark compares points per row and the comment, ignoring spacing only', () => {
    expect(sameMark({ cells: { 146: 2 }, comment: ' Good\n\n start ' }, { cells: { 146: '2' }, comment: 'Good start' })).toBe(true);
    expect(sameMark({ cells: { 146: 2 }, comment: 'if a<b then good' }, { cells: { 146: 2 }, comment: 'if a<b then bad' })).toBe(false);
    expect(sameMark({ cells: { 146: 2 }, comment: 'a' }, { cells: { 146: 3 }, comment: 'a' })).toBe(false);
    expect(sameMark({ cells: { 146: 2 }, comment: 'a' }, null)).toBe(false);
  });
});

describe('resolveCells (agent input)', () => {
  const row = { schoology_rubric_json: JSON.stringify(RUBRIC), max_points: 4 };
  test('levels by row title or id, by name or Prism code', () => {
    expect(resolveCells(row, { cells: { 'content knowledge': 'Developing' } })).toEqual({ cells: { 146: 2 } });
    expect(resolveCells(row, { cells: { 146: 'ED' } })).toEqual({ cells: { 146: 4 } });
    expect(resolveCells(row, { level: 'Exhibiting' })).toEqual({ cells: { 146: 3 } });
  });
  test('refuses numbers, unknown rows and unknown levels, naming the problem', () => {
    expect(resolveCells(row, { cells: { 146: 3 } }).error).toMatch(/unknown level 3/);
    expect(resolveCells(row, { cells: { Style: 'Developing' } }).error).toMatch(/unknown rubric row "Style"/);
    expect(resolveCells(row, { level: 'Great' }).error).toMatch(/levels: Exhibiting Depth, Exhibiting, Developing, Emerging/);
  });
  test('without a rubric, points from 0 to max_points', () => {
    const plain = { schoology_rubric_json: null, max_points: 5 };
    expect(resolveCells(plain, { points: 4 })).toEqual({ cells: { points: 4 } });
    expect(resolveCells(plain, { points: 6 }).error).toMatch(/0 to 5/);
  });
});

describe('suggestions', () => {
  test('writes a suggestion per student and reports a bad one without stopping', () => {
    const r = writeFrqSuggestions(db, { groupId: g, position: 21, students: [
      { student: 'u1', level: 'Developing', comment: 'Part (a) is right.' },
      { student: 'u2', cells: { 146: 3 }, comment: 'x' },
      { student: 'nobody', level: 'Developing', comment: 'x' },
    ] });
    expect(r.written).toBe(1);
    expect(r.results.map(x => x.status)).toEqual(['written', 'error', 'error']);
    expect(r.results[2].message).toMatch(/Student not found/);
    const m = mark(a1);
    expect([cellsOf(m.suggested_cells_json), m.suggested_comment, m.state, m.final_cells_json]).toEqual([{ 146: 2 }, 'Part (a) is right.', 'suggested', null]);
  });

  test('a new suggestion replaces the old one, keeps it in history, and never touches the teacher mark', () => {
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'v1' }] });
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Exhibiting', comment: 'v2' }] });
    const m = mark(a1);
    expect([cellsOf(m.final_cells_json), m.final_comment, m.state]).toEqual([{ 146: 2 }, 'v1', 'accepted']);
    expect([cellsOf(m.suggested_cells_json), m.suggested_comment, m.suggestion_revised]).toEqual([{ 146: 3 }, 'v2', 1]);
    expect(JSON.parse(m.suggestion_history_json).map(h => h.comment)).toEqual(['v1']);
  });

  test('an unknown question is NOT_FOUND', () => {
    expect(() => writeFrqSuggestions(db, { groupId: g, position: 9, students: [] })).toThrow(/no free-response question 9/);
  });
});

describe('teacher actions and write-back', () => {
  beforeEach(() => {
    setSchoology(a1, 3, 'Old comment');
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'New comment' }] });
  });

  test('accept copies the suggestion to final and waits to post', () => {
    const v = setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    expect([v.state, v.final, v.writeback.status]).toEqual(['accepted', { cells: { 146: 2 }, comment: 'New comment' }, 'pending']);
  });

  test('save with a different cell is edited; save equal to the suggestion is accepted', () => {
    expect(setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'save', cells: { 146: 4 }, comment: 'Mine' }).state).toBe('edited');
    expect(setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'save', cells: { 146: 2 }, comment: 'New comment' }).state).toBe('accepted');
  });

  test('save refuses a cell that is not a level of the row', () => {
    expect(() => setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'save', cells: { 146: 7 }, comment: 'x' })).toThrow(/Choose a level/);
  });

  test('a mark equal to Schoology is posted at once', () => {
    const v = setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'save', cells: { 146: 3 }, comment: 'Old comment' });
    expect(v.writeback.status).toBe('posted');
  });

  test('a card started from Schoology and edited, with no suggestion, is edited', () => {
    setSchoology(a2, 2, 'S');
    expect(setFrqMark(db, { groupId: g, attemptId: a2, position: 21, action: 'save', cells: { 146: 3 }, comment: 'T' }).state).toBe('edited');
  });

  test('accept without a suggestion and keep without a mark are refused', () => {
    expect(() => setFrqMark(db, { groupId: g, attemptId: a2, position: 21, action: 'accept' })).toThrow(/no suggestion/);
    expect(() => setFrqMark(db, { groupId: g, attemptId: a2, position: 21, action: 'keep' })).toThrow(/no mark of yours/);
  });

  test('keep clears the revised flag and leaves final alone', () => {
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'save', cells: { 146: 4 }, comment: 'Mine' });
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Emerging', comment: 'v3' }] });
    const v = setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'keep' });
    expect([v.suggestion_revised, v.final.comment]).toEqual([false, 'Mine']);
  });

  test('recordWriteback: posted copies final to posted; failed keeps the error', () => {
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    expect(recordWriteback(db, { groupId: g, student: 'u1', position: 21, status: 'failed', error: 'Timed out' }).writeback).toMatchObject({ status: 'failed', error: 'Timed out' });
    expect(recordWriteback(db, { groupId: g, student: 'u1', position: 21, status: 'posted' }).writeback.status).toBe('posted');
    expect(mark(a1).posted_comment).toBe('New comment');
  });

  test('recordWriteback refuses an answer with no teacher mark', () => {
    expect(() => recordWriteback(db, { groupId: g, student: 'u2', position: 21, status: 'posted' })).toThrow(/no accepted mark/);
  });

  test('reconcile: a waiting mark that Schoology now shows becomes posted', () => {
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    expect(reconcileMarks(db, { groupId: g })).toEqual({ posted: 0 });
    setSchoology(a1, 2, ' New   comment ');
    expect(reconcileMarks(db, { groupId: g })).toEqual({ posted: 1 });
    expect(mark(a1).writeback_status).toBe('posted');
  });

  test('a posted mark later changed by hand in Schoology shows as changed, and nothing overwrites it', () => {
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    recordWriteback(db, { groupId: g, student: 'u1', position: 21, status: 'posted' });
    setSchoology(a1, 4, 'Teacher typed this in Schoology');
    reconcileMarks(db, { groupId: g });
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Emerging', comment: 'v9' }] });
    const v = setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'keep' });
    expect([v.writeback.status, v.changed_in_schoology, v.final.comment]).toEqual(['posted', true, 'New comment']);
  });

  test('without a rubric the mark is points', () => {
    const v = setFrqMark(db, { groupId: g, attemptId: a1, position: 22, action: 'save', cells: { points: 4 }, comment: 'ok' });
    expect(v.final.cells).toEqual({ points: 4 });
  });
});

describe('recordWriteback guard', () => {
  test('recordWriteback refuses a mark that is not waiting or failed', () => {
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Developing', comment: 'x' }] });
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    recordWriteback(db, { groupId: g, student: 'u1', position: 21, status: 'posted' });
    // The teacher then changes it in Schoology; a second "posted" must not overwrite posted_*.
    setSchoology(a1, 3, 'hand edit');
    expect(() => recordWriteback(db, { groupId: g, student: 'u1', position: 21, status: 'posted' }))
      .toThrow(/only a mark waiting to post or failed/i);
    expect(cellsOf(mark(a1).posted_cells_json)).toEqual({ 146: 2 });
  });
});

describe('reconcileMarks with points', () => {
  test('a one-row rubric mark is posted only when the question points match the cell too', () => {
    writeFrqSuggestions(db, { groupId: g, position: 21, students: [{ student: 'u1', level: 'Exhibiting', comment: 'Same' }] });
    setFrqMark(db, { groupId: g, attemptId: a1, position: 21, action: 'accept' });
    setSchoology(a1, 3, 'Same');
    db.prepare('UPDATE quiz_responses SET points = 2 WHERE attempt_id = ? AND question_id = ?').run(a1, q);
    expect(reconcileMarks(db, { groupId: g }).posted).toBe(0);
    db.prepare('UPDATE quiz_responses SET points = 3 WHERE attempt_id = ? AND question_id = ?').run(a1, q);
    expect(reconcileMarks(db, { groupId: g }).posted).toBe(1);
  });
});

