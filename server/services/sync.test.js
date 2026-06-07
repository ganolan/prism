import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';

vi.mock('./schoology.js', () => ({
  getMyUserId: vi.fn(),
  getMySections: vi.fn(),
  getSectionEnrollments: vi.fn(),
  getSectionAssignments: vi.fn(),
  getSectionGrades: vi.fn(),
  getSectionGradingPeriods: vi.fn(),
  getSectionFolders: vi.fn(),
  getSectionGradingCategories: vi.fn(),
  getSectionGradingScales: vi.fn(),
  getUserProfile: vi.fn(),
  getSubmissionStatus: vi.fn(),
  getSection: vi.fn(),
  getUserProfilesBatch: vi.fn(),
  getAssignmentSubmissions: vi.fn(),
}));

// fullSync calls createSubmissionFetcher(), which would launch a headless
// browser. Mock it to a no-op (returns null → public-API-only behavior), so
// the suite never touches Playwright. syncSectionData GHD wiring is tested
// directly below by injecting opts.fetchSubmissionLookup.
vi.mock('./graderSubmissions.js', () => ({
  createSubmissionFetcher: vi.fn().mockResolvedValue(null),
}));

vi.mock('./masterySync.js', () => ({
  syncMasteryForCourse: vi.fn().mockResolvedValue({ scoresCount: 0 }),
  hasMasterySession: vi.fn(() => false),
}));

import {
  getSectionEnrollments,
  getSectionAssignments,
  getSectionGrades,
  getSubmissionStatus,
  getAssignmentSubmissions,
  getUserProfilesBatch,
  getSectionGradingPeriods,
  getUserProfile,
  getSection,
} from './schoology.js';
import { syncMasteryForCourse, hasMasterySession } from './masterySync.js';
import { syncSectionData, retrySubmissions, fullSync, enrichStudentProfiles, finalizeArchivedCourse, detectArchivedTransitions, backfillUnfinalizedArchived } from './sync.js';

describe('syncSectionData — assignee mapping (#54)', () => {
  let db;
  let courseId;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Algebra')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getSubmissionStatus.mockReset();
    getSectionGrades.mockResolvedValue([]);
    getSubmissionStatus.mockResolvedValue(null);
  });

  test('translates Schoology assignees[] (enrollment ids) into user UIDs', async () => {
    // Schoology returns enrollment ids in `assignees`, not user uids.
    getSectionEnrollments.mockResolvedValue([
      { id: '900001', uid: '700001', name_first: 'Ada', name_last: 'Lovelace', admin: '0' },
      { id: '900002', uid: '700002', name_first: 'Alan', name_last: 'Turing', admin: '0' },
      { id: '900003', uid: '700003', name_first: 'Grace', name_last: 'Hopper', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      {
        id: '5001', title: 'Targeted to two students', published: 1,
        num_assignees: 2,
        // Enrollment ids — must be mapped to uids 700001 and 700003 before insert.
        assignees: '[900001,900003]',
      },
    ]);

    await syncSectionData(db, 'sec-1', courseId, new Date().toISOString());

    const rows = db.prepare(`
      SELECT aa.schoology_uid
      FROM assignment_assignees aa
      JOIN assignments a ON a.id = aa.assignment_id
      WHERE a.schoology_assignment_id = '5001'
      ORDER BY aa.schoology_uid
    `).all();
    expect(rows.map(r => r.schoology_uid)).toEqual(['700001', '700003']);
  });

  test('open-to-all assignment (empty assignees) writes no rows', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '900001', uid: '700001', name_first: 'Ada', name_last: 'Lovelace', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: '5002', title: 'Open', published: 1, num_assignees: 0, assignees: '[]' },
    ]);

    await syncSectionData(db, 'sec-1', courseId, new Date().toISOString());

    const count = db.prepare(`
      SELECT COUNT(*) AS n FROM assignment_assignees aa
      JOIN assignments a ON a.id = aa.assignment_id
      WHERE a.schoology_assignment_id = '5002'
    `).get().n;
    expect(count).toBe(0);
  });

  test('skips assignees whose enrollment id is not in this section (defensive)', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '900001', uid: '700001', name_first: 'Ada', name_last: 'Lovelace', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      {
        id: '5003', title: 'Mixed', published: 1, num_assignees: 2,
        assignees: '[900001,999999]', // 999999 not enrolled here
      },
    ]);

    await syncSectionData(db, 'sec-1', courseId, new Date().toISOString());

    const rows = db.prepare(`
      SELECT aa.schoology_uid FROM assignment_assignees aa
      JOIN assignments a ON a.id = aa.assignment_id
      WHERE a.schoology_assignment_id = '5003'
    `).all();
    expect(rows.map(r => r.schoology_uid)).toEqual(['700001']);
  });
});

describe('syncSectionData — phase atomicity (#55)', () => {
  let db;
  let courseId;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-9', 'TX Test')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getSubmissionStatus.mockReset();
    getSectionGrades.mockResolvedValue([]);
    getSubmissionStatus.mockResolvedValue(null);
  });

  test('failed assignments fetch leaves no assignment rows written for the section', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockRejectedValue(new Error('boom'));

    await expect(
      syncSectionData(db, 'sec-9', courseId, new Date().toISOString())
    ).rejects.toThrow();

    const rows = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE course_id = ?').get(courseId);
    expect(rows.n).toBe(0);
  });
});

describe('syncSectionData — per-assignment atomicity (#55)', () => {
  let db;
  let courseId;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-A', 'Atomicity')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getAssignmentSubmissions.mockReset();
    getSectionGrades.mockResolvedValue([]);
  });

  test('one 429 on assignment A leaves all of A unwritten; B fully written', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
      { id: '802', uid: '702', name_first: 'Bob', name_last: 'M', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'A1', title: 'A', published: 1, allow_dropbox: '1' },
      { id: 'A2', title: 'B', published: 1, allow_dropbox: '1' },
    ]);
    getAssignmentSubmissions.mockImplementation(async (sid, aid) => {
      if (aid === 'A1') { const e = new Error('429'); e.rateLimited = true; e.transient = true; throw e; }
      return [
        { revision_id: 1, uid: '701', created: 1000, late: 0, draft: 0 },
        { revision_id: 1, uid: '702', created: 1000, late: 0, draft: 0 },
      ];
    });

    const result = await syncSectionData(db, 'sec-A', courseId, new Date().toISOString());
    expect(result.failedAssignmentIds).toEqual(['A1']);

    const a1 = db.prepare(`SELECT g.* FROM grades g JOIN assignments a ON a.id=g.assignment_id WHERE a.schoology_assignment_id='A1'`).all();
    expect(a1.length).toBe(0);
    const a2 = db.prepare(`SELECT g.* FROM grades g JOIN assignments a ON a.id=g.assignment_id WHERE a.schoology_assignment_id='A2'`).all();
    expect(a2.length).toBe(2);
  });

  test('abandonAfter threshold short-circuits remaining bulk fetches', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ id: `T${i}`, title: `T${i}`, published: 1, allow_dropbox: '1' }))
    );
    let callCount = 0;
    getAssignmentSubmissions.mockImplementation(async () => {
      callCount++; const e = new Error('429'); e.rateLimited = true; e.transient = true; throw e;
    });

    const result = await syncSectionData(
      db, 'sec-A', courseId, new Date().toISOString(),
      { submissionAbandonAfter: 3 }
    );
    expect(result.failedAssignmentIds.length).toBe(3);
    expect(result.submissionAbandoned).toBe(true);
    expect(callCount).toBeLessThanOrEqual(3);
  });
});

describe('retrySubmissions (#55)', () => {
  let db; let courseId;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-R', 'R')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'RA1', 'A', 1)`).run(courseId);
    db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'Ada', 'L')`).run();
    getSectionEnrollments.mockReset();
    getAssignmentSubmissions.mockReset();
  });

  test('retry succeeds → row written, retries_succeeded incremented', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getAssignmentSubmissions.mockResolvedValue([
      { revision_id: 1, uid: '701', created: 1234, late: 0, draft: 0 },
    ]);
    const metrics = { submission_calls: 0, rate_limit_hits: 0, transient_failures: 0, retries_succeeded: 0, retries_failed: 0 };
    const stillFailing = await retrySubmissions(db, [{ sectionId: 'sec-R', courseId, assignmentExtId: 'RA1' }], new Date().toISOString(), metrics);
    expect(stillFailing).toEqual([]);
    expect(metrics.retries_succeeded).toBe(1);
    const rows = db.prepare(`SELECT g.* FROM grades g JOIN assignments a ON a.id=g.assignment_id WHERE a.schoology_assignment_id='RA1'`).all();
    expect(rows.length).toBe(1);
  });

  test('retry 429s again → no row written, returned in stillFailing, retries_failed=1', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getAssignmentSubmissions.mockImplementation(async () => { const e = new Error('429'); e.rateLimited = true; e.transient = true; throw e; });
    const metrics = { submission_calls: 0, rate_limit_hits: 0, transient_failures: 0, retries_succeeded: 0, retries_failed: 0 };
    const entry = { sectionId: 'sec-R', courseId, assignmentExtId: 'RA1' };
    const stillFailing = await retrySubmissions(db, [entry], new Date().toISOString(), metrics);
    expect(stillFailing).toEqual([entry]);
    expect(metrics.rate_limit_hits).toBe(1);
    expect(metrics.retries_failed).toBe(1);
    const rows = db.prepare(`SELECT g.* FROM grades g JOIN assignments a ON a.id=g.assignment_id WHERE a.schoology_assignment_id='RA1'`).all();
    expect(rows.length).toBe(0);
  });
});

describe('syncSectionData — internal-gradebook submission state (#62/#55)', () => {
  let db;
  let courseId;

  // Minimal stand-in for buildSubmissionLookup()'s return value — only .get()
  // is consumed by syncSectionData. `cells` maps "uid:assignmentId" → cell.
  function fakeLookup(cells) {
    return { get: (uid, aid) => cells[`${uid}:${aid}`] };
  }

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-G', 'Gradebook')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getSubmissionStatus.mockReset();
    getAssignmentSubmissions.mockReset();
    getSectionGrades.mockResolvedValue([]);
    getSubmissionStatus.mockResolvedValue(null); // public API blind to OneDrive
    getAssignmentSubmissions.mockResolvedValue([]);
  });

  function getGradeRow(uid, assignmentExtId) {
    return db.prepare(`
      SELECT g.* FROM grades g
      JOIN assignments a ON a.id = g.assignment_id
      JOIN students s ON s.id = g.student_id
      WHERE a.schoology_assignment_id = ? AND s.schoology_uid = ?
    `).get(assignmentExtId, uid);
  }

  test('lti_submission assignment is excluded from the per-cell GHD walk (#62) — fetchDocuments path owns it', async () => {
    // lti_submission assignments now go through the fetchDocuments path, NOT the
    // per-cell GHD/public-API walk. With only fetchSubmissionLookup provided (no
    // fetchDocuments), the lti pass is a no-op — the public revisions API is never
    // called and submissionSkipped stays 0.
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);

    const result = await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchSubmissionLookup: async () => fakeLookup({ '701:L1': { submitted: true, submissionType: 'drop' } }),
    });

    // lti assignments are excluded from nativeDropboxAssignments, so neither the
    // per-cell GHD lookup nor the public revisions API is invoked.
    expect(getSubmissionStatus).not.toHaveBeenCalled();
    expect(getAssignmentSubmissions).not.toHaveBeenCalled();
    expect(result.submissionSkipped).toBe(0);
    // Without fetchDocuments, no lti_submission_state row is written.
    expect(getGradeRow('701', 'L1')).toBeUndefined();
  });

  test('lti_submission assignment is excluded from per-cell walk even for "not submitted" GHD (#55/#62)', async () => {
    // Previously the GHD "not submitted" path skipped the public call and reported
    // submissionSkipped. Now lti assignments bypass the per-cell loop entirely.
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);

    const result = await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchSubmissionLookup: async () => fakeLookup({ '701:L1': { submitted: false, submissionType: null } }),
    });

    expect(getSubmissionStatus).not.toHaveBeenCalled();
    expect(getAssignmentSubmissions).not.toHaveBeenCalled();
    expect(result.submissionSkipped).toBe(0);
    // No row written — lti pass is no-op without fetchDocuments.
    expect(getGradeRow('701', 'L1')).toBeUndefined();
  });

  test('fetchDocuments upgrades an existing graded row with lti_submission_state, preserving score', async () => {
    // Previously tested via GHD + submission_type. Now lti state is written by
    // the fetchDocuments pass into lti_submission_state; score must not be clobbered.
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission', max_points: 16 },
    ]);
    // A graded row already exists from the grades phase.
    getSectionGrades.mockResolvedValue([
      { enrollment_id: '801', assignment_id: 'L1', grade: 14, max_points: 16, timestamp: 1000 },
    ]);

    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => new Map([['701', 'submitted']]),
    });

    const row = getGradeRow('701', 'L1');
    expect(row.score).toBe(14);                          // score not clobbered
    expect(row.lti_submission_state).toBe('submitted');  // state written
  });

  test('GHD-uncovered native cell uses the bulk revision and leaves submission_type null', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'N1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    getAssignmentSubmissions.mockResolvedValue([
      { revision_id: 1, uid: '701', created: 2000, late: 1, draft: 0 },
    ]);

    const result = await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchSubmissionLookup: async () => fakeLookup({}), // uncovered
    });

    expect(getAssignmentSubmissions).toHaveBeenCalledWith('sec-G', 'N1');
    const row = getGradeRow('701', 'N1');
    expect(row.late).toBe(1);
    expect(row.submission_type).toBeNull();
    expect(result.submissionSkipped).toBe(0);
  });

  test('#62: lti assignment writes lti_submission_state via fetchDocuments and skips the per-cell walk', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
      { id: '802', uid: '702', name_first: 'Bo', name_last: 'M', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);

    const docCalls = [];
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async (aid) => { docCalls.push(aid); return new Map([['701', 'submitted'], ['702', 'not_started']]); },
    });

    // The per-assignment documents path is used; the per-cell public walk is NOT
    // used for lti work (L1 is excluded from nativeDropboxAssignments).
    expect(docCalls).toEqual(['L1']);
    expect(getSubmissionStatus).not.toHaveBeenCalled();
    expect(getAssignmentSubmissions).not.toHaveBeenCalled();
    expect(getGradeRow('701', 'L1').lti_submission_state).toBe('submitted');
    // A not_started cell inserts a row so the state reaches the gradebook.
    expect(getGradeRow('702', 'L1').lti_submission_state).toBe('not_started');
  });
});

describe('syncSectionData — skipSubmissions opt (#72)', () => {
  let db;
  let courseId;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-S', 'Archived')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getSubmissionStatus.mockReset();
    getSectionGrades.mockResolvedValue([]);
    getAssignmentSubmissions.mockReset();
    getAssignmentSubmissions.mockResolvedValue([{ revision_id: 1, uid: '701', created: 2000, late: 1, draft: 0 }]);
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'D1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
  });

  test('skipSubmissions:true does not fetch submissions and reports zero', async () => {
    const result = await syncSectionData(db, 'sec-S', courseId, new Date().toISOString(), { skipSubmissions: true });
    expect(getAssignmentSubmissions).not.toHaveBeenCalled();
    expect(result.submissionCount).toBe(0);
    expect(result.submissionAttempts).toBe(0);
    expect(result.submissionSkipped).toBe(0);
    expect(result.failedAssignmentIds).toEqual([]);
  });

  test('without skipSubmissions the same setup DOES bulk-fetch submissions (opt defaults off)', async () => {
    await syncSectionData(db, 'sec-S', courseId, new Date().toISOString());
    expect(getAssignmentSubmissions).toHaveBeenCalledWith('sec-S', 'D1');
  });
});

describe('fullSync — course skip matrix (#56)', () => {
  let db;

  // Seeds four courses representing each (hidden, archived, excluded) combo
  // the section loop must distinguish. Returns the schoology_section_id list
  // in stable order so assertions read naturally.
  function seedCourses() {
    const stmt = db.prepare(`
      INSERT INTO courses
        (schoology_section_id, course_name, course_code, section_school_code, hidden, archived, excluded, finalized_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run('sec-visible',  'Visible Course',  'CSE101', 'S1', 0, 0, 0, null);
    stmt.run('sec-hidden',   'Hidden Course',   'CSE102', 'S2', 1, 0, 0, null);
    stmt.run('sec-archived', 'Archived Course', 'CSE103', 'S3', 0, 1, 0, '2026-01-01T00:00:00Z');
    stmt.run('sec-excluded', 'MASTER Template', null,     null, 0, 0, 1, null);
    return ['sec-visible', 'sec-hidden', 'sec-archived', 'sec-excluded'];
  }

  // Schoology mocks that just satisfy fullSync's outer shape — every
  // section-level lookup returns an empty array so per-section side effects
  // don't matter; we only care which sections reach syncSectionData (proxied
  // here via getSectionEnrollments, the first API call inside syncSectionData).
  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    // Tell sync.js to use this DB. The real getDb() singleton is module-level;
    // we monkey-patch it by setting DB_PATH or by using the in-memory hook the
    // existing tests already rely on. The existing tests pass `db` directly
    // into syncSectionData, but fullSync calls getDb() internally. Workaround:
    // override the module's db handle.
    const dbModule = await import('../db/index.js');
    // eslint-disable-next-line no-import-assign
    dbModule.__setTestDb?.(db);

    const { getMyUserId, getMySections, getSectionGradingPeriods,
            getSectionEnrollments, getSectionAssignments, getSectionGrades,
            getSectionFolders, getSectionGradingCategories,
            getSectionGradingScales } = await import('./schoology.js');

    getMyUserId.mockResolvedValue('user-1');
    getSectionGradingPeriods.mockResolvedValue([]);
    // mockReset clears call history from previous describe blocks so assertions
    // on mock.calls only reflect calls made during this test.
    getSectionEnrollments.mockReset();
    getSectionEnrollments.mockResolvedValue([]);
    getSectionAssignments.mockResolvedValue([]);
    getSectionGrades.mockResolvedValue([]);
    getSectionFolders.mockResolvedValue([]);
    getSectionGradingCategories.mockResolvedValue([]);
    getSectionGradingScales.mockResolvedValue([]);

    // getMySections returns sections matching the seeded course IDs. Order
    // matches seedCourses(). course_title is what fullSync logs but is
    // otherwise unused.
    // course_code / section_school_code must be present on the mock sections
    // because upsertCourse propagates them on every sync — missing values would
    // null out the seeded codes and trip markExcludedCourses for every course.
    // sec-excluded intentionally omits codes (that's the MASTER pattern).
    getMySections.mockResolvedValue([
      { id: 'sec-visible',  course_title: 'Visible Course',   section_title: 'A', course_code: 'CSE101', section_school_code: 'S1' },
      { id: 'sec-hidden',   course_title: 'Hidden Course',    section_title: 'A', course_code: 'CSE102', section_school_code: 'S2' },
      { id: 'sec-archived', course_title: 'Archived Course',  section_title: 'A', course_code: 'CSE103', section_school_code: 'S3' },
      { id: 'sec-excluded', course_title: 'MASTER Template',  section_title: 'A' },
    ]);
  });

  test('default sync skips hidden, archived, and excluded courses', async () => {
    seedCourses();
    const { getSectionEnrollments } = await import('./schoology.js');

    await fullSync(() => {});

    const visited = getSectionEnrollments.mock.calls.map(c => c[0]);
    expect(visited).toEqual(['sec-visible']);
  });

  test('includeHidden=true visits visible + hidden, not archived, not excluded', async () => {
    seedCourses();
    const { getSectionEnrollments } = await import('./schoology.js');

    await fullSync(() => {}, { includeHidden: true });

    const visited = getSectionEnrollments.mock.calls.map(c => c[0]).sort();
    expect(visited).toEqual(['sec-hidden', 'sec-visible']);
  });

  test('archived is always skipped; excluded never reached even with includeHidden', async () => {
    seedCourses();
    const { getSectionEnrollments } = await import('./schoology.js');

    await fullSync(() => {}, { includeHidden: true });

    const visited = getSectionEnrollments.mock.calls.map(c => c[0]).sort();
    expect(visited).toEqual(['sec-hidden', 'sec-visible']);
    expect(visited).not.toContain('sec-archived');
    expect(visited).not.toContain('sec-excluded');
  });
});

describe('enrichStudentProfiles — reconcile guardians (#70)', () => {
  let db;
  let studentId;
  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    studentId = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name, email) VALUES ('u-1','Ada','Lovelace','old@x.com')`
    ).run().lastInsertRowid;
    db.prepare(`INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?, 'p-1','Mara','Lovelace','mara@x.com')`).run(studentId);
    db.prepare(`INSERT INTO parents (student_id, schoology_uid, first_name, last_name, email) VALUES (?, 'p-2','Stale','Guardian','stale@x.com')`).run(studentId);
    getUserProfile.mockReset();
  });

  test('deletes a guardian Schoology no longer returns and updates email', async () => {
    getUserProfile.mockResolvedValue({
      primary_email: 'new@x.com',
      parents: { parent: [{ id: 'p-1', name_first: 'Mara', name_last: 'Lovelace', primary_email: 'mara@x.com' }] },
    });
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());

    const uids = db.prepare('SELECT schoology_uid FROM parents WHERE student_id = ? ORDER BY schoology_uid').all(studentId).map((r) => r.schoology_uid);
    expect(uids).toEqual(['p-1']);
    const email = db.prepare('SELECT email FROM students WHERE id = ?').get(studentId).email;
    expect(email).toBe('new@x.com');
  });

  test('a failed profile fetch preserves existing guardians and the student', async () => {
    getUserProfile.mockRejectedValue(new Error('403 inaccessible'));
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());

    const count = db.prepare('SELECT COUNT(*) n FROM parents WHERE student_id = ?').get(studentId).n;
    expect(count).toBe(2);
    expect(db.prepare('SELECT COUNT(*) n FROM students WHERE id = ?').get(studentId).n).toBe(1);
  });

  test('a student with no guardians in the profile has all guardians removed', async () => {
    getUserProfile.mockResolvedValue({ primary_email: null, parents: { parent: [] } });
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());
    expect(db.prepare('SELECT COUNT(*) n FROM parents WHERE student_id = ?').get(studentId).n).toBe(0);
  });

  test('normalises a single guardian returned as an object (not array)', async () => {
    getUserProfile.mockResolvedValue({
      primary_email: 'new@x.com',
      parents: { parent: { id: 'p-9', name_first: 'Solo', name_last: 'Guardian', primary_email: 'solo@x.com' } },
    });
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());
    const uids = db.prepare('SELECT schoology_uid FROM parents WHERE student_id = ? ORDER BY schoology_uid').all(studentId).map((r) => r.schoology_uid);
    expect(uids).toEqual(['p-9']); // single object handled; p-1 and p-2 reconciled away
  });
});

describe('finalizeArchivedCourse (#70)', () => {
  let db; let courseId;
  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('sec-9','Old Bio',1)`
    ).run().lastInsertRowid;
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([]);
    sch.getSectionAssignments.mockResolvedValue([]);
    sch.getSectionGrades.mockResolvedValue([]);
    sch.getSubmissionStatus.mockReset(); // clear call history leaked from prior blocks (#72)
    sch.getSubmissionStatus.mockResolvedValue(null);
    sch.getAssignmentSubmissions.mockReset();
    sch.getAssignmentSubmissions.mockResolvedValue([]);
    syncMasteryForCourse.mockReset();
    syncMasteryForCourse.mockResolvedValue({ scoresCount: 0 });
    hasMasterySession.mockReset();
  });

  test('runs mastery and sets finalized_at when a session is present', async () => {
    hasMasterySession.mockReturnValue(true);
    await finalizeArchivedCourse(db, { courseId, sectionId: 'sec-9', now: '2026-05-31T00:00:00Z' });
    expect(syncMasteryForCourse).toHaveBeenCalledWith(courseId, expect.objectContaining({ allowInteractiveLogin: false }));
    expect(db.prepare('SELECT finalized_at FROM courses WHERE id = ?').get(courseId).finalized_at).toBe('2026-05-31T00:00:00Z');
  });

  test('skips mastery and leaves finalized_at null when no session', async () => {
    hasMasterySession.mockReturnValue(false);
    await finalizeArchivedCourse(db, { courseId, sectionId: 'sec-9', now: '2026-05-31T00:00:00Z' });
    expect(syncMasteryForCourse).not.toHaveBeenCalled();
    expect(db.prepare('SELECT finalized_at FROM courses WHERE id = ?').get(courseId).finalized_at).toBeNull();
  });

  test('skips the per-cell submission loop (#72) — no public submissions call', async () => {
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    sch.getSectionAssignments.mockResolvedValue([
      { id: 'D1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    hasMasterySession.mockReturnValue(false);

    await finalizeArchivedCourse(db, { courseId, sectionId: 'sec-9', now: '2026-05-31T00:00:00Z' });

    expect(sch.getAssignmentSubmissions).not.toHaveBeenCalled();
  });
});

describe('detectArchivedTransitions (#70)', () => {
  let db;
  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([]);
    sch.getSectionAssignments.mockResolvedValue([]);
    sch.getSectionGrades.mockResolvedValue([]);
    sch.getSubmissionStatus.mockReset(); // clear call history leaked from prior blocks (#72)
    sch.getSubmissionStatus.mockResolvedValue(null);
    sch.getAssignmentSubmissions.mockReset();
    sch.getAssignmentSubmissions.mockResolvedValue([]);
    sch.getSectionGradingPeriods.mockResolvedValue([{ title: 'Semester 1: 08/14/2024 - 01/11/2025' }]);
    hasMasterySession.mockReturnValue(false); // gradebook-only finalise in this test
    getSection.mockReset();
  });

  function seed(sectionId, archived = 0) {
    return db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name, archived, excluded, synced_at) VALUES (?, ?, ?, 0, '2026-01-01T00:00:00Z')`
    ).run(sectionId, sectionId, archived).lastInsertRowid;
  }

  test('archives a dropped course that the section read confirms is inactive', async () => {
    const id = seed('sec-gone');
    getSection.mockResolvedValue({ id: 'sec-gone', active: 0, course_title: 'Gone' });
    await detectArchivedTransitions(db, new Set(['sec-active']), '2026-05-31T00:00:00Z');
    expect(db.prepare('SELECT archived FROM courses WHERE id = ?').get(id).archived).toBe(1);
  });

  test('leaves a dropped course that is still active (transient drop)', async () => {
    const id = seed('sec-blip');
    getSection.mockResolvedValue({ id: 'sec-blip', active: 1 });
    await detectArchivedTransitions(db, new Set(['sec-active']), '2026-05-31T00:00:00Z');
    expect(db.prepare('SELECT archived FROM courses WHERE id = ?').get(id).archived).toBe(0);
  });

  test('archives (no data refresh) when the section read 404s', async () => {
    const id = seed('sec-deleted');
    const err = new Error('Schoology API 404'); err.status = 404;
    getSection.mockRejectedValue(err);
    await detectArchivedTransitions(db, new Set([]), '2026-05-31T00:00:00Z');
    expect(db.prepare('SELECT archived FROM courses WHERE id = ?').get(id).archived).toBe(1);
  });

  test('ignores courses still in the active set', async () => {
    const id = seed('sec-active');
    await detectArchivedTransitions(db, new Set(['sec-active']), '2026-05-31T00:00:00Z');
    expect(getSection).not.toHaveBeenCalled();
    expect(db.prepare('SELECT archived FROM courses WHERE id = ?').get(id).archived).toBe(0);
  });

  test('leaves a dropped course when getSection throws a non-404 error', async () => {
    const id = seed('sec-error');
    const err = new Error('Schoology API 500'); err.status = 500;
    getSection.mockRejectedValue(err);
    await detectArchivedTransitions(db, new Set([]), '2026-05-31T00:00:00Z');
    expect(db.prepare('SELECT archived FROM courses WHERE id = ?').get(id).archived).toBe(0);
  });

  test('finalising a transitioned course skips the submission loop (#72)', async () => {
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    sch.getSectionAssignments.mockResolvedValue([
      { id: 'D1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    seed('sec-gone');
    getSection.mockResolvedValue({ id: 'sec-gone', active: 0, course_title: 'Gone' });

    await detectArchivedTransitions(db, new Set(['sec-active']), '2026-05-31T00:00:00Z');

    expect(sch.getAssignmentSubmissions).not.toHaveBeenCalled();
  });
});

describe('syncSectionData — recent-only submission window (#55)', () => {
  let db;
  let courseId;
  const NOW = '2026-06-06T00:00:00.000Z'; // 30-day cutoff = 2026-05-07

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-w', 'Window')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getAssignmentSubmissions.mockReset();
    getSectionGrades.mockResolvedValue([]);
    getAssignmentSubmissions.mockResolvedValue([]);
    getSectionEnrollments.mockResolvedValue([
      { id: '900001', uid: '700001', name_first: 'Ada', name_last: 'Lovelace', admin: '0' },
      { id: '900002', uid: '700002', name_first: 'Alan', name_last: 'Turing', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: '5001', title: 'Recent',  published: 1, allow_dropbox: '1', due: '2026-06-01' },
      { id: '5002', title: 'Old',     published: 1, allow_dropbox: '1', due: '2026-01-01' },
      { id: '5003', title: 'Undated', published: 1, allow_dropbox: '1', due: null },
    ]);
  });

  test('recentOnly skips old + undated dropbox assignments', async () => {
    const result = await syncSectionData(db, 'sec-w', courseId, NOW, { recentOnly: true, recentDays: 30 });
    expect(getAssignmentSubmissions).toHaveBeenCalledTimes(1); // only the 1 recent assignment
    expect(result.windowSkipped).toBe(2);
  });

  test('recentOnly off checks every dropbox assignment (unchanged)', async () => {
    const result = await syncSectionData(db, 'sec-w', courseId, NOW, { recentOnly: false });
    expect(getAssignmentSubmissions).toHaveBeenCalledTimes(3); // 3 assignments
    expect(result.windowSkipped).toBe(0);
  });
});

describe('backfillUnfinalizedArchived (#70)', () => {
  let db;
  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([]);
    sch.getSectionAssignments.mockResolvedValue([]);
    sch.getSectionGrades.mockResolvedValue([]);
    sch.getSubmissionStatus.mockReset(); // clear call history leaked from prior blocks (#72)
    sch.getSubmissionStatus.mockResolvedValue(null);
    sch.getAssignmentSubmissions.mockReset();
    sch.getAssignmentSubmissions.mockResolvedValue([]);
    hasMasterySession.mockReturnValue(true);
    syncMasteryForCourse.mockReset();
    syncMasteryForCourse.mockResolvedValue({ scoresCount: 0 });
  });

  test('finalises an unfinalised archived course once and skips finalised ones', async () => {
    const a = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('a',?,1)`).run('A').lastInsertRowid;
    const b = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived, finalized_at) VALUES ('b',?,1,'2026-01-01T00:00:00Z')`).run('B').lastInsertRowid;

    const n = await backfillUnfinalizedArchived(db, '2026-05-31T00:00:00Z');

    expect(n).toBe(1);
    expect(syncMasteryForCourse).toHaveBeenCalledTimes(1);
    expect(syncMasteryForCourse).toHaveBeenCalledWith(a, expect.anything());
    expect(db.prepare('SELECT finalized_at FROM courses WHERE id = ?').get(a).finalized_at).toBe('2026-05-31T00:00:00Z');
    expect(db.prepare('SELECT finalized_at FROM courses WHERE id = ?').get(b).finalized_at).toBe('2026-01-01T00:00:00Z');
  });

  test('backfill finalisation skips the submission loop (#72)', async () => {
    const sch = await import('./schoology.js');
    sch.getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    sch.getSectionAssignments.mockResolvedValue([
      { id: 'D1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('a','A',1)`).run();

    await backfillUnfinalizedArchived(db, '2026-05-31T00:00:00Z');

    expect(sch.getAssignmentSubmissions).not.toHaveBeenCalled();
  });
});
