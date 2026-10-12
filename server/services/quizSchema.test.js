import { describe, test, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
import { getDb } from '../db/index.js';
import { QuizError } from './quizError.js';

describe('quiz schema', () => {
  test('creates the six quiz tables', () => {
    const names = getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'quiz_%' ORDER BY name`).all().map(r => r.name);
    expect(names).toEqual(['quiz_attempts', 'quiz_group_members', 'quiz_groups', 'quiz_question_copies', 'quiz_questions', 'quiz_responses']);
  });

  test('a test belongs to one group, and a result task to one group', () => {
    const db = getDb();
    const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('qs1', 'C')`).run().lastInsertRowid;
    const t = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'qt1', 'T')`).run(c).lastInsertRowid;
    const r = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'qr1', 'R')`).run(c).lastInsertRowid;
    const g1 = db.prepare(`INSERT INTO quiz_groups (course_id, title, result_assignment_id) VALUES (?, 'G1', ?)`).run(c, r).lastInsertRowid;
    const g2 = db.prepare(`INSERT INTO quiz_groups (course_id, title) VALUES (?, 'G2')`).run(c).lastInsertRowid;
    db.prepare(`INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)`).run(g1, t);
    expect(() => db.prepare(`INSERT INTO quiz_group_members (group_id, assignment_id) VALUES (?, ?)`).run(g2, t)).toThrow(/UNIQUE/);
    expect(() => db.prepare(`UPDATE quiz_groups SET result_assignment_id = ? WHERE id = ?`).run(r, g2)).toThrow(/UNIQUE/);
  });

  test('QuizError carries a code', () => {
    const e = new QuizError('PARITY', 'Questions differ');
    expect(e).toBeInstanceOf(Error);
    expect([e.code, e.message]).toEqual(['PARITY', 'Questions differ']);
  });
});
