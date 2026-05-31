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
}));

// fullSync calls createSubmissionFetcher(), which would launch a headless
// browser. Mock it to a no-op (returns null → public-API-only behavior), so
// the suite never touches Playwright. syncSectionData GHD wiring is tested
// directly below by injecting opts.fetchSubmissionLookup.
vi.mock('./graderSubmissions.js', () => ({
  createSubmissionFetcher: vi.fn().mockResolvedValue(null),
}));

import {
  getSectionEnrollments,
  getSectionAssignments,
  getSectionGrades,
  getSubmissionStatus,
  getUserProfile,
} from './schoology.js';
import { syncSectionData, retrySubmissions, fullSync, enrichStudentProfiles } from './sync.js';

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
    getSubmissionStatus.mockReset();
    getSectionGrades.mockResolvedValue([]);
  });

  test('one 429 in assignment A leaves all of A unwritten; B fully written', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
      { id: '802', uid: '702', name_first: 'Bob', name_last: 'M', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'A1', title: 'A', published: 1, allow_dropbox: '1' },
      { id: 'A2', title: 'B', published: 1, allow_dropbox: '1' },
    ]);
    getSubmissionStatus.mockImplementation(async (sid, aid, uid) => {
      if (aid === 'A1' && uid === '701') {
        const err = new Error('429'); err.rateLimited = true; err.transient = true; throw err;
      }
      return { revision_id: 1, late: 0, draft: 0, latestRevisionAt: 1000 };
    });

    const result = await syncSectionData(db, 'sec-A', courseId, new Date().toISOString());

    expect(result.failedAssignmentIds).toEqual(['A1']);

    const a1Rows = db.prepare(`
      SELECT g.* FROM grades g
      JOIN assignments a ON a.id = g.assignment_id
      WHERE a.schoology_assignment_id = 'A1'
    `).all();
    expect(a1Rows.length).toBe(0);

    const a2Rows = db.prepare(`
      SELECT g.* FROM grades g
      JOIN assignments a ON a.id = g.assignment_id
      WHERE a.schoology_assignment_id = 'A2'
    `).all();
    expect(a2Rows.length).toBe(2);
  });

  test('abandonAfter threshold short-circuits remaining submission fetches', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    const assignments = Array.from({ length: 10 }, (_, i) => ({
      id: `T${i}`, title: `T${i}`, published: 1, allow_dropbox: '1',
    }));
    getSectionAssignments.mockResolvedValue(assignments);
    let callCount = 0;
    getSubmissionStatus.mockImplementation(async () => {
      callCount++;
      const err = new Error('429'); err.rateLimited = true; err.transient = true; throw err;
    });

    const result = await syncSectionData(
      db, 'sec-A', courseId, new Date().toISOString(),
      { submissionConcurrency: 1, submissionRatePerSec: 100, submissionAbandonAfter: 3 }
    );

    expect(result.failedAssignmentIds.length).toBe(3);
    expect(result.submissionAbandoned).toBe(true);
    expect(callCount).toBeLessThanOrEqual(3);
  });
});

describe('retrySubmissions (#55)', () => {
  let db;
  let courseId;
  let assignmentDbId;
  let studentDbId;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-R', 'R')`).run().lastInsertRowid;
    assignmentDbId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, 'RA1', 'A', 1)`).run(courseId).lastInsertRowid;
    studentDbId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('701', 'Ada', 'L')`).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSubmissionStatus.mockReset();
  });

  test('retry succeeds → row written, retries_succeeded incremented', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSubmissionStatus.mockResolvedValue({ revision_id: 1, late: 0, draft: 0, latestRevisionAt: 1234 });
    const metrics = { submission_calls: 0, rate_limit_hits: 0, transient_failures: 0, retries_succeeded: 0, retries_failed: 0 };
    const stillFailing = await retrySubmissions(
      db,
      [{ sectionId: 'sec-R', courseId, assignmentExtId: 'RA1' }],
      new Date().toISOString(),
      metrics,
    );
    expect(stillFailing).toEqual([]);
    expect(metrics.retries_succeeded).toBe(1);
    expect(metrics.retries_failed).toBe(0);
    const rows = db.prepare(`
      SELECT g.* FROM grades g JOIN assignments a ON a.id = g.assignment_id WHERE a.schoology_assignment_id = 'RA1'
    `).all();
    expect(rows.length).toBe(1);
  });

  test('retry 429s again → no row written, returned in stillFailing, retries_failed=1', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSubmissionStatus.mockImplementation(async () => {
      const err = new Error('429'); err.rateLimited = true; err.transient = true; throw err;
    });
    const metrics = { submission_calls: 0, rate_limit_hits: 0, transient_failures: 0, retries_succeeded: 0, retries_failed: 0 };
    const entry = { sectionId: 'sec-R', courseId, assignmentExtId: 'RA1' };
    const stillFailing = await retrySubmissions(db, [entry], new Date().toISOString(), metrics);
    expect(stillFailing).toEqual([entry]);
    expect(metrics.rate_limit_hits).toBe(1);
    expect(metrics.retries_succeeded).toBe(0);
    expect(metrics.retries_failed).toBe(1);
    const rows = db.prepare(`
      SELECT g.* FROM grades g JOIN assignments a ON a.id = g.assignment_id WHERE a.schoology_assignment_id = 'RA1'
    `).all();
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
    getSectionGrades.mockResolvedValue([]);
    getSubmissionStatus.mockResolvedValue(null); // public API blind to OneDrive
  });

  function getGradeRow(uid, assignmentExtId) {
    return db.prepare(`
      SELECT g.* FROM grades g
      JOIN assignments a ON a.id = g.assignment_id
      JOIN students s ON s.id = g.student_id
      WHERE a.schoology_assignment_id = ? AND s.schoology_uid = ?
    `).get(assignmentExtId, uid);
  }

  test('GHD "submitted" sets submission_type even when the public API returns no revision (#62)', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);

    const result = await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchSubmissionLookup: async () => fakeLookup({ '701:L1': { submitted: true, submissionType: 'drop' } }),
    });

    // Public API is still queried (GHD lacks late/draft/timing).
    expect(getSubmissionStatus).toHaveBeenCalledWith('sec-G', 'L1', '701');
    const row = getGradeRow('701', 'L1');
    expect(row).toBeTruthy();
    expect(row.submission_type).toBe('drop');
    expect(result.submissionSkipped).toBe(0);
  });

  test('GHD "not submitted" skips the public revisions call (#55) and writes no row', async () => {
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
    expect(result.submissionSkipped).toBe(1);
    // UPDATE-only clear: a never-touched cell stays "no engagement" (no row).
    expect(getGradeRow('701', 'L1')).toBeUndefined();
  });

  test('GHD "submitted" upgrades an existing graded row with the type, preserving the score', async () => {
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
      fetchSubmissionLookup: async () => fakeLookup({ '701:L1': { submitted: true, submissionType: 'drop' } }),
    });

    const row = getGradeRow('701', 'L1');
    expect(row.score).toBe(14);            // score not clobbered
    expect(row.submission_type).toBe('drop');
  });

  test('GHD-uncovered cell falls back to the public API and leaves submission_type null', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'N1', title: 'Native dropbox', published: 1, allow_dropbox: '1' },
    ]);
    getSubmissionStatus.mockResolvedValue({ revision_id: 1, late: 1, draft: 0, latestRevisionAt: 2000 });

    const result = await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      // Lookup returns undefined for this (uid, assignment) → uncovered.
      fetchSubmissionLookup: async () => fakeLookup({}),
    });

    expect(getSubmissionStatus).toHaveBeenCalledWith('sec-G', 'N1', '701');
    const row = getGradeRow('701', 'N1');
    expect(row.late).toBe(1);
    expect(row.submission_type).toBeNull();
    expect(result.submissionSkipped).toBe(0);
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
        (schoology_section_id, course_name, course_code, section_school_code, hidden, archived, excluded)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run('sec-visible',  'Visible Course',  'CSE101', 'S1', 0, 0, 0);
    stmt.run('sec-hidden',   'Hidden Course',   'CSE102', 'S2', 1, 0, 0);
    stmt.run('sec-archived', 'Archived Course', 'CSE103', 'S3', 0, 1, 0);
    stmt.run('sec-excluded', 'MASTER Template', null,     null, 0, 0, 1);
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

  test('includeArchived=true visits visible + archived, not hidden, not excluded', async () => {
    seedCourses();
    const { getSectionEnrollments } = await import('./schoology.js');

    await fullSync(() => {}, { includeArchived: true });

    const visited = getSectionEnrollments.mock.calls.map(c => c[0]).sort();
    expect(visited).toEqual(['sec-archived', 'sec-visible']);
  });

  test('excluded never reached even with both toggles on', async () => {
    seedCourses();
    const { getSectionEnrollments } = await import('./schoology.js');

    await fullSync(() => {}, { includeHidden: true, includeArchived: true });

    const visited = getSectionEnrollments.mock.calls.map(c => c[0]).sort();
    expect(visited).toEqual(['sec-archived', 'sec-hidden', 'sec-visible']);
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
});
