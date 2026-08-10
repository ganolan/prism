import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate, __setTestDb } from '../db/index.js';
import { persistRollups, getMasteryForCourse } from './masterySync.js';

// persistRollups is the DB seam of the full Playwright mastery sync: it writes
// Schoology's per-(student, objective) rollups for ONE course. The rollups are
// what drive the "SCHOOLOGY" proficiency columns + letter grade. Because
// objective UUIDs are district-global (shared across the teacher's courses), a
// multi-course student must keep a SEPARATE rollup per course — the heart of
// #127.

function makeDb() {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO courses (id, schoology_section_id, course_name) VALUES (7,'s7','MAD'),(9,'s9','Robotics')`).run();
  return db;
}

const NOW = '2026-06-17T00:00:00.000Z';
const rollup = (over = {}) => ({
  student_uid: 'stuA', objective_id: 'objX', is_category: 1,
  grade_percentage: 87.5, grade_scaled_rounded: 87.5, override_value: null, ...over,
});

function rowsFor(db, uid, obj) {
  return db.prepare(
    `SELECT course_id, grade_percentage FROM mastery_rollups
     WHERE student_uid=? AND objective_id=? ORDER BY course_id`
  ).all(uid, obj);
}

describe('persistRollups — rollups are kept per course (#127)', () => {
  let db;
  beforeEach(() => { db = makeDb(); });

  test('a shared objective synced under two courses yields one rollup PER course', () => {
    persistRollups(db, 7, [rollup({ grade_percentage: 87.5 })], NOW);
    persistRollups(db, 9, [rollup({ grade_percentage: 62.5 })], NOW);

    expect(rowsFor(db, 'stuA', 'objX')).toEqual([
      { course_id: 7, grade_percentage: 87.5 },
      { course_id: 9, grade_percentage: 62.5 },
    ]);
  });

  test('re-syncing a course replaces its own rollups without touching another course', () => {
    persistRollups(db, 7, [rollup({ student_uid: 'stuA' })], NOW);
    persistRollups(db, 9, [rollup({ student_uid: 'stuA' })], NOW);

    // stuA dropped MAD (course 7) — next MAD sync no longer returns them.
    persistRollups(db, 7, [rollup({ student_uid: 'stuB' })], NOW);

    // stuA's MAD rollup is gone (stale cleared); their Robotics rollup remains.
    expect(rowsFor(db, 'stuA', 'objX')).toEqual([{ course_id: 9, grade_percentage: 87.5 }]);
    // stuB now has the MAD rollup.
    expect(rowsFor(db, 'stuB', 'objX')).toEqual([{ course_id: 7, grade_percentage: 87.5 }]);
  });

  test('returns the number of rollups written', () => {
    const n = persistRollups(db, 7, [rollup({ student_uid: 'a' }), rollup({ student_uid: 'b' })], NOW);
    expect(n).toBe(2);
  });
});

describe('getMasteryForCourse — global objectives render on a non-owning course (#127)', () => {
  // reporting_categories / measurement_topics are district-global: one row per
  // UUID, "owned" (course_id) by whichever section first synced it. The mastery
  // reads must reach them via THIS course's scores, NEVER by the objective's own
  // course_id — otherwise a shared standard would vanish on every course except
  // its arbitrary owner. This pins that contract.
  let owner, other;
  const CAT = 'cat-global', TOP = 'top-global', UID = 'uid-cmp';

  beforeEach(() => {
    const db = makeDb();   // courses 7 + 9 inserted; reuse them as owner/other
    __setTestDb(db);       // getMasteryForCourse reads via getDb()
    owner = 7; other = 9;
    // Objective rows owned by `owner` — but the assignment + score live in `other`.
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES (?, ?, 'ART.5', 'Produce')`).run(CAT, owner);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES (?, ?, ?, 'ART.5.1', 'Sketching')`).run(TOP, CAT, owner);
    db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'C', 'M')`).run(UID);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'a-oth', 'Proj', 1)`).run(other);
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES (?, 'a-oth', ?, 100, 'ED')`).run(UID, TOP);
  });

  test('the non-owning course surfaces the shared topic, category and score', () => {
    const { topics, categories, scores } = getMasteryForCourse(String(other));
    expect(topics.map(t => t.id)).toContain(TOP);
    expect(categories.map(c => c.id)).toContain(CAT);
    expect(scores.find(s => s.student_uid === UID && s.topic_id === TOP)?.grade).toBe('ED');
  });
});
