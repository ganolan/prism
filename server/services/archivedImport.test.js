import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';

vi.mock('./schoology.js', () => ({ apiGet: vi.fn() }));
vi.mock('./sync.js', () => ({
  finalizeArchivedCourse: vi.fn().mockResolvedValue({ studentsCount: 1, assignmentsCount: 2, gradesCount: 3, finalized: true, masteryError: null }),
  enrichStudentProfiles: vi.fn().mockResolvedValue(1),
}));
// The block-number service reads PowerSchool: mocked so the import never reaches the network,
// and so block-on-import (#106) can be asserted.
// #178: the sections linked to the imported one (none unless a test says so).
vi.mock('./archivedCourses.js', () => ({ linkedSectionsOf: vi.fn().mockResolvedValue([]) }));
vi.mock('./psAttendanceSync.js', () => ({ syncPsAttendance: vi.fn().mockResolvedValue({ processed: 1, updated: 1, unchanged: 0, skipped: 0, results: [] }) }));

import { importArchivedCourse } from './archivedImport.js';
import { runPastImport } from './archivedImportRun.js';
import { classifyEvent } from './syncRuns.js';
import { apiGet } from './schoology.js';
import { finalizeArchivedCourse, enrichStudentProfiles } from './sync.js';
import { syncPsAttendance } from './psAttendanceSync.js';
import { linkedSectionsOf } from './archivedCourses.js';

const section = (over = {}) => ({ id: 'sec-9', course_title: 'Old Bio', section_title: 'A', course_code: 'BIO', active: 0, ...over });
function schoology({ sec = section(), period = 'Semester 1: 08/14/2024 - 01/11/2025' } = {}) {
  apiGet.mockImplementation((p) => (p.endsWith('/grading_periods')
    ? Promise.resolve({ grading_period: period ? [{ title: period }] : [] })
    : Promise.resolve(sec)));
}

let db;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  vi.clearAllMocks();
  schoology();
  linkedSectionsOf.mockResolvedValue([]);
});

describe('importArchivedCourse (#70, moved from POST /api/courses/import for #171)', () => {
  test('adds the section as an archived course, finalises it with mastery and enriches its students', async () => {
    const result = await importArchivedCourse(db, 'sec-9');

    expect(apiGet).toHaveBeenCalledWith('/sections/sec-9');
    expect(apiGet).toHaveBeenCalledWith('/sections/sec-9/grading_periods');
    const course = db.prepare("SELECT * FROM courses WHERE schoology_section_id = 'sec-9'").get();
    expect(course).toMatchObject({
      course_name: 'Old Bio', section_name: 'A', course_code: 'BIO', archived: 1,
      grading_period: 'Semester 1: 08/14/2024 - 01/11/2025',
    });
    expect(course.synced_at).toBeTruthy();
    expect(result).toEqual({ course, studentsCount: 1, assignmentsCount: 2, gradesCount: 3, finalized: true, masteryError: null });
    expect(finalizeArchivedCourse).toHaveBeenCalledWith(db, expect.objectContaining({
      courseId: course.id, sectionId: 'sec-9', runMastery: true,
    }));
    expect(enrichStudentProfiles).toHaveBeenCalledWith(db, [], expect.any(String));
    // #106: the import resolves the new course's block number (best-effort).
    expect(syncPsAttendance).toHaveBeenCalledWith({ courseIds: [course.id] });
  });

  test('a course already in the database becomes archived, keeping its id', async () => {
    const id = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, archived) VALUES ('sec-9', 'Bio', 0)`).run().lastInsertRowid;
    const { course } = await importArchivedCourse(db, 'sec-9');
    expect(course).toMatchObject({ id: Number(id), course_name: 'Old Bio', archived: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM courses').get().n).toBe(1);
  });

  test('enriches only the section\'s current students', async () => {
    const { lastInsertRowid: courseId } = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-9', 'Bio')`).run();
    const add = (uid, dropped) => {
      const { lastInsertRowid: sid } = db.prepare('INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, ?)').run(uid, 'A', uid);
      db.prepare('INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?, ?, ?)').run(sid, courseId, dropped);
      return Number(sid);
    };
    const kept = add('u1', null);
    add('u2', '2026-01-01T00:00:00Z');
    await importArchivedCourse(db, 'sec-9');
    expect(enrichStudentProfiles.mock.calls[0][1]).toEqual([{ id: kept, schoology_uid: 'u1' }]);
  });

  test('a block-resolve failure does not fail the import (best-effort)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    schoology({ sec: section({ id: 'sec-x', course_title: 'Old X', course_code: 'X' }), period: null });
    syncPsAttendance.mockRejectedValueOnce(new Error('PowerSchool session stale'));
    const result = await importArchivedCourse(db, 'sec-x');
    expect(result).toMatchObject({ studentsCount: 1, course: { course_name: 'Old X', grading_period: null } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PowerSchool session stale'));
    warn.mockRestore();
  });

  // #171: the Archived tab's Synced time. The import is no orchestrator run, so it stamps itself.
  const complete = { studentsCount: 1, assignmentsCount: 2, gradesCount: 3, finalized: true, masteryError: null,
    fullRead: true, failedAssignmentIds: [], submissionAbandoned: false };
  const stamps = () => db.prepare("SELECT course_synced_at, sync_attempted_at, synced_at FROM courses WHERE schoology_section_id = 'sec-9'").get();

  test('a complete read stamps the course synced and attempted, at the import\'s time', async () => {
    finalizeArchivedCourse.mockResolvedValueOnce(complete);
    await importArchivedCourse(db, 'sec-9');
    const s = stamps();
    expect(s.course_synced_at).toBe(s.synced_at);
    expect(s.sync_attempted_at).toBe(s.synced_at);
  });

  test.each([
    ['the mastery read failed', { masteryError: 'Schoology sign-in needed' }],
    ['there was no saved session (not finalized)', { finalized: false, masteryError: 'No saved Schoology session', fullRead: false }],
    ['submissions were read dropbox only', { fullRead: false }],
    ['a task\'s submissions could not be read', { failedAssignmentIds: ['a-1'] }],
    ['the submission read was abandoned', { submissionAbandoned: true }],
  ])('%s: only the attempt is stamped', async (_, over) => {
    finalizeArchivedCourse.mockResolvedValueOnce({ ...complete, ...over });
    await importArchivedCourse(db, 'sec-9');
    const s = stamps();
    expect(s.sync_attempted_at).toBe(s.synced_at);
    expect(s.course_synced_at).toBeNull();
  });

  test('a read that throws still stamps the attempt', async () => {
    finalizeArchivedCourse.mockRejectedValueOnce(new Error('Schoology API 500'));
    await expect(importArchivedCourse(db, 'sec-9')).rejects.toThrow('500');
    const s = stamps();
    expect(s.sync_attempted_at).toBe(s.synced_at);
    expect(s.course_synced_at).toBeNull();
  });

  // #172: an archived assessment page reads its task's own Synced time, as an orchestrator
  // re-read stamps it (stampCompleteSyncs): read-in-full tasks on a complete read, every live
  // task's attempt on any read.
  const withTasks = () => {
    const courseId = Number(db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-9', 'Bio')`).run().lastInsertRowid);
    const add = (ext, removed = null) => Number(db.prepare(
      'INSERT INTO assignments (course_id, schoology_assignment_id, title, removed_at) VALUES (?, ?, ?, ?)'
    ).run(courseId, ext, ext, removed).lastInsertRowid);
    return { full: add('A-full'), failed: add('A-failed'), removed: add('A-removed', '2026-01-01T00:00:00Z') };
  };
  const taskStamps = () => Object.fromEntries(db.prepare(
    'SELECT schoology_assignment_id ext, task_synced_at, task_sync_attempted_at FROM assignments'
  ).all().map((r) => [r.ext, { synced: r.task_synced_at, attempted: r.task_sync_attempted_at }]));

  test('a complete read stamps the tasks read in full synced, and every live task attempted (#172)', async () => {
    const t = withTasks();
    finalizeArchivedCourse.mockResolvedValueOnce({ ...complete, readInFullTaskIds: [t.full] });
    await importArchivedCourse(db, 'sec-9');
    const at = stamps().synced_at;
    expect(taskStamps()).toEqual({
      'A-full': { synced: at, attempted: at },
      'A-failed': { synced: null, attempted: at },
      'A-removed': { synced: null, attempted: null },
    });
  });

  test('an incomplete read stamps no task synced, only the live tasks\' attempt (#172)', async () => {
    const t = withTasks();
    finalizeArchivedCourse.mockResolvedValueOnce({ ...complete, masteryError: 'Schoology sign-in needed', readInFullTaskIds: [t.full] });
    await importArchivedCourse(db, 'sec-9');
    const at = stamps().synced_at;
    expect(taskStamps()).toEqual({
      'A-full': { synced: null, attempted: at },
      'A-failed': { synced: null, attempted: at },
      'A-removed': { synced: null, attempted: null },
    });
  });

  test('a read that throws still stamps the live tasks\' attempt (#172)', async () => {
    withTasks();
    finalizeArchivedCourse.mockRejectedValueOnce(new Error('Schoology API 500'));
    await expect(importArchivedCourse(db, 'sec-9')).rejects.toThrow('500');
    const at = stamps().synced_at;
    expect(taskStamps()['A-full']).toEqual({ synced: null, attempted: at });
    expect(taskStamps()['A-removed']).toEqual({ synced: null, attempted: null });
  });

  // #178: linked sections are one course.
  test('a section with linked sections: one course with every section\'s title, each linked section recorded', async () => {
    schoology({ sec: section({ section_title: '4(A-B)' }) });
    linkedSectionsOf.mockResolvedValue([{ sectionId: 'sec-6', sectionTitle: '6(A-B)' }, { sectionId: 'sec-7', sectionTitle: '7(A-B)' }]);
    const { course } = await importArchivedCourse(db, 'sec-9');
    expect(linkedSectionsOf).toHaveBeenCalledWith('sec-9');
    expect(course.section_name).toBe('4(A-B), 6(A-B), 7(A-B)');
    expect(db.prepare('SELECT schoology_section_id, course_id, section_name FROM linked_sections ORDER BY 1').all()).toEqual([
      { schoology_section_id: 'sec-6', course_id: course.id, section_name: '6(A-B)' },
      { schoology_section_id: 'sec-7', course_id: course.id, section_name: '7(A-B)' },
    ]);
    // Written before the read, so the read covers every section.
    expect(finalizeArchivedCourse).toHaveBeenCalledTimes(1);
  });

  test('importing a linked section imports its parent, with every linked section', async () => {
    const parent = section({ id: 'sec-4', section_title: '4(A-B)' });
    apiGet.mockImplementation((p) => {
      if (p.endsWith('/grading_periods')) return Promise.resolve({ grading_period: [{ title: '2023-2024' }] });
      if (p === '/sections/sec-6') return Promise.resolve(section({ id: 'sec-6', section_title: '6(A-B)', parent_id: 'sec-4' }));
      return Promise.resolve(parent);
    });
    linkedSectionsOf.mockResolvedValue([{ sectionId: 'sec-6', sectionTitle: '6(A-B)' }]);
    const { course } = await importArchivedCourse(db, 'sec-6');
    expect(course).toMatchObject({ schoology_section_id: 'sec-4', section_name: '4(A-B), 6(A-B)' });
    expect(db.prepare('SELECT COUNT(*) n FROM courses').get().n).toBe(1);
    expect(db.prepare('SELECT schoology_section_id FROM linked_sections').all()).toEqual([{ schoology_section_id: 'sec-6' }]);
  });

  test('a section with no parent (parent_id "0") is imported as itself', async () => {
    schoology({ sec: section({ parent_id: '0' }) });
    const { course } = await importArchivedCourse(db, 'sec-9');
    expect(course.schoology_section_id).toBe('sec-9');
  });

  test('the linked sections cannot be read: the import stops before writing anything', async () => {
    linkedSectionsOf.mockRejectedValue(new Error('Schoology API 503'));
    await expect(importArchivedCourse(db, 'sec-9')).rejects.toThrow('503');
    expect(db.prepare('SELECT COUNT(*) n FROM courses').get().n).toBe(0);
  });

  test('a Schoology error is thrown as it came (the route maps 403 and 404)', async () => {
    apiGet.mockRejectedValue(new Error('Schoology API 403: Forbidden'));
    await expect(importArchivedCourse(db, 'sec-9')).rejects.toThrow('403');
    expect(db.prepare('SELECT COUNT(*) n FROM courses').get().n).toBe(0);
    expect(finalizeArchivedCourse).not.toHaveBeenCalled();
  });
});

describe('runPastImport (the queue runner for kind import, #171)', () => {
  test('imports the section and reports the course and its counts', async () => {
    const events = [];
    const importer = vi.fn().mockResolvedValue({ course: { id: 4, course_name: 'Old Bio' }, studentsCount: 20, assignmentsCount: 30, gradesCount: 400 });
    await runPastImport({ kind: 'import', sectionId: 7001, trigger: 'page' }, (e) => events.push(e), { db, deps: { importArchivedCourse: importer } });
    expect(importer).toHaveBeenCalledWith(db, '7001');
    expect(events[0]).toEqual({ type: 'log', message: 'Imported Old Bio: 20 students, 30 assignments, 400 grades' });
    expect(events).toHaveLength(2); // no warning line: mastery was read
    expect(events[1]).toMatchObject({
      type: 'summary',
      import: { sectionId: '7001', courseId: 4, courseName: 'Old Bio', studentsCount: 20, assignmentsCount: 30, gradesCount: 400 },
      elapsedMs: expect.any(Number),
    });
  });

  test('a mastery read that failed is a warning line in the run, and in the summary', async () => {
    const events = [];
    const importer = vi.fn().mockResolvedValue({
      course: { id: 4, course_name: 'Old Bio' }, studentsCount: 20, assignmentsCount: 30, gradesCount: 400,
      finalized: true, masteryError: 'Schoology sign-in needed',
    });
    await runPastImport({ kind: 'import', sectionId: '7001' }, (e) => events.push(e), { db, deps: { importArchivedCourse: importer } });
    const warning = events.find((e) => e.type === 'log' && e.message.includes('mastery'));
    expect(warning.message).toBe('Imported "Old Bio"; mastery could not be read: Schoology sign-in needed');
    expect(classifyEvent(warning)).toBe('warning');
    expect(events.at(-1).import.masteryError).toBe('Schoology sign-in needed');
  });

  test('an import error is left for the queue (the run fails, no summary)', async () => {
    const events = [];
    const importer = vi.fn().mockRejectedValue(new Error('Schoology API 403: Forbidden'));
    await expect(runPastImport({ kind: 'import', sectionId: '7001' }, (e) => events.push(e), { db, deps: { importArchivedCourse: importer } }))
      .rejects.toThrow('403');
    expect(events).toEqual([]);
  });
});
