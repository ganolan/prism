import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';

// Shared mutable DB handle the mocked getDb() returns.
const h = vi.hoisted(() => ({ db: null, features: { quizzes: true } }));

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDb: () => h.db };
});
vi.mock('./sync.js', () => ({ fullSync: vi.fn() }));
vi.mock('./masterySync.js', () => ({ syncMasteryForCourse: vi.fn() }));
vi.mock('./psAttendanceSync.js', () => ({ syncPsAttendance: vi.fn() }));
vi.mock('./psAlertsSync.js', () => ({ syncPsAlerts: vi.fn() }));
vi.mock('./quizRefresh.js', () => ({ refreshRecentQuizzes: vi.fn() }));
vi.mock('./submissionComments.js', () => ({ refreshRecentComments: vi.fn() }));
vi.mock('../middleware/featureGate.js', async (orig) => ({ ...(await orig()), getFeatures: () => h.features }));

import { fullSync } from './sync.js';
import { syncMasteryForCourse } from './masterySync.js';
import { syncPsAttendance } from './psAttendanceSync.js';
import { syncPsAlerts } from './psAlertsSync.js';
import { refreshRecentQuizzes } from './quizRefresh.js';
import { refreshRecentComments } from './submissionComments.js';
import { runUnifiedSync, classifyMasteryError } from './syncOrchestrator.js';
import { nightlyDataStatus } from './nightlyData.js';

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
    syncPsAlerts.mockReset();
    syncPsAlerts.mockResolvedValue({ students: 0, withAlerts: 0, failed: 0 });
    h.features = { quizzes: true };
  });

  test('#117: with powerschool_alerts on, the alerts phase runs after blocks; a failure is not fatal', async () => {
    h.features = { quizzes: true, powerschool_alerts: true };
    const cid = seedCourse(h.db, 'Chem');
    syncPsAlerts.mockResolvedValueOnce({ students: 40, withAlerts: 9, failed: 1 });
    const events = [];
    const summary = await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => events.push(e));
    expect(events.filter((e) => e.phase).map((e) => `${e.phase}:${e.status}`)).toEqual([
      'schoology:running', 'schoology:done', 'blocks:running', 'blocks:done',
      'alerts:running', 'alerts:done', 'mastery:running', 'mastery:done',
    ]);
    expect(events.find((e) => e.phase === 'alerts' && e.status === 'done')).toMatchObject({ records: 40, failed: 1 });
    expect(summary.alerts).toMatchObject({ students: 40, withAlerts: 9, failed: 1 });

    syncPsAlerts.mockRejectedValueOnce(new Error('Not logged in to Schoology: run `npm run mastery:login` and retry.'));
    const again = [];
    await runUnifiedSync({ masteryCourseIds: [cid] }, (e) => again.push(e));
    expect(again.find((e) => e.phase === 'alerts' && e.status === 'error')).toMatchObject({ errorKind: 'login' });
    expect(again.some((e) => e.phase === 'mastery' && e.status === 'done')).toBe(true);
    expect(again.at(-1).fatal).toBeUndefined();
  });

  describe('#171: the nightly-data stamp (last full read of blocks, calendar and alerts)', () => {
    const readAt = () => nightlyDataStatus(h.db, { schedulerActive: false }).readAt;

    test('stamped when blocks and alerts both finish', async () => {
      h.features = { quizzes: true, powerschool_alerts: true };
      await runUnifiedSync({}, () => {});
      expect(readAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('stamped when blocks finish with courses not ready (notReady > 0)', async () => {
      h.features = { quizzes: true, powerschool_alerts: true };
      syncPsAttendance.mockResolvedValueOnce({ updated: 1, skipped: 1, results: [{ reason: 'section-info-failed' }] });
      const summary = await runUnifiedSync({}, () => {});
      expect(summary.blocks.notReady).toBe(1);
      expect(readAt()).not.toBeNull();
    });

    test('stamped when blocks finish and the powerschool_alerts feature is off', async () => {
      h.features = { quizzes: true };
      await runUnifiedSync({}, () => {});
      expect(syncPsAlerts).not.toHaveBeenCalled();
      expect(readAt()).not.toBeNull();
    });

    test('not stamped when the blocks phase errors', async () => {
      h.features = { quizzes: true, powerschool_alerts: true };
      syncPsAttendance.mockRejectedValueOnce(new Error('PowerSchool down'));
      await runUnifiedSync({}, () => {});
      expect(readAt()).toBeNull();
    });

    test('not stamped when the alerts phase errors', async () => {
      h.features = { quizzes: true, powerschool_alerts: true };
      syncPsAlerts.mockRejectedValueOnce(new Error('alerts down'));
      await runUnifiedSync({}, () => {});
      expect(readAt()).toBeNull();
    });

    test('not stamped when syncBlocks is false', async () => {
      h.features = { quizzes: true, powerschool_alerts: true };
      await runUnifiedSync({ syncBlocks: false }, () => {});
      expect(syncPsAttendance).not.toHaveBeenCalled();
      expect(readAt()).toBeNull();
    });
  });

  test('#117: no alerts phase when the feature is off or PowerSchool is opted out', async () => {
    await runUnifiedSync({}, () => {});
    expect(syncPsAlerts).not.toHaveBeenCalled();
    h.features = { powerschool_alerts: true };
    await runUnifiedSync({ syncBlocks: false }, () => {});
    expect(syncPsAlerts).not.toHaveBeenCalled();
  });

  test('refreshQuizzes runs the quizzes phase last; a failure is not fatal', async () => {
    refreshRecentQuizzes.mockResolvedValue([{ status: 'done' }, { status: 'error', message: 'HTTP 500' }]);
    const events = [];
    const summary = await runUnifiedSync({ refreshQuizzes: true, syncBlocks: false }, (e) => events.push(e));
    const phases = events.filter(e => e.phase).map(e => `${e.phase}:${e.status}`);
    expect(phases).toEqual(['schoology:running', 'schoology:done', 'quizzes:running', 'quizzes:error']);
    expect(summary.quizzes).toMatchObject({ refreshed: 1, failed: 1 });
  });

  test('no quizzes phase without refreshQuizzes', async () => {
    const events = [];
    await runUnifiedSync({ syncBlocks: false }, (e) => events.push(e));
    expect(events.some(e => e.phase === 'quizzes')).toBe(false);
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
    syncPsAttendance.mockRejectedValue(new Error('Not logged in to Schoology: run `npm run mastery:login` and retry.'));
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

// #143: per-phase wall time, in the run summary and in sync_metrics, so the
// lazy-or-eager decision in #108 rests on numbers. A fake clock that each
// mocked phase advances makes the durations exact.
describe('runUnifiedSync — per-phase timing (#143)', () => {
  let clock;
  const advance = (ms) => { clock += ms; };

  beforeEach(() => {
    h.db = new Database(':memory:');
    migrate(h.db);
    clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    fullSync.mockReset();
    syncMasteryForCourse.mockReset();
    syncPsAttendance.mockReset();
    refreshRecentQuizzes.mockReset();
    fullSync.mockImplementation(async () => { advance(60_000); return { success: true, records: 42 }; });
    syncPsAttendance.mockImplementation(async () => { advance(8_500); return { updated: 1, skipped: 0 }; });
    syncMasteryForCourse.mockImplementation(async () => { advance(20_000); return { scoresCount: 3 }; });
    refreshRecentQuizzes.mockImplementation(async () => { advance(4_000); return [{ status: 'done' }]; });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  const metricsRows = () => h.db.prepare(
    'SELECT schoology_ms, blocks_ms, mastery_ms, quizzes_ms, total_ms FROM sync_metrics ORDER BY id'
  ).all();

  test('with submission comments on, a Comments phase reads recent threads and records its time', async () => {
    h.features = { quizzes: true, submission_comments: true };
    refreshRecentComments.mockReset();
    refreshRecentComments.mockImplementation(async () => { advance(7_000); return { assignments: 3, refreshed: 12, failed: 0 }; });
    const events = [];
    const summary = await runUnifiedSync({ syncBlocks: false }, (e) => events.push(e));
    expect(refreshRecentComments).toHaveBeenCalledTimes(1);
    expect(summary.phaseMs.comments).toBe(7_000);
    expect(summary.comments).toEqual({ assignments: 3, refreshed: 12, failed: 0, elapsedMs: 7_000 });
    expect(events).toContainEqual({ phase: 'comments', status: 'done', records: 12, elapsedMs: 7_000 });
    expect(h.db.prepare('SELECT comments_ms FROM sync_metrics ORDER BY id DESC LIMIT 1').get().comments_ms).toBe(7_000);
    h.features = { quizzes: true };
  });

  test('the summary carries an elapsedMs for every phase that ran', async () => {
    const c1 = seedCourse(h.db, 'Bio');
    const c2 = seedCourse(h.db, 'Chem');
    const events = [];
    const summary = await runUnifiedSync({ masteryCourseIds: [c1, c2], refreshQuizzes: true }, (e) => events.push(e));

    expect(summary.phaseMs).toEqual({ schoology: 60_000, blocks: 8_500, alerts: null, mastery: 40_000, comments: null, quizzes: 4_000 });
    expect(summary.schoology.elapsedMs).toBe(60_000);
    expect(summary.blocks.elapsedMs).toBe(8_500);
    expect(summary.mastery.map((m) => m.elapsedMs)).toEqual([20_000, 20_000]);
    expect(summary.quizzes.elapsedMs).toBe(4_000);

    expect(events.at(-1)).toMatchObject({ type: 'summary', elapsedMs: 112_500, phaseMs: summary.phaseMs });
  });

  test('every finished phase event carries its own elapsedMs', async () => {
    const cid = seedCourse(h.db, 'Bio');
    syncMasteryForCourse.mockImplementation(async () => { advance(5_000); throw new Error('page timeout'); });
    const events = [];
    await runUnifiedSync({ masteryCourseIds: [cid], refreshQuizzes: true }, (e) => events.push(e));
    const finished = events.filter((e) => e.phase && e.status !== 'running');
    expect(finished.map((e) => [e.phase, e.status, e.elapsedMs])).toEqual([
      ['schoology', 'done', 60_000],
      ['blocks', 'done', 8_500],
      ['mastery', 'error', 5_000],
      ['quizzes', 'done', 4_000],
    ]);
  });

  test('a blocks or quizzes failure still reports its time', async () => {
    syncPsAttendance.mockImplementation(async () => { advance(3_000); throw new Error('PowerSchool down'); });
    refreshRecentQuizzes.mockImplementation(async () => { advance(1_000); throw new Error('HTTP 500'); });
    const events = [];
    const summary = await runUnifiedSync({ refreshQuizzes: true }, (e) => events.push(e));
    expect(summary.phaseMs).toEqual({ schoology: 60_000, blocks: 3_000, alerts: null, mastery: null, comments: null, quizzes: 1_000 });
    expect(events.find((e) => e.phase === 'blocks' && e.status === 'error').elapsedMs).toBe(3_000);
    expect(events.find((e) => e.phase === 'quizzes' && e.status === 'error').elapsedMs).toBe(1_000);
  });

  test('a phase that did not run has a null time', async () => {
    const summary = await runUnifiedSync({ syncBlocks: false }, () => {});
    expect(summary.phaseMs).toEqual({ schoology: 60_000, blocks: null, alerts: null, mastery: null, comments: null, quizzes: null });
  });

  test('a fatal Schoology failure still reports how long it ran', async () => {
    fullSync.mockImplementation(async () => { advance(7_000); throw new Error('schoology API down'); });
    const events = [];
    const summary = await runUnifiedSync({}, (e) => events.push(e));
    expect(events.find((e) => e.phase === 'schoology' && e.status === 'error').elapsedMs).toBe(7_000);
    expect(events.at(-1)).toMatchObject({ type: 'summary', fatal: true, elapsedMs: 7_000 });
    expect(summary.phaseMs.schoology).toBe(7_000);
    expect(metricsRows()).toEqual([{ schoology_ms: 7_000, blocks_ms: null, mastery_ms: null, quizzes_ms: null, total_ms: 7_000 }]);
  });

  test('the times land on the sync_metrics row the Schoology phase wrote', async () => {
    const id = h.db.prepare(
      `INSERT INTO sync_metrics (started_at, duration_ms, submission_calls) VALUES ('2026-10-17T00:00:00Z', 59000, 12)`
    ).run().lastInsertRowid;
    fullSync.mockImplementation(async () => { advance(60_000); return { success: true, records: 42, metricsId: Number(id) }; });
    const cid = seedCourse(h.db, 'Bio');
    await runUnifiedSync({ masteryCourseIds: [cid], refreshQuizzes: true }, () => {});

    const rows = h.db.prepare('SELECT * FROM sync_metrics').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      duration_ms: 59000, submission_calls: 12,
      schoology_ms: 60_000, blocks_ms: 8_500, mastery_ms: 20_000, quizzes_ms: 4_000, total_ms: 92_500,
    });
  });

  test('a run without a Schoology phase writes its own sync_metrics row', async () => {
    const cid = seedCourse(h.db, 'Bio');
    await runUnifiedSync({ masteryCourseIds: [cid], skipSchoology: true, syncBlocks: false }, () => {});
    const rows = h.db.prepare('SELECT started_at, schoology_ms, blocks_ms, mastery_ms, quizzes_ms, total_ms FROM sync_metrics').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ schoology_ms: null, blocks_ms: null, mastery_ms: 20_000, quizzes_ms: null, total_ms: 20_000 });
    expect(rows[0].started_at).toBe(new Date(1_000_000).toISOString());
  });

  test('a sync_metrics write failure never fails the sync', async () => {
    h.db.exec('DROP TABLE sync_metrics');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events = [];
    const summary = await runUnifiedSync({ syncBlocks: false }, (e) => events.push(e));
    expect(summary.phaseMs.schoology).toBe(60_000);
    expect(events.at(-1)).toMatchObject({ type: 'summary' });
    expect(events.at(-1).fatal).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('runUnifiedSync with a course list (#58)', () => {
  beforeEach(() => {
    h.db = new Database(':memory:');
    migrate(h.db);
    fullSync.mockReset();
    syncMasteryForCourse.mockReset().mockResolvedValue({ scoresCount: 1 });
    syncPsAttendance.mockReset().mockResolvedValue({ updated: 0, skipped: 0 });
    syncPsAlerts.mockReset().mockResolvedValue({ students: 0, withAlerts: 0, failed: 0 });
    refreshRecentComments.mockReset().mockResolvedValue({ assignments: 0, refreshed: 0, failed: 0 });
    h.features = { powerschool_alerts: true, submission_comments: true };
  });

  test('passes the list to every phase and skips mastery for an archived course already read', async () => {
    const a = seedCourse(h.db, 'A');
    const old = seedCourse(h.db, 'Old');
    fullSync.mockResolvedValue({ success: true, records: 1, archivedRead: [old] });
    await runUnifiedSync({ courseIds: [a, old], masteryCourseIds: [a, old] }, () => {});
    expect(fullSync.mock.calls[0][1]).toMatchObject({ courseIds: [a, old] });
    // The PowerSchool block pass stays whole: it also stores the school calendar (review #1).
    expect(syncPsAttendance.mock.calls[0][0].courseIds).toBeUndefined();
    expect(syncPsAlerts.mock.calls[0][0]).toMatchObject({ courseIds: [a, old] });
    expect(refreshRecentComments.mock.calls[0][1]).toMatchObject({ courseIds: [a, old] });
    expect(syncMasteryForCourse.mock.calls.map((c) => c[0])).toEqual([a]);
  });

  test('no list: the phases get courseIds null', async () => {
    fullSync.mockResolvedValue({ success: true, records: 1 });
    await runUnifiedSync({}, () => {});
    expect(fullSync.mock.calls[0][1].courseIds).toBeNull();
    expect(syncPsAttendance.mock.calls[0][0].courseIds).toBeUndefined();
  });
});

describe('runUnifiedSync: "Synced" only for complete syncs (background sync)', () => {
  const T = '2026-10-20T00:00:00.000Z';
  let a; let b; let ta; let tb;
  beforeEach(() => {
    h.db = new Database(':memory:');
    migrate(h.db);
    a = seedCourse(h.db, 'A'); b = seedCourse(h.db, 'B');
    const task = (c, ext) => h.db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, ?, ?)`).run(c, ext, ext).lastInsertRowid;
    ta = task(a, 'TA'); tb = task(b, 'TB');
    fullSync.mockReset().mockResolvedValue({
      success: true, records: 1, archivedRead: [], archivedComplete: [], readCourseIds: [a, b],
      complete: { courseIds: [a, b], taskIdsByCourse: { [a]: [ta], [b]: [tb] } },
    });
    syncMasteryForCourse.mockReset().mockResolvedValue({ scoresCount: 1 });
    syncPsAttendance.mockReset().mockResolvedValue({ updated: 0, skipped: 0 });
    syncPsAlerts.mockReset().mockResolvedValue({ students: 0, withAlerts: 0, failed: 0 });
    refreshRecentComments.mockReset().mockResolvedValue({ assignments: 0, refreshed: 0, failed: 0, failedCourseIds: [] });
    h.features = { submission_comments: true };
  });
  const row = (table, id, cols) => h.db.prepare(`SELECT ${cols} FROM ${table} WHERE id = ?`).get(id);

  test('a course whose mastery fails keeps its old time but is marked attempted; the other is stamped', async () => {
    syncMasteryForCourse.mockImplementation(async (id) => { if (id === a) throw new Error('Schoology API 500'); return { scoresCount: 1 }; });
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(T);
    await runUnifiedSync({ courseIds: [a, b], masteryCourseIds: [a, b], syncBlocks: false }, () => {});
    vi.restoreAllMocks();
    expect(row('courses', a, 'course_synced_at, sync_attempted_at')).toEqual({ course_synced_at: null, sync_attempted_at: T });
    expect(row('courses', b, 'course_synced_at, sync_attempted_at')).toEqual({ course_synced_at: T, sync_attempted_at: T });
    expect(row('assignments', ta, 'task_synced_at, task_sync_attempted_at')).toEqual({ task_synced_at: null, task_sync_attempted_at: T });
    expect(row('assignments', tb, 'task_synced_at')).toEqual({ task_synced_at: T });
  });

  test('a comment-thread failure for a course withholds its time', async () => {
    refreshRecentComments.mockResolvedValue({ assignments: 1, refreshed: 0, failed: 1, failedCourseIds: [b] });
    await runUnifiedSync({ courseIds: [a, b], masteryCourseIds: [a, b], syncBlocks: false }, () => {});
    expect(row('courses', a, 'course_synced_at').course_synced_at).not.toBeNull();
    expect(row('courses', b, 'course_synced_at').course_synced_at).toBeNull();
  });

  test('an archived course read complete through finalize is stamped without the mastery phase', async () => {
    fullSync.mockResolvedValue({
      success: true, records: 1, archivedRead: [b], archivedComplete: [b], readCourseIds: [b],
      complete: { courseIds: [], taskIdsByCourse: { [b]: [tb] } },
    });
    await runUnifiedSync({ courseIds: [b], masteryCourseIds: [b], syncBlocks: false }, () => {});
    expect(syncMasteryForCourse).not.toHaveBeenCalled();
    expect(row('courses', b, 'course_synced_at').course_synced_at).not.toBeNull();
  });
});

