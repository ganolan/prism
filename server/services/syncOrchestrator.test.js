import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';

// Shared mutable DB handle the mocked getDb() returns.
const h = vi.hoisted(() => ({ db: null }));

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDb: () => h.db };
});
vi.mock('./sync.js', () => ({ fullSync: vi.fn() }));
vi.mock('./masterySync.js', () => ({ syncMasteryForCourse: vi.fn() }));
vi.mock('./psAttendanceSync.js', () => ({ syncPsAttendance: vi.fn() }));

import { fullSync } from './sync.js';
import { syncMasteryForCourse } from './masterySync.js';
import { syncPsAttendance } from './psAttendanceSync.js';
import { runUnifiedSync, classifyMasteryError } from './syncOrchestrator.js';

function seedCourse(db, name) {
  return db.prepare(
    `INSERT INTO courses (schoology_section_id, course_name) VALUES (?, ?)`
  ).run(`sec-${name}`, name).lastInsertRowid;
}

describe('classifyMasteryError', () => {
  test('login errors classified as login', () => {
    expect(classifyMasteryError(new Error('Not logged in to Schoology'))).toBe('login');
    expect(classifyMasteryError(new Error('Run `npm run mastery:login`'))).toBe('login');
  });
  test('other errors classified as other', () => {
    expect(classifyMasteryError(new Error('page load timeout'))).toBe('other');
  });
});

describe('runUnifiedSync', () => {
  beforeEach(() => {
    h.db = new Database(':memory:');
    migrate(h.db);
    fullSync.mockReset();
    syncMasteryForCourse.mockReset();
    syncPsAttendance.mockReset();
    fullSync.mockResolvedValue({ success: true, records: 42 });
    syncMasteryForCourse.mockResolvedValue({ scoresCount: 7 });
    syncPsAttendance.mockResolvedValue({ updated: 0, skipped: 0 });
  });

  test('runs Schoology before mastery and emits ordered events', async () => {
    const cid = seedCourse(h.db, 'Biology 9');
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid], syncBlocks: false }, (e) => events.push(e));

    const phases = events.filter((e) => e.phase);
    expect(phases[0]).toMatchObject({ phase: 'schoology', status: 'running' });
    expect(phases[1]).toMatchObject({ phase: 'schoology', status: 'done', records: 42 });
    expect(phases[2]).toMatchObject({ phase: 'mastery', status: 'running' });
    expect(phases.some((e) => e.phase === 'schoology' && e.status === 'done' && e.records === 42)).toBe(true);
    expect(phases.some((e) => e.phase === 'mastery' && e.status === 'done' && e.records === 7)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'summary' });

    const logRow = h.db.prepare(`SELECT status, completed_at FROM sync_log WHERE sync_type = 'mastery'`).get();
    expect(logRow.status).toBe('completed');
    expect(logRow.completed_at).not.toBeNull();
  });

  test('skipSchoology omits the Schoology phase', async () => {
    const cid = seedCourse(h.db, 'Chem 11');
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid], skipSchoology: true }, (e) => events.push(e));
    expect(fullSync).not.toHaveBeenCalled();
    expect(events.some((e) => e.phase === 'schoology')).toBe(false);
    expect(syncMasteryForCourse).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.phase === 'mastery' && e.status === 'done')).toBe(true);
  });

  test('one mastery course failing does not abort the others', async () => {
    const c1 = seedCourse(h.db, 'Course A');
    const c2 = seedCourse(h.db, 'Course B');
    syncMasteryForCourse
      .mockRejectedValueOnce(new Error('Not logged in to Schoology'))
      .mockResolvedValueOnce({ scoresCount: 3 });
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [c1, c2] }, (e) => events.push(e));

    const masteryDone = events.filter((e) => e.phase === 'mastery' && e.status === 'done');
    const masteryErr = events.filter((e) => e.phase === 'mastery' && e.status === 'error');
    expect(masteryDone).toHaveLength(1);
    expect(masteryErr).toHaveLength(1);
    expect(masteryErr[0].errorKind).toBe('login');

    const statuses = h.db.prepare(`SELECT status FROM sync_log WHERE sync_type = 'mastery' ORDER BY id`).all().map((r) => r.status);
    expect(statuses.sort()).toEqual(['completed', 'error']);
  });

  test('a Schoology failure skips the mastery phase', async () => {
    const cid = seedCourse(h.db, 'Bio');
    fullSync.mockRejectedValue(new Error('schoology API down'));
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));
    expect(syncMasteryForCourse).not.toHaveBeenCalled();
    expect(events.some((e) => e.phase === 'schoology' && e.status === 'error')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'summary', fatal: true });
  });

  test('runs the block phase by default, between schoology and mastery', async () => {
    const cid = seedCourse(h.db, 'Bio 9');
    syncPsAttendance.mockResolvedValue({ updated: 2, skipped: 1, gradeLevels: { seen: 30, updated: 28 } });
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));

    expect(syncPsAttendance).toHaveBeenCalledOnce();
    const order = events.filter((e) => e.phase).map((e) => `${e.phase}:${e.status}`);
    expect(order).toEqual([
      'schoology:running', 'schoology:done',
      'blocks:running', 'blocks:done',
      'mastery:running', 'mastery:done',
    ]);
    expect(events.find((e) => e.phase === 'blocks' && e.status === 'done')).toMatchObject({ records: 2 });
    const blocksDone = events.find(e => e.phase === 'blocks' && e.status === 'done');
    expect(blocksDone.gradeLevelsUpdated).toBe(28);
  });

  test('the blocks done event counts section-info-failed courses as notReady (#126)', async () => {
    const cid = seedCourse(h.db, 'Bio 9b');
    syncPsAttendance.mockResolvedValue({
      updated: 0,
      skipped: 3,
      gradeLevels: { seen: 0, updated: 0 },
      results: [
        { courseId: 1, courseName: 'AI & Machine Learning', reason: 'section-info-failed', status: 'skipped' },
        { courseId: 2, courseName: 'PCG', reason: 'not-numbered', status: 'skipped' },
        { courseId: 3, courseName: 'Robotics', reason: 'section-info-failed', status: 'skipped' },
      ],
    });
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));

    const blocksDone = events.find((e) => e.phase === 'blocks' && e.status === 'done');
    // 2 section-info-failed rows count toward notReady; the not-numbered PCG
    // row (expected/normal, not a PowerSchool-not-ready case) does not.
    expect(blocksDone.notReady).toBe(2);
  });

  test('syncBlocks:false skips the block phase entirely (no browser launch)', async () => {
    const cid = seedCourse(h.db, 'Bio 10');
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid], syncBlocks: false }, (e) => events.push(e));
    expect(syncPsAttendance).not.toHaveBeenCalled();
    expect(events.some((e) => e.phase === 'blocks')).toBe(false);
  });

  test('a block-sync failure is non-fatal — mastery still runs', async () => {
    const cid = seedCourse(h.db, 'Bio 11');
    syncPsAttendance.mockRejectedValue(new Error('PowerSchool session stale'));
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));

    expect(events.some((e) => e.phase === 'blocks' && e.status === 'error')).toBe(true);
    expect(events.some((e) => e.phase === 'mastery' && e.status === 'done')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'summary' });
    expect(events.at(-1).fatal).toBeUndefined();
  });

  // A stale/expired Schoology session is the same shared browser session used
  // by mastery — classify it the same way so the sync UI can offer the same
  // "log in and retry" remedy for the blocks phase (#126 follow-up: this
  // failure mode was previously an unclassified, easy-to-miss phase error).
  test('a blocks-phase login failure is classified errorKind:login', async () => {
    const cid = seedCourse(h.db, 'Bio 12');
    syncPsAttendance.mockRejectedValue(new Error('Not logged in to Schoology — run `npm run mastery:login` and retry.'));
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));

    const blocksErr = events.find((e) => e.phase === 'blocks' && e.status === 'error');
    expect(blocksErr.errorKind).toBe('login');
  });

  test('a non-login blocks-phase failure is classified errorKind:other', async () => {
    const cid = seedCourse(h.db, 'Bio 13');
    syncPsAttendance.mockRejectedValue(new Error('PowerSchool attendance app did not load'));
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));

    const blocksErr = events.find((e) => e.phase === 'blocks' && e.status === 'error');
    expect(blocksErr.errorKind).toBe('other');
  });
});

// Fix round 1 (C1): rubric levels are in the visible-feedback fingerprint, so each
// mastery pull must re-snapshot its course — or the next revision is judged against
// stale levels and silently counted as already answered.
describe('runUnifiedSync — snapshots after each mastery pull', () => {
  beforeEach(() => {
    h.db = new Database(':memory:');
    migrate(h.db);
    fullSync.mockReset();
    syncMasteryForCourse.mockReset();
    syncPsAttendance.mockReset();
    fullSync.mockResolvedValue({ success: true, records: 0 });
    syncPsAttendance.mockResolvedValue({ updated: 0, skipped: 0 });
  });

  test('capture → mastery pull changes levels → capture → new revision → capture → arrived', async () => {
    const { captureFeedbackSnapshots } = await import('./feedbackSnapshots.js');
    const { resubmissionByStudent } = await import('./resubmissions.js');
    const db = h.db;
    const cid = seedCourse(db, 'AIML');
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat', ?, 'X', 'C')`).run(cid);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat', ?, 'X.1', 'T')`).run(cid);
    const sid = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Maya', 'Chen')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(sid, cid);
    const aid = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'a1', 'Project', 1)`).run(cid).lastInsertRowid;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, score, submitted_at, latest_revision_at) VALUES (?, ?, 80, 50, 100)`).run(sid, aid);
    captureFeedbackSnapshots(db);                                   // end of a sync, before levels exist
    syncMasteryForCourse.mockImplementation(async () => {
      db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'a1', 't1', 75, 'EX')`).run();
      return { scoresCount: 1 };
    });
    await runUnifiedSync({ masteryCourseIds: [cid], skipSchoology: true, syncBlocks: false }, () => {});
    db.prepare('UPDATE grades SET latest_revision_at = 200').run(); // the student resubmits
    captureFeedbackSnapshots(db);
    expect(resubmissionByStudent(db, aid).get(sid)?.state).toBe('arrived');
  });

  test('a capture failure after a pull never fails the mastery phase', async () => {
    const cid = seedCourse(h.db, 'AIML');
    syncMasteryForCourse.mockImplementation(async () => {
      h.db.exec('DROP TABLE feedback_snapshots');                   // force the capture to throw
      return { scoresCount: 0 };
    });
    const summary = await runUnifiedSync({ masteryCourseIds: [cid], skipSchoology: true, syncBlocks: false }, () => {});
    expect(summary.mastery).toMatchObject([{ status: 'done' }]);
  });
});
