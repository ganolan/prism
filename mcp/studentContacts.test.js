// #190: get_student_contacts serves a student's counselors only (names, primary, email); family contacts are not served.
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../server/db/index.js';
import { getStudentContactsTool } from './handlers.js';

let ana;
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM student_counselors; DELETE FROM parents; DELETE FROM students;');
  ana = db.prepare("INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Ana', 'Lee')").run().lastInsertRowid;
});

describe('get_student_contacts', () => {
  test('the counselors, primary first, with emails; no family contact', () => {
    const db = getDb();
    db.prepare("INSERT INTO parents (student_id, first_name, last_name, email) VALUES (?, 'Mei', 'Lee', 'mei@example.test')").run(ana);
    const add = db.prepare("INSERT INTO student_counselors (student_id, ps_user_dcid, first_name, last_name, is_primary, email, read_at) VALUES (?, ?, ?, ?, ?, ?, 'x')");
    add.run(ana, '72', 'Ann', 'Chan', 0, null);
    add.run(ana, '71', 'Sam', 'Lee', 1, 'slee@example.test');
    db.prepare("UPDATE students SET counselors_read_at = '2026-10-28T19:00:00.000Z' WHERE id = ?").run(ana);
    const r = getStudentContactsTool(db, { student: ana });
    expect(r).toMatchObject({
      student_id: ana,
      counselors: [
        { first_name: 'Sam', last_name: 'Lee', primary: true, email: 'slee@example.test' },
        { first_name: 'Ann', last_name: 'Chan', primary: false, email: null },
      ],
      counselors_read_at: '2026-10-28T19:00:00.000Z',
    });
    expect(JSON.stringify(r)).not.toContain('mei@example.test');
  });

  test('not read yet: an empty list and counselors_read_at null', () => {
    expect(getStudentContactsTool(getDb(), { student: 'u1' })).toMatchObject({ counselors: [], counselors_read_at: null });
  });
});
