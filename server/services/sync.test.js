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
// browser. Mock it to a no-op (returns null → public-bulk-only behavior), so
// the suite never touches Playwright. The native submission path is tested
// directly below by mocking getAssignmentSubmissions; the lti document path by
// injecting opts.fetchDocuments.
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

  test('captures the Schoology assignment web_url (#76)', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '900001', uid: '700001', name_first: 'Ada', name_last: 'Lovelace', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      {
        id: '5004', title: 'Has a Schoology link', published: 1,
        num_assignees: 0, assignees: '[]',
        web_url: 'https://hkis.schoology.com/assignment/5004/info',
      },
    ]);

    await syncSectionData(db, 'sec-1', courseId, new Date().toISOString());

    const row = db.prepare(
      `SELECT web_url FROM assignments WHERE schoology_assignment_id = '5004'`
    ).get();
    expect(row.web_url).toBe('https://hkis.schoology.com/assignment/5004/info');
  });

  test('web_url is null when Schoology omits it', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '900001', uid: '700001', name_first: 'Ada', name_last: 'Lovelace', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: '5005', title: 'No link', published: 1, num_assignees: 0, assignees: '[]' },
    ]);

    await syncSectionData(db, 'sec-1', courseId, new Date().toISOString());

    const row = db.prepare(
      `SELECT web_url FROM assignments WHERE schoology_assignment_id = '5005'`
    ).get();
    expect(row.web_url).toBeNull();
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

describe('retrySubmissions — never clears a Schoology test attempt', () => {
  test("a retried native fetch with no revision leaves submission_type 'assessment' alone", async () => {
    const db = new Database(':memory:');
    migrate(db);
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-R', 'R')`).run().lastInsertRowid;
    const sid = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'Ada', 'L')`).run().lastInsertRowid;
    const aid = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'X1', 'X')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, submission_type, test_attempt) VALUES (?, ?, 'assessment', 'took')`).run(sid, aid);
    getSectionEnrollments.mockReset();
    getSectionEnrollments.mockResolvedValue([{ id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' }]);
    getAssignmentSubmissions.mockReset();
    getAssignmentSubmissions.mockResolvedValue([]); // no revision → the clear path
    const metrics = { submission_calls: 0, rate_limit_hits: 0, transient_failures: 0, retries_succeeded: 0, retries_failed: 0 };
    await retrySubmissions(db, [{ sectionId: 'sec-R', courseId, assignmentExtId: 'X1' }], '2026-10-02T00:00:00Z', metrics);
    expect(metrics.retries_succeeded).toBe(1);
    expect(db.prepare('SELECT submission_type FROM grades WHERE student_id = ? AND assignment_id = ?').get(sid, aid).submission_type).toBe('assessment');
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

describe('syncSectionData — submission state: native bulk + lti documents (#55/#62)', () => {
  let db;
  let courseId;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-G', 'Gradebook')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getAssignmentSubmissions.mockReset();
    getSectionGrades.mockResolvedValue([]);
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

  test('lti_submission assignment is excluded from the native bulk walk (#62) — fetchDocuments owns it', async () => {
    // lti work goes through the fetchDocuments path, not the native bulk fetch.
    // Without fetchDocuments the lti pass is a no-op and the bulk endpoint is never hit.
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);

    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString());

    expect(getAssignmentSubmissions).not.toHaveBeenCalled();
    // Without fetchDocuments, no lti_submission_state row is written.
    expect(getGradeRow('701', 'L1')).toBeUndefined();
  });

  test('fetchDocuments upgrades an existing graded row with lti_submission_state, preserving score', async () => {
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
      fetchDocuments: async () => ({ states: new Map([['701', 'submitted']]), details: new Map() }),
    });

    const row = getGradeRow('701', 'L1');
    expect(row.score).toBe(14);                          // score not clobbered
    expect(row.lti_submission_state).toBe('submitted');  // state written
  });

  test('native cell with a non-draft revision → submission_type "drop" + late/timing (synthesized from bulk, #55)', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'N1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    getAssignmentSubmissions.mockResolvedValue([
      { revision_id: 2, uid: '701', created: 3000, late: 1, draft: 0 },
    ]);

    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString());

    expect(getAssignmentSubmissions).toHaveBeenCalledWith('sec-G', 'N1');
    const row = getGradeRow('701', 'N1');
    expect(row.submission_type).toBe('drop');     // synthesized, no GHD needed
    expect(row.late).toBe(1);
    expect(row.latest_revision_at).toBe(3000);
    expect(row.score).toBeNull();                 // submitted-but-ungraded row inserted
  });

  test('native cell with only a draft revision → in progress: submission_type null, draft 1', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'N1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    getAssignmentSubmissions.mockResolvedValue([
      { revision_id: 1, uid: '701', created: 1000, late: 0, draft: 1 },
    ]);

    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString());

    const row = getGradeRow('701', 'N1');
    expect(row.draft).toBe(1);
    expect(row.submission_type).toBeNull();
    expect(row.latest_revision_at).toBe(0);
  });

  test('native cell with no revision → no engagement: no row inserted', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'N1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    getAssignmentSubmissions.mockResolvedValue([]); // nobody submitted

    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString());

    expect(getGradeRow('701', 'N1')).toBeUndefined();
  });

  test('#62: lti assignment writes lti_submission_state via fetchDocuments and skips the native bulk walk', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
      { id: '802', uid: '702', name_first: 'Bo', name_last: 'M', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);

    const docCalls = [];
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async (aid) => { docCalls.push(aid); return { states: new Map([['701', 'submitted'], ['702', 'not_started']]), details: new Map() }; },
    });

    expect(docCalls).toEqual(['L1']);
    expect(getAssignmentSubmissions).not.toHaveBeenCalled();
    expect(getGradeRow('701', 'L1').lti_submission_state).toBe('submitted');
    // A not_started cell inserts a row so the state reaches the gradebook.
    expect(getGradeRow('702', 'L1').lti_submission_state).toBe('not_started');
  });

  test('#125: a submitted lti student persists submitted_at, latest_revision_at and late from the document detail', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },   // submitted, late
      { id: '802', uid: '702', name_first: 'Bo', name_last: 'M', admin: '0' },     // not_started
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);

    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => ({
        states: new Map([['701', 'submitted'], ['702', 'not_started']]),
        details: new Map([['701', { submittedAt: 1747895340, late: 1 }]]),
      }),
    });

    const submitted = getGradeRow('701', 'L1');
    expect(submitted.submitted_at).toBe(0);                // REST grade time owns submitted_at (no REST grade here)
    expect(submitted.latest_revision_at).toBe(1747895340); // the grader submissionDate
    expect(submitted.first_submitted_at).toBe(1747895340);
    expect(submitted.late).toBe(1);
    // A not_started cell has no detail → timestamps stay 0 (epochToIso → null in the MCP).
    const notStarted = getGradeRow('702', 'L1');
    expect(notStarted.submitted_at).toBe(0);
    expect(notStarted.latest_revision_at).toBe(0);
  });

  test('resubmissions: an LTI resubmission after grading is detectable (grade time kept)', async () => {
    getSectionEnrollments.mockResolvedValue([{ id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' }]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);
    getSectionGrades.mockResolvedValue([{ enrollment_id: '801', assignment_id: 'L1', grade: 80, exception: 0, timestamp: 2000, comment: '' }]);
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => ({ states: new Map([['701', 'submitted']]), details: new Map([['701', { submittedAt: 3000, late: 1 }]]) }),
    });
    const row = getGradeRow('701', 'L1');
    expect(row.submitted_at).toBe(2000);
    expect(row.latest_revision_at).toBe(3000);
  });

  test('resubmissions: graded LTI work seen back in progress is auto-added as an open request', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
      { id: '802', uid: '702', name_first: 'Bo', name_last: 'M', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);
    getSectionGrades.mockResolvedValue([
      { enrollment_id: '801', assignment_id: 'L1', grade: 80, exception: 0, timestamp: 2000, comment: '' },
      { enrollment_id: '802', assignment_id: 'L1', grade: 0, exception: 0, timestamp: 2000, comment: '' },
    ]);
    // Sync 1: Ada submitted (seeds first_submitted_at); Bo never submitted.
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => ({ states: new Map([['701', 'submitted'], ['702', 'in_progress']]), details: new Map([['701', { submittedAt: 1500, late: 0 }]]) }),
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM resubmissions').get().n).toBe(0);
    // Sync 2: the teacher unsubmitted Ada in Schoology.
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => ({ states: new Map([['701', 'in_progress'], ['702', 'in_progress']]), details: new Map() }),
    });
    const reqs = db.prepare(`SELECT r.*, s.schoology_uid FROM resubmissions r JOIN students s ON s.id = r.student_id`).all();
    expect(reqs).toHaveLength(1); // Review Focus 4: Bo (graded 0, never submitted) is not added
    expect(reqs[0]).toMatchObject({ schoology_uid: '701', kind: 'request', status: 'open', source: 'schoology_unsubmit', lessons: 3 });
  });

  test('#125: a submitted lti student with an unparseable date still records late, timestamps stay 0', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);

    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => ({
        states: new Map([['701', 'submitted']]),
        details: new Map([['701', { submittedAt: null, late: 0 }]]),
      }),
    });

    const row = getGradeRow('701', 'L1');
    expect(row.lti_submission_state).toBe('submitted');
    expect(row.submitted_at).toBe(0);
    expect(row.late).toBe(0);
  });

  test('triage: native first_submitted_at keeps the earliest across syncs', async () => {
    getSectionEnrollments.mockResolvedValue([{ id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' }]);
    getSectionAssignments.mockResolvedValue([{ id: 'N1', title: 'Essay', published: 1, allow_dropbox: '1' }]);

    getAssignmentSubmissions.mockResolvedValue([{ revision_id: 1, uid: '701', created: 1000, late: 0, draft: 0 }]);
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {});
    expect(getGradeRow('701', 'N1').first_submitted_at).toBe(1000);

    // A later resubmission moves latest_revision_at but not first_submitted_at.
    getAssignmentSubmissions.mockResolvedValue([{ revision_id: 2, uid: '701', created: 2000, late: 1, draft: 0 }]);
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {});
    const row = getGradeRow('701', 'N1');
    expect(row.latest_revision_at).toBe(2000);
    expect(row.first_submitted_at).toBe(1000);
  });

  test('triage: lti submitted time seeds first_submitted_at and keeps the earliest', async () => {
    getSectionEnrollments.mockResolvedValue([{ id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' }]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);
    const docs = (t) => async () => ({
      states: new Map([['701', 'submitted']]),
      details: new Map([['701', { submittedAt: t, late: 0 }]]),
    });
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), { fetchDocuments: docs(1500) });
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), { fetchDocuments: docs(2500) });
    expect(getGradeRow('701', 'L1').first_submitted_at).toBe(1500);
  });

  test('triage: accepts_submissions mirrors allow_dropbox on every sync', async () => {
    getSectionEnrollments.mockResolvedValue([{ id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' }]);
    getSectionAssignments.mockResolvedValue([
      { id: 'D1', title: 'Dropbox', published: 1, allow_dropbox: '1' },
      { id: 'D2', title: 'Numeric dropbox', published: 1, allow_dropbox: 1 },
      { id: 'P1', title: 'Paper test', published: 1, allow_dropbox: '0' },
      { id: 'P2', title: 'No field', published: 1 },
    ]);
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {});
    const accepts = () => Object.fromEntries(db.prepare(
      `SELECT schoology_assignment_id AS id, accepts_submissions AS v FROM assignments`,
    ).all().map((r) => [r.id, r.v]));
    expect(accepts()).toEqual({ D1: 1, D2: 1, P1: 0, P2: 0 });

    // The teacher turns the dropbox off: the next sync clears it.
    getSectionAssignments.mockResolvedValue([{ id: 'D1', title: 'Dropbox', published: 1, allow_dropbox: '0' }]);
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {});
    expect(accepts().D1).toBe(0);
  });

  function getFetchStatus(assignmentExtId) {
    return db.prepare(`SELECT lti_fetch_status FROM assignments WHERE schoology_assignment_id = ?`)
      .get(assignmentExtId)?.lti_fetch_status;
  }

  const oneLti = () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);
  };

  test('#76: a successful lti document fetch records lti_fetch_status = "ok"', async () => {
    oneLti();
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => ({ states: new Map([['701', 'submitted']]), details: new Map() }),
      ltiFetchBackoffMs: 0,
    });
    expect(getFetchStatus('L1')).toBe('ok');
  });

  test('#76: a fetch that fails every attempt records "failed" and retries once', async () => {
    oneLti();
    let calls = 0;
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => { calls++; return null; },
      ltiFetchBackoffMs: 0,
    });
    expect(calls).toBe(2);                          // initial attempt + one retry
    expect(getFetchStatus('L1')).toBe('failed');
    expect(getGradeRow('701', 'L1')).toBeUndefined(); // no state stored
  });

  test('#76: a transient null that recovers on retry records "ok" and writes the state', async () => {
    oneLti();
    let calls = 0;
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => { calls++; return calls < 2 ? null : { states: new Map([['701', 'submitted']]), details: new Map() }; },
      ltiFetchBackoffMs: 0,
    });
    expect(calls).toBe(2);
    expect(getFetchStatus('L1')).toBe('ok');
    expect(getGradeRow('701', 'L1').lti_submission_state).toBe('submitted');
  });

  test('#76: an lti assignment synced without a fetcher leaves lti_fetch_status NULL (never attempted)', async () => {
    oneLti();
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString()); // no fetchDocuments
    expect(getFetchStatus('L1')).toBeNull();
  });

  test('#76: a native (non-lti) assignment never touches lti_fetch_status', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'N1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    getAssignmentSubmissions.mockResolvedValue([]);
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => ({ states: new Map(), details: new Map() }),
      ltiFetchBackoffMs: 0,
    });
    expect(getFetchStatus('N1')).toBeNull();
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
            getSectionGradingScales, getUserProfilesBatch } = await import('./schoology.js');

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
    getUserProfilesBatch.mockResolvedValue(new Map());

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
    getUserProfilesBatch.mockReset();
  });

  test('deletes a guardian Schoology no longer returns and updates email', async () => {
    getUserProfilesBatch.mockResolvedValue(new Map([['u-1', {
      primary_email: 'new@x.com',
      parents: { parent: [{ id: 'p-1', name_first: 'Mara', name_last: 'Lovelace', primary_email: 'mara@x.com' }] },
    }]]));
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());
    const uids = db.prepare('SELECT schoology_uid FROM parents WHERE student_id = ? ORDER BY schoology_uid').all(studentId).map(r => r.schoology_uid);
    expect(uids).toEqual(['p-1']);
    expect(db.prepare('SELECT email FROM students WHERE id = ?').get(studentId).email).toBe('new@x.com');
  });

  test('an unfetched profile (absent from the batch) preserves existing guardians and the student', async () => {
    getUserProfilesBatch.mockResolvedValue(new Map()); // u-1 not fetched
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());
    expect(db.prepare('SELECT COUNT(*) n FROM parents WHERE student_id = ?').get(studentId).n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) n FROM students WHERE id = ?').get(studentId).n).toBe(1);
  });

  test('a student with no guardians in the profile has all guardians removed', async () => {
    getUserProfilesBatch.mockResolvedValue(new Map([['u-1', { primary_email: null, parents: { parent: [] } }]]));
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());
    expect(db.prepare('SELECT COUNT(*) n FROM parents WHERE student_id = ?').get(studentId).n).toBe(0);
  });

  test('normalises a single guardian returned as an object (not array)', async () => {
    getUserProfilesBatch.mockResolvedValue(new Map([['u-1', {
      primary_email: 'new@x.com',
      parents: { parent: { id: 'p-9', name_first: 'Solo', name_last: 'Guardian', primary_email: 'solo@x.com' } },
    }]]));
    await enrichStudentProfiles(db, [{ id: studentId, schoology_uid: 'u-1' }], new Date().toISOString());
    const uids = db.prepare('SELECT schoology_uid FROM parents WHERE student_id = ? ORDER BY schoology_uid').all(studentId).map(r => r.schoology_uid);
    expect(uids).toEqual(['p-9']);
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

  // Final review 5c: an assignment with an open resubmission request is still
  // checked even when it is outside the recent window — the arrival is exactly
  // what the request is waiting for.
  test('recentOnly still checks an old assignment with an open resubmission request', async () => {
    await syncSectionData(db, 'sec-w', courseId, NOW, { recentOnly: false }); // creates students + assignments
    const studentId = db.prepare(`SELECT id FROM students WHERE schoology_uid = '700001'`).get().id;
    const oldId = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = '5002'`).get().id;
    const undatedId = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = '5003'`).get().id;
    const ins = db.prepare(`INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons) VALUES (?, ?, ?, 'request', ?, '2026-06-01 00:00:00', 3)`);
    ins.run(studentId, oldId, courseId, 'open');
    ins.run(studentId, undatedId, courseId, 'closed'); // a closed request does not widen the window
    getAssignmentSubmissions.mockClear();

    const result = await syncSectionData(db, 'sec-w', courseId, NOW, { recentOnly: true, recentDays: 30 });
    expect(getAssignmentSubmissions.mock.calls.map((c) => c[1]).sort()).toEqual(['5001', '5002']);
    expect(result.windowSkipped).toBe(1);
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

// ── Dropped-enrolment lifecycle (#128) ──
//
// Schoology does NOT remove a dropped student from /sections/{id}/enrollments —
// it keeps returning the row with `status: "5"` instead of `"1"` (verified
// 2026-08-13 against AP CSP 8458134140 and AIML: 115 rows status "1", 2 status
// "5", zero rows disappeared). Sync previously filtered only on `admin`, so a
// dropped student was re-inserted on every sync and never left the roster.
describe('syncSectionData — dropped enrolments (#128)', () => {
  let db;
  let courseId;

  const active = { id: '900001', uid: '700001', name_first: 'Ada', name_last: 'Lovelace', admin: '0', status: '1' };
  const dropped = { id: '900002', uid: '700002', name_first: 'Alan', name_last: 'Turing', admin: '0', status: '5' };

  const enrolmentFor = (uid) => db.prepare(`
    SELECT e.status, e.dropped_at
    FROM enrolments e JOIN students s ON s.id = e.student_id
    WHERE e.course_id = ? AND s.schoology_uid = ?
  `).get(courseId, uid);

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-D', 'Algebra')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getSubmissionStatus.mockReset();
    getSectionAssignments.mockResolvedValue([]);
    getSectionGrades.mockResolvedValue([]);
    getSubmissionStatus.mockResolvedValue(null);
  });

  test('flags a status-5 enrolment as dropped, keeping the row', async () => {
    getSectionEnrollments.mockResolvedValue([active, dropped]);

    await syncSectionData(db, 'sec-D', courseId, '2026-08-13T00:00:00Z');

    // The row survives (soft delete) so grades/notes/feedback stay reachable.
    expect(enrolmentFor('700002')).toMatchObject({ status: '5', dropped_at: '2026-08-13T00:00:00Z' });
    expect(enrolmentFor('700001')).toMatchObject({ status: '1', dropped_at: null });
  });

  test('re-syncing preserves the ORIGINAL drop date', async () => {
    getSectionEnrollments.mockResolvedValue([dropped]);
    await syncSectionData(db, 'sec-D', courseId, '2026-08-13T00:00:00Z');
    await syncSectionData(db, 'sec-D', courseId, '2026-09-01T00:00:00Z');

    expect(enrolmentFor('700002').dropped_at).toBe('2026-08-13T00:00:00Z');
  });

  test('clears dropped_at when a student re-enrols', async () => {
    getSectionEnrollments.mockResolvedValue([dropped]);
    await syncSectionData(db, 'sec-D', courseId, '2026-08-13T00:00:00Z');
    expect(enrolmentFor('700002').dropped_at).toBe('2026-08-13T00:00:00Z');

    getSectionEnrollments.mockResolvedValue([{ ...dropped, status: '1' }]);
    await syncSectionData(db, 'sec-D', courseId, '2026-09-01T00:00:00Z');

    expect(enrolmentFor('700002')).toMatchObject({ status: '1', dropped_at: null });
  });

  test('flags a stored enrolment that vanishes from the API response entirely', async () => {
    getSectionEnrollments.mockResolvedValue([active, { ...dropped, status: '1' }]);
    await syncSectionData(db, 'sec-D', courseId, '2026-08-13T00:00:00Z');
    expect(enrolmentFor('700002').dropped_at).toBe(null);

    // Schoology retains dropped rows today, but a hard-removed enrolment must
    // not linger either.
    getSectionEnrollments.mockResolvedValue([active]);
    await syncSectionData(db, 'sec-D', courseId, '2026-09-01T00:00:00Z');

    expect(enrolmentFor('700002').dropped_at).toBe('2026-09-01T00:00:00Z');
    expect(enrolmentFor('700001').dropped_at).toBe(null);
  });

  test('a dropped enrolment in ANOTHER course is untouched', async () => {
    const otherCourse = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-E', 'Physics')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockResolvedValue([active]);
    await syncSectionData(db, 'sec-E', otherCourse, '2026-08-13T00:00:00Z');

    // Syncing sec-D (where Ada is absent) must not drop her sec-E enrolment.
    getSectionEnrollments.mockResolvedValue([dropped]);
    await syncSectionData(db, 'sec-D', courseId, '2026-09-01T00:00:00Z');

    const other = db.prepare(`
      SELECT e.dropped_at FROM enrolments e JOIN students s ON s.id = e.student_id
      WHERE e.course_id = ? AND s.schoology_uid = '700001'
    `).get(otherCourse);
    expect(other.dropped_at).toBe(null);
  });

  test('treats a missing status field as active (fail-safe for unknown shapes)', async () => {
    getSectionEnrollments.mockResolvedValue([{ ...active, status: undefined }]);

    await syncSectionData(db, 'sec-D', courseId, '2026-08-13T00:00:00Z');

    expect(enrolmentFor('700001').dropped_at).toBe(null);
  });
});

describe('syncSectionData — Schoology test attempts (make-up tests)', () => {
  let db;
  let courseId;
  const NOW = '2026-10-02T00:00:00.000Z';

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-T', 'AP CSP')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getAssignmentSubmissions.mockReset();
    getSectionGrades.mockResolvedValue([]);
    getAssignmentSubmissions.mockResolvedValue([]);
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
      { id: '802', uid: '702', name_first: 'Bo', name_last: 'M', admin: '0' },
      { id: '803', uid: '703', name_first: 'Cy', name_last: 'N', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'T1', title: 'Unit 1 test', type: 'assessment', published: 1, allow_dropbox: '0', due: '2026-09-28 14:00:00' },
      { id: 'T2', title: 'Unit 1 test *', type: 'assessment', published: 1, allow_dropbox: '0', due: '2026-09-28 14:00:00' },
      { id: 'E1', title: 'Essay', type: 'assignment', published: 1, allow_dropbox: '1', due: '2026-09-28 14:00:00' },
    ]);
  });

  const cell = (took, notAssigned = false) => ({ took, notAssigned });
  // Ada took T1, Bo didn't, Cy is on the * copy (T2) and took it.
  const attempts = () => new Map([
    ['701', new Map([['T1', cell(true)], ['T2', cell(false, true)]])],
    ['702', new Map([['T1', cell(false)], ['T2', cell(false, true)]])],
    ['703', new Map([['T1', cell(false, true)], ['T2', cell(true)]])],
  ]);
  const row = (uid, aid) => db.prepare(`
    SELECT g.* FROM grades g JOIN assignments a ON a.id = g.assignment_id JOIN students s ON s.id = g.student_id
    WHERE a.schoology_assignment_id = ? AND s.schoology_uid = ?
  `).get(aid, uid);
  const status = (aid) => db.prepare(`SELECT is_test, test_fetch_status FROM assignments WHERE schoology_assignment_id = ?`).get(aid);

  test('is_test comes from type "assessment" on every sync', async () => {
    await syncSectionData(db, 'sec-T', courseId, NOW);
    expect(status('T1').is_test).toBe(1);
    expect(status('E1').is_test).toBe(0);
    // masterySync may rewrite assignment_type; the next sync still knows it is a test.
    db.prepare(`UPDATE assignments SET assignment_type = 'basic' WHERE schoology_assignment_id = 'T1'`).run();
    await syncSectionData(db, 'sec-T', courseId, NOW);
    expect(status('T1').is_test).toBe(1);
  });

  test('ONE fetch per section for the test assignments; takers get submission_type "assessment"; status ok', async () => {
    const fetchTestAttempts = vi.fn().mockResolvedValue(attempts());
    await syncSectionData(db, 'sec-T', courseId, NOW, { fetchTestAttempts, ltiFetchBackoffMs: 0 });
    expect(fetchTestAttempts).toHaveBeenCalledTimes(1);
    expect(fetchTestAttempts).toHaveBeenCalledWith('sec-T', ['701', '702', '703'], ['T1', 'T2']);
    expect(row('701', 'T1')).toMatchObject({ submission_type: 'assessment', test_attempt: 'took', score: null });
    expect(row('703', 'T2')).toMatchObject({ submission_type: 'assessment', test_attempt: 'took' });
    expect(row('702', 'T1')).toMatchObject({ submission_type: null, test_attempt: 'none' });         // assigned, no attempt
    expect(row('703', 'T1')).toMatchObject({ submission_type: null, test_attempt: 'not_assigned' }); // on the * copy
    expect(status('T1').test_fetch_status).toBe('ok');
    expect(status('T2').test_fetch_status).toBe('ok');
    expect(status('E1').test_fetch_status).toBeNull();
  });

  test('a successful fetch clears a stale "assessment" for a non-taker, keeps the score, never touches "drop"', async () => {
    await syncSectionData(db, 'sec-T', courseId, NOW);
    const sid = (uid) => db.prepare('SELECT id FROM students WHERE schoology_uid = ?').get(uid).id;
    const aid = (ext) => db.prepare('SELECT id FROM assignments WHERE schoology_assignment_id = ?').get(ext).id;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, score, submission_type) VALUES (?, ?, 75, 'assessment')`).run(sid('702'), aid('T1'));
    db.prepare(`INSERT INTO grades (student_id, assignment_id, submission_type) VALUES (?, ?, 'drop')`).run(sid('701'), aid('T1'));
    await syncSectionData(db, 'sec-T', courseId, NOW, { fetchTestAttempts: async () => attempts(), ltiFetchBackoffMs: 0 });
    expect(row('702', 'T1')).toMatchObject({ submission_type: null, test_attempt: 'none', score: 75 });
    expect(row('701', 'T1')).toMatchObject({ submission_type: 'drop', test_attempt: 'took' });
  });

  test('no cell for a rostered student = unknown: the row is left exactly as it was', async () => {
    await syncSectionData(db, 'sec-T', courseId, NOW);
    const sid = db.prepare(`SELECT id FROM students WHERE schoology_uid = '702'`).get().id;
    const aid = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = 'T1'`).get().id;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, submission_type, test_attempt) VALUES (?, ?, 'assessment', 'took')`).run(sid, aid);
    const without702 = attempts();
    without702.delete('702');
    await syncSectionData(db, 'sec-T', courseId, NOW, { fetchTestAttempts: async () => without702, ltiFetchBackoffMs: 0 });
    expect(status('T1').test_fetch_status).toBe('ok');
    expect(row('702', 'T1')).toMatchObject({ submission_type: 'assessment', test_attempt: 'took' });
    expect(row('702', 'T2')).toBeUndefined(); // never invented
  });

  test('a not_assigned cell never clears a submission', async () => {
    await syncSectionData(db, 'sec-T', courseId, NOW);
    const sid = db.prepare(`SELECT id FROM students WHERE schoology_uid = '703'`).get().id;
    const aid = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = 'T1'`).get().id;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, submission_type) VALUES (?, ?, 'assessment')`).run(sid, aid);
    await syncSectionData(db, 'sec-T', courseId, NOW, { fetchTestAttempts: async () => attempts(), ltiFetchBackoffMs: 0 });
    expect(row('703', 'T1')).toMatchObject({ submission_type: 'assessment', test_attempt: 'not_assigned' });
  });

  test('a fetch that fails every attempt retries once, records "failed" and writes nothing', async () => {
    await syncSectionData(db, 'sec-T', courseId, NOW);
    const sid = db.prepare(`SELECT id FROM students WHERE schoology_uid = '702'`).get().id;
    const aid = db.prepare(`SELECT id FROM assignments WHERE schoology_assignment_id = 'T1'`).get().id;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, submission_type) VALUES (?, ?, 'assessment')`).run(sid, aid);
    let calls = 0;
    await syncSectionData(db, 'sec-T', courseId, NOW, { fetchTestAttempts: async () => { calls++; return null; }, ltiFetchBackoffMs: 0 });
    expect(calls).toBe(2);
    expect(status('T1').test_fetch_status).toBe('failed');
    expect(status('T2').test_fetch_status).toBe('failed');
    expect(row('702', 'T1')).toMatchObject({ submission_type: 'assessment', test_attempt: null }); // unknown ≠ "didn't take it"
    expect(row('701', 'T1')).toBeUndefined();
  });

  test('a transient null that recovers on retry records "ok"', async () => {
    let calls = 0;
    await syncSectionData(db, 'sec-T', courseId, NOW, {
      fetchTestAttempts: async () => (++calls < 2 ? null : attempts()), ltiFetchBackoffMs: 0,
    });
    expect(calls).toBe(2);
    expect(status('T1').test_fetch_status).toBe('ok');
    expect(row('701', 'T1').submission_type).toBe('assessment');
  });

  test('a test the response has no cells for is "failed" (unknown), the others ok', async () => {
    const onlyT1 = new Map([['701', new Map([['T1', cell(true)]])], ['702', new Map([['T1', cell(false)]])]]);
    await syncSectionData(db, 'sec-T', courseId, NOW, { fetchTestAttempts: async () => onlyT1, ltiFetchBackoffMs: 0 });
    expect(status('T1').test_fetch_status).toBe('ok');
    expect(status('T2').test_fetch_status).toBe('failed');
  });

  test('without a fetcher (no browser session) everything is left untouched', async () => {
    await syncSectionData(db, 'sec-T', courseId, NOW, { fetchTestAttempts: async () => attempts() });
    await syncSectionData(db, 'sec-T', courseId, NOW); // no fetchTestAttempts
    expect(status('T1').test_fetch_status).toBe('ok');
    expect(row('701', 'T1').submission_type).toBe('assessment');
  });

  test('recentOnly: a test outside the window is not fetched and keeps its previous status', async () => {
    getSectionAssignments.mockResolvedValue([
      { id: 'T1', title: 'Recent test', type: 'assessment', published: 1, due: '2026-09-28 14:00:00' },
      { id: 'T9', title: 'Old test', type: 'assessment', published: 1, due: '2026-03-01 14:00:00' },
    ]);
    const fetchTestAttempts = vi.fn().mockResolvedValue(attempts());
    await syncSectionData(db, 'sec-T', courseId, NOW, { fetchTestAttempts, recentOnly: true, recentDays: 30, ltiFetchBackoffMs: 0 });
    expect(fetchTestAttempts).toHaveBeenCalledWith('sec-T', ['701', '702', '703'], ['T1']);
    expect(status('T9').test_fetch_status).toBeNull();
  });

  test('makeup_ignored is Prism-owned: a re-sync never overwrites it', async () => {
    await syncSectionData(db, 'sec-T', courseId, NOW);
    expect(db.prepare(`SELECT makeup_ignored FROM assignments WHERE schoology_assignment_id = 'T1'`).get().makeup_ignored).toBe(0);
    db.prepare(`UPDATE assignments SET makeup_ignored = 1 WHERE schoology_assignment_id = 'T1'`).run();
    await syncSectionData(db, 'sec-T', courseId, NOW, { fetchTestAttempts: async () => attempts(), ltiFetchBackoffMs: 0 });
    expect(db.prepare(`SELECT makeup_ignored FROM assignments WHERE schoology_assignment_id = 'T1'`).get().makeup_ignored).toBe(1);
  });

  test('no test assignments, or skipSubmissions (archived) → no fetch', async () => {
    const fetchTestAttempts = vi.fn().mockResolvedValue(attempts());
    await syncSectionData(db, 'sec-T', courseId, NOW, { fetchTestAttempts, skipSubmissions: true });
    getSectionAssignments.mockResolvedValue([{ id: 'E1', title: 'Essay', type: 'assignment', published: 1 }]);
    await syncSectionData(db, 'sec-T', courseId, NOW, { fetchTestAttempts });
    expect(fetchTestAttempts).not.toHaveBeenCalled();
  });
});

describe('fullSync — test-attempt fetcher wiring', () => {
  let db;

  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    const dbModule = await import('../db/index.js');
    dbModule.__setTestDb?.(db);
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name, course_code, section_school_code) VALUES ('sec-1', 'AP CSP', 'APCSP', 'S1')`).run();
    const s = await import('./schoology.js');
    s.getMyUserId.mockResolvedValue('user-1');
    s.getMySections.mockResolvedValue([{ id: 'sec-1', course_title: 'AP CSP', section_title: 'A', course_code: 'APCSP', section_school_code: 'S1' }]);
    s.getSectionGradingPeriods.mockResolvedValue([]);
    s.getSectionEnrollments.mockReset();
    s.getSectionEnrollments.mockResolvedValue([{ id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' }]);
    s.getSectionAssignments.mockReset();
    s.getSectionAssignments.mockResolvedValue([{ id: 'T1', title: 'Unit 1 test', type: 'assessment', published: 1, due: '2026-09-28 14:00:00' }]);
    s.getSectionGrades.mockResolvedValue([]);
    s.getSectionFolders.mockResolvedValue([]);
    s.getSectionGradingCategories.mockResolvedValue([]);
    s.getSectionGradingScales.mockResolvedValue([]);
    s.getUserProfilesBatch.mockResolvedValue(new Map());
  });

  test('passes the shared browser fetcher to each section and closes it', async () => {
    const { createSubmissionFetcher } = await import('./graderSubmissions.js');
    const fetcher = {
      fetchDocuments: vi.fn().mockResolvedValue(null),
      fetchTestAttempts: vi.fn().mockResolvedValue(new Map([['701', new Map([['T1', { took: true, notAssigned: false }]])]])),
      close: vi.fn().mockResolvedValue(),
    };
    createSubmissionFetcher.mockResolvedValueOnce(fetcher);
    await fullSync(() => {});
    expect(fetcher.fetchTestAttempts).toHaveBeenCalledWith('sec-1', ['701'], ['T1']);
    expect(db.prepare(`SELECT test_fetch_status FROM assignments WHERE schoology_assignment_id = 'T1'`).get().test_fetch_status).toBe('ok');
    expect(fetcher.close).toHaveBeenCalled();
  });
});
