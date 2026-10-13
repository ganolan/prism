import { describe, test, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { groupStats } from './quizStats.js';

let db, g, qMcq, qFrq;
const RUBRIC = { id: 'r', rows: [{ id: '9', title: 'Row', maxPoints: 4, levels: [
  { points: 4, name: 'Exhibiting Depth' }, { points: 3, name: 'Exhibiting' }, { points: 2, name: 'Developing' }, { points: 1, name: 'Emerging' }] }] };

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM quiz_tag_texts; DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts; DELETE FROM quiz_question_copies; DELETE FROM quiz_questions; DELETE FROM quiz_group_members; DELETE FROM quiz_groups; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
  const t = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_test) VALUES (?, '900', 'T', 1)`).run(c).lastInsertRowid;
  g = db.prepare(`INSERT INTO quiz_groups (course_id, title) VALUES (?, 'T')`).run(c).lastInsertRowid;
  db.prepare('INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)').run(g, t);
  const opts = JSON.stringify(['A', 'B', 'C', 'D'].map(l => ({ letter: l, html: l, is_key: l === 'B' })));
  qMcq = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, options_json, max_points, tags_json) VALUES (?, 1, 'mcq', 'Q1', ?, 1, '["CRD-2.G"]')`).run(g, opts).lastInsertRowid;
  qFrq = db.prepare(`INSERT INTO quiz_questions (group_id, position, kind, stem_html, max_points, schoology_rubric_json) VALUES (?, 2, 'frq', 'Q2', 4, ?)`).run(g, JSON.stringify(RUBRIC)).lastInsertRowid;
  // 4 students: choices B, C, C, blank; FRQ cells 3, 2, 2, none. 5 enrolled.
  const choices = ['B', 'C', 'C', null];
  const cells = [3, 2, 2, null];
  for (let i = 0; i < 5; i++) {
    const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'S', ?)`).run(`u${i}`, `S${i}`).lastInsertRowid;
    db.prepare('INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)').run(s, c);
    if (i === 4) continue;
    const a = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, ?, 'now')`).run(g, t, s, `a${i}`).lastInsertRowid;
    db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, chosen_letter, is_correct, points, max_points) VALUES (?, ?, ?, ?, ?, 1)')
      .run(a, qMcq, choices[i], choices[i] === 'B' ? 1 : 0, choices[i] === 'B' ? 1 : 0);
    db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, points, max_points, schoology_rubric_cells_json) VALUES (?, ?, ?, 4, ?)')
      .run(a, qFrq, cells[i], cells[i] == null ? null : JSON.stringify({ 9: { points: cells[i], comment: '' } }));
  }
});

describe('groupStats', () => {
  test('takers, MCQ median and FRQ levels', () => {
    const s = groupStats(db, { groupId: g });
    expect([s.takers, s.classSize]).toEqual([4, 5]);
    expect(s.byMember).toEqual([{ schoology_assignment_id: '900', title: 'T', takers: 4 }]);
    expect(s.mcq).toEqual({ count: 1, median_percent: 0, students: expect.any(Array) });
    expect(s.frq).toEqual({ count: 1, levels: [{ name: 'Exhibiting', count: 1 }, { name: 'Developing', count: 2 }, { name: 'Not marked', count: 1 }] });
  });

  test('each student\'s MCQ score, lowest first, with the name the teacher uses', () => {
    expect(groupStats(db, { groupId: g }).mcq.students).toEqual([
      { student_id: expect.any(Number), name: 'S S1', correct: 0, total: 1, percent: 0 },
      { student_id: expect.any(Number), name: 'S S2', correct: 0, total: 1, percent: 0 },
      { student_id: expect.any(Number), name: 'S S3', correct: 0, total: 1, percent: 0 },
      { student_id: expect.any(Number), name: 'S S0', correct: 1, total: 1, percent: 100 },
    ]);
  });

  test('tag texts for the course come back by tag and on the tag rollup', () => {
    const course = db.prepare('SELECT course_id FROM quiz_groups WHERE id = ?').get(g).course_id;
    db.prepare(`INSERT INTO quiz_tag_texts (course_id, tag, text) VALUES (?, 'CRD-2.G', 'Describe the purpose of a code segment.')`).run(course);
    const s = groupStats(db, { groupId: g });
    expect(s.tagTexts).toEqual({ 'CRD-2.G': 'Describe the purpose of a code segment.' });
    expect(s.byTag[0].text).toBe('Describe the purpose of a code segment.');
  });

  test('an FRQ question carries its own level counts', () => {
    const q = groupStats(db, { groupId: g }).questions[1];
    expect(q.levels).toEqual([{ name: 'Exhibiting', count: 1 }, { name: 'Developing', count: 2 }, { name: 'Not marked', count: 1 }]);
  });

  test('per question: counts, blank, band and flags', () => {
    const q = groupStats(db, { groupId: g }).questions[0];
    expect([q.total, q.correct, q.facility, q.band, q.blank]).toEqual([4, 1, 0.25, 'Divided', 1]);
    expect(q.options.map(o => [o.letter, o.count, o.is_key])).toEqual([['A', 0, false], ['B', 1, true], ['C', 2, false], ['D', 0, false]]);
    expect(q.flags.map(f => f.text)).toEqual([
      'Distractor C drew more students than the key.',
      'Fewer than half answered correctly.',
      '1 left blank.',
    ]);
  });

  test('by tag, lowest first', () => {
    expect(groupStats(db, { groupId: g }).byTag).toEqual([{ tag: 'CRD-2.G', text: null, positions: [1], correct: 1, total: 4, percent: 25 }]);
  });

  test('an unchosen distractor is noted once there are ten answers', () => {
    const member = db.prepare('SELECT assignment_id FROM quiz_group_members WHERE group_id = ?').get(g).assignment_id;
    for (let i = 10; i < 16; i++) {
      const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'S', ?)`).run(`u${i}`, `S${i}`).lastInsertRowid;
      const a = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, ?, 'now')`).run(g, member, s, `a${i}`).lastInsertRowid;
      db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, chosen_letter, is_correct, points, max_points) VALUES (?, ?, ?, 1, 1, 1)').run(a, qMcq, 'B');
    }
    const q = groupStats(db, { groupId: g }).questions[0];
    expect(q.total).toBe(10);
    expect(q.flags).toEqual([
      { level: 'note', text: 'Nobody chose A.' },
      { level: 'note', text: 'Nobody chose D.' },
      { level: 'warning', text: '1 left blank.' },
    ]);
  });

  test('a multi-row FRQ rubric gives one level per answer, from the first row', () => {
    const two = { id: 'r', rows: [RUBRIC.rows[0], { id: '10', title: 'Second', maxPoints: 4, levels: RUBRIC.rows[0].levels }] };
    db.prepare('UPDATE quiz_questions SET schoology_rubric_json = ? WHERE id = ?').run(JSON.stringify(two), qFrq);
    const attemptOf = (sid) => db.prepare('SELECT id FROM quiz_attempts WHERE schoology_attempt_id = ?').get(sid).id;
    const setCells = (sid, cells) => db.prepare('UPDATE quiz_responses SET schoology_rubric_cells_json = ? WHERE attempt_id = ? AND question_id = ?')
      .run(cells == null ? null : JSON.stringify(cells), attemptOf(sid), qFrq);
    // a0: row 9 at 3 (Exhibiting), row 10 at 1 (ignored: only the first row counts).
    setCells('a0', { 9: { points: 3, comment: '' }, 10: { points: 1, comment: '' } });
    // a1: row 9 missing, row 10 present: not marked.
    setCells('a1', { 10: { points: 2, comment: '' } });
    // a2: row 9 at 2 (Developing).
    setCells('a2', { 9: { points: 2, comment: '' } });
    // a3: no cells (not marked).
    const s = groupStats(db, { groupId: g });
    expect(s.frq.levels).toEqual([
      { name: 'Exhibiting', count: 1 }, { name: 'Developing', count: 1 }, { name: 'Not marked', count: 2 },
    ]);
    expect(s.frq.levels.reduce((n, l) => n + l.count, 0)).toBe(4);
  });

  test('two distractors that each drew more than the key are both flagged critical', () => {
    const member = db.prepare('SELECT assignment_id FROM quiz_group_members WHERE group_id = ?').get(g).assignment_id;
    db.prepare('DELETE FROM quiz_responses WHERE question_id = ?').run(qMcq);
    // 1 B (key), 2 C, 3 D: C and D each beat the key; 6 answers, 1 correct.
    const picks = ['B', 'C', 'C', 'D', 'D', 'D'];
    picks.forEach((letter, i) => {
      const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'S', ?)`).run(`w${i}`, `W${i}`).lastInsertRowid;
      const a = db.prepare(`INSERT INTO quiz_attempts (group_id, assignment_id, student_id, schoology_attempt_id, fetched_at) VALUES (?, ?, ?, ?, 'now')`).run(g, member, s, `w${i}`).lastInsertRowid;
      db.prepare('INSERT INTO quiz_responses (attempt_id, question_id, chosen_letter, is_correct, points, max_points) VALUES (?, ?, ?, ?, 1, 1)')
        .run(a, qMcq, letter, letter === 'B' ? 1 : 0);
    });
    const q = groupStats(db, { groupId: g }).questions[0];
    expect(q.total).toBe(6);
    expect(q.flags).toEqual([
      { level: 'critical', text: 'Distractor C drew more students than the key.' },
      { level: 'critical', text: 'Distractor D drew more students than the key.' },
      { level: 'critical', text: 'Fewer than half answered correctly.' },
    ]);
  });

  test('an FRQ with no stored rubric counts every response as not marked', () => {
    db.prepare('UPDATE quiz_questions SET schoology_rubric_json = NULL WHERE id = ?').run(qFrq);
    expect(groupStats(db, { groupId: g }).frq).toEqual({ count: 1, levels: [{ name: 'Not marked', count: 4 }] });
  });

  test('by tag: equal percents are ordered by tag name', () => {
    db.prepare(`UPDATE quiz_questions SET tags_json = '["CRD-2.G","CRD-1.A"]' WHERE id = ?`).run(qMcq);
    expect(groupStats(db, { groupId: g }).byTag.map(t => t.tag)).toEqual(['CRD-1.A', 'CRD-2.G']);
  });

  test('a group with no attempts has empty statistics', () => {
    db.exec('DELETE FROM quiz_tag_texts; DELETE FROM frq_marks; DELETE FROM quiz_responses; DELETE FROM quiz_attempts;');
    const s = groupStats(db, { groupId: g });
    expect([s.takers, s.mcq.median_percent, s.questions[0].facility, s.questions[0].band]).toEqual([0, null, null, null]);
  });
});
