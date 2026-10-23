import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const h = vi.hoisted(() => ({ db: null }));
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDb: () => h.db };
});

import { migrate } from '../db/index.js';
import { syncPsAttendance, applyGradeLevels } from './psAttendanceSync.js';
import { fakePowerSchoolWeb } from '../testing/fakePowerSchoolWeb.js';

function seed(db, name, { archived = 0, excluded = 0 } = {}) {
  const id = db.prepare('INSERT INTO courses (schoology_section_id, course_name) VALUES (?, ?)').run(`sec-${name}`, name).lastInsertRowid;
  db.prepare('UPDATE courses SET archived = ?, excluded = ? WHERE id = ?').run(archived, excluded, id);
  return id;
}

describe('syncPsAttendance — guard', () => {
  beforeEach(() => { h.db = new Database(':memory:'); migrate(h.db); });

  // When there are no ACTIVE courses, the service must return before launching a
  // browser. (It returns prior to the session-file check and openPage, so this
  // is safe to run without a Playwright session.)
  test('no active courses → processed 0, no browser launched', async () => {
    const s = await syncPsAttendance();
    expect(s).toEqual({ processed: 0, updated: 0, unchanged: 0, skipped: 0, schoolDays: 0, gradeLevels: { seen: 0, updated: 0 }, results: [], noCourses: true, stoppedEarly: false });
  });

  test('default (active) ignores archived/excluded courses → no-op', async () => {
    seed(h.db, 'old', { archived: 1 });
    seed(h.db, 'template', { excluded: 1 });
    const s = await syncPsAttendance();
    expect(s.processed).toBe(0);
  });

  test('courseIds excludes template/excluded courses → no-op (no browser)', async () => {
    const id = seed(h.db, 'template', { excluded: 1 });
    const s = await syncPsAttendance({ courseIds: [id] });
    expect(s.processed).toBe(0);
  });
});

// A section_info[0] with one period ("Block 3" by default), meeting on the days
// whose bell schedule is 77; every value made up.
// `psm`: the psmSectionId the grade pass reads the student list by (none: it
// falls back to section_attendance).
function info(name = 'Block 3', { days = { '2026-10-05': 77, '2026-10-06': 78, '2026-10-07': 77 }, psm } = {}) {
  return {
    ...(psm ? { psmSectionId: psm } : {}),
    periodIdToPsmPeriodIdMap: { 4202: '1' },
    bellScheduleItems: [{ periodId: 4202, bellScheduleId: 77, period: { id: 4202, name, abbreviation: 'BK', periodNumber: 2 } }],
    calenderDays: Object.fromEntries(Object.entries(days).map(([d, bell]) => [d, { inSession: true, cycleDay: { letter: 'A' }, bellScheduleId: bell }])),
  };
}

describe('syncPsAttendance over plain HTTP (no browser, #141)', () => {
  let web;
  beforeEach(() => { h.db = new Database(':memory:'); migrate(h.db); });
  const run = (opts = {}) => syncPsAttendance({ deps: { jar: web.jar, fetchImpl: web.fetchImpl }, ...opts });
  const course = (id) => h.db.prepare('SELECT block_number, block_synced_at FROM courses WHERE id = ?').get(id);
  const psReads = (name) => web.requests.filter((r) => r.path === `/ws/attendance/${name}`);

  test('one launch for the whole pass: per course the block, its lessons, the calendar; then grade levels on the same session', async () => {
    const a = seed(h.db, 'A');
    const b = seed(h.db, 'B');
    const stu = h.db.prepare("INSERT INTO students (first_name, last_name, school_uid) VALUES ('F', 'L', '1_501')").run().lastInsertRowid;
    web = fakePowerSchoolWeb({
      schoology: { 'sec-A': '9001', 'sec-B': '9002' },
      sectionInfo: { 9001: info('Block 3', { psm: 'P9001' }), 9002: info('Block 6', { psm: 'P9002' }) },
      sections: { 9001: [{ studentid: '1', studentdcid: '501', gradeLevel: 10 }] },
    });
    const s = await run();
    expect(s).toMatchObject({ processed: 2, updated: 2, skipped: 0, schoolDays: 3, gradeLevels: { seen: 1, updated: 1 } });
    expect(s.gradeLevels.sources).toMatchObject({ students_integration: 1, failed: 0 });
    expect(course(a).block_number).toBe('3');
    expect(course(b).block_number).toBe('6');
    expect(web.launches()).toBe(1); // the grade pass shares the block loop's session
    // The launch posts the form just read for the first course (no second form read).
    expect(web.requests.filter((r) => r.path.startsWith('/apps/lti/')).length).toBe(2);
    // section_info once per section: the grade pass reuses the answer in hand.
    expect(psReads('section_info').map((r) => r.params.sectionDcid)).toEqual(['9001', '9002']);
    expect(psReads('section_info').every((r) => r.accept === 'application/json' && r.cookie.includes('JSESSIONID='))).toBe(true);
    expect(web.requests.filter((r) => r.path.endsWith('/students_integration')).map((r) => r.path)).toEqual(['/ws/pt/v1/section/P9001/students_integration', '/ws/pt/v1/section/P9002/students_integration']);
    expect(h.db.prepare('SELECT date FROM class_meetings WHERE course_id = ? ORDER BY date').all(a).map((r) => r.date)).toEqual(['2026-10-05', '2026-10-07']);
    expect(h.db.prepare('SELECT grad_year FROM students WHERE id = ?').get(stu).grad_year).not.toBeNull();
  });

  test('a template course (no sectionDcid) is skipped and does not start the session', async () => {
    const t = seed(h.db, 'T');
    seed(h.db, 'Z');
    web = fakePowerSchoolWeb({ schoology: { 'sec-T': null, 'sec-Z': '9003' }, sectionInfo: { 9003: info('Pastoral Care') } });
    const s = await run();
    expect(s.results.map((r) => r.reason)).toEqual(['no-section-dcid', 'not-numbered']);
    expect(course(t).block_number).toBeNull();
    expect(course(t).block_synced_at).not.toBeNull();
    expect(web.launches()).toBe(1);
  });

  // #174: each course's PowerSchool term (its calendar's first and last school day), for semester ends.
  const term = (id) => h.db.prepare('SELECT term_start, term_end FROM courses WHERE id = ?').get(id);
  test('stores each course\'s term range from its section_info calendar', async () => {
    const a = seed(h.db, 'A');
    web = fakePowerSchoolWeb({
      schoology: { 'sec-A': '9001' },
      sectionInfo: { 9001: info('Block 3', { days: { '2026-08-20': 77, '2026-10-06': 78, '2027-01-08': 77 } }) },
    });
    await run();
    expect(term(a)).toEqual({ term_start: '2026-08-20', term_end: '2027-01-08' });
  });

  test('a targeted sync stores the term range too', async () => {
    const a = seed(h.db, 'A');
    web = fakePowerSchoolWeb({ schoology: { 'sec-A': '9001' }, sectionInfo: { 9001: info('Block 3') } });
    await run({ courseIds: [a] });
    expect(term(a)).toEqual({ term_start: '2026-10-05', term_end: '2026-10-07' });
  });

  test('a section_info error keeps the stored term range', async () => {
    const a = seed(h.db, 'A');
    h.db.prepare("UPDATE courses SET term_start = '2026-08-20', term_end = '2027-01-08' WHERE id = ?").run(a);
    web = fakePowerSchoolWeb({ schoology: { 'sec-A': '9001' }, sectionInfo: { 9001: { status: 500 } } });
    await run();
    expect(term(a)).toEqual({ term_start: '2026-08-20', term_end: '2027-01-08' });
  });

  test('a section_info error keeps the stored block: section-info-failed', async () => {
    const a = seed(h.db, 'A');
    h.db.prepare("UPDATE courses SET block_number = '5' WHERE id = ?").run(a);
    web = fakePowerSchoolWeb({ schoology: { 'sec-A': '9001' }, sectionInfo: { 9001: { status: 500 } } });
    const s = await run();
    expect(s.results[0]).toMatchObject({ reason: 'section-info-failed', status: 'skipped' });
    expect(course(a).block_number).toBe('5');
    expect(web.launches()).toBe(1); // an error status is about the section, not the session
  });

  test('the PowerSchool session ends mid-loop → one relaunch, the read asked again', async () => {
    const a = seed(h.db, 'A');
    seed(h.db, 'B');
    web = fakePowerSchoolWeb({
      schoology: { 'sec-A': '9001', 'sec-B': '9002' },
      sectionInfo: { 9001: info('Block 3'), 9002: info('Block 6') },
      expireOnce: 'section_info',
    });
    const s = await run();
    expect(s.updated).toBe(2);
    expect(course(a).block_number).toBe('3');
    expect(web.launches()).toBe(2);
  });

  test('a grade-level read failure is logged and skipped; the block is still stored', async () => {
    const a = seed(h.db, 'A');
    web = fakePowerSchoolWeb({
      schoology: { 'sec-A': '9001' }, sectionInfo: { 9001: info('Block 3', { psm: 'P9001' }) },
      sections: { 9001: [{ studentid: '1', studentdcid: '501', gradeLevel: 10 }] },
      failRead: (name) => name === 'students_integration' || name === 'section_attendance',
    });
    const s = await run();
    expect(course(a).block_number).toBe('3');
    expect(s.gradeLevels).toMatchObject({ seen: 0, sources: { failed: 1 } });
    expect(web.launches()).toBe(1); // an error status is not a lost session
  });

  test('a "Security Violation Logged" page in the grade pass stops it (thrown), blocks already stored', async () => {
    const a = seed(h.db, 'A');
    web = fakePowerSchoolWeb({
      schoology: { 'sec-A': '9001' }, sectionInfo: { 9001: info('Block 3', { psm: 'P9001' }) },
      sections: { 9001: [{ studentid: '1', studentdcid: '501', gradeLevel: 10 }] },
      failRead: (name) => name === 'students_integration' && '<h1>Security Violation Logged: Attempted to run an unauthorized action</h1>',
    });
    await expect(run()).rejects.toMatchObject({ code: 'PS_SECURITY' });
    expect(web.requests.some((r) => r.path === '/ws/attendance/section_attendance')).toBe(false); // no fallback read
    expect(course(a).block_number).toBe('3');
  });

  test('a "Security Violation Logged" page stops the whole pass at once', async () => {
    seed(h.db, 'A');
    seed(h.db, 'B');
    web = fakePowerSchoolWeb({
      schoology: { 'sec-A': '9001', 'sec-B': '9002' },
      sectionInfo: { 9001: info('Block 3'), 9002: info('Block 6') },
      failRead: (name) => name === 'section_info' && '<html><h1>Security Violation Logged: Attempted to run an unauthorized action</h1></html>',
    });
    await expect(run()).rejects.toThrow(/Security Violation Logged/);
    expect(psReads('section_info')).toHaveLength(1);
    expect(web.launches()).toBe(1);
  });

  test('a Schoology session sent to sign-in → the login error, nothing stored', async () => {
    const a = seed(h.db, 'A');
    web = fakePowerSchoolWeb({ loginRedirect: true });
    await expect(run()).rejects.toThrow(/mastery:login/);
    expect(course(a).block_synced_at).toBeNull();
  });

  test('PowerSchool refuses the launch → a PowerSchool error, nothing stored', async () => {
    const a = seed(h.db, 'A');
    web = fakePowerSchoolWeb({ schoology: { 'sec-A': '9001' }, launchStatus: 403 });
    await expect(run()).rejects.toThrow(/PowerSchool attendance app did not load/);
    expect(course(a).block_synced_at).toBeNull();
  });

  test('no saved Schoology session → the login error before any request', async () => {
    seed(h.db, 'A');
    web = fakePowerSchoolWeb();
    await expect(syncPsAttendance({ deps: { jar: null, fetchImpl: web.fetchImpl } })).rejects.toThrow(/mastery:login/);
    expect(web.requests).toEqual([]);
  });

  test('a whole pass reports that it neither stopped early nor found no course', async () => {
    seed(h.db, 'A');
    web = fakePowerSchoolWeb({ schoology: { 'sec-A': '9001' }, sectionInfo: { 9001: info('Block 2') } });
    expect(await run()).toMatchObject({ noCourses: false, stoppedEarly: false, schoolDays: 3 });
  });

  test('final review #4: a pass the time budget stopped reports stoppedEarly and keeps the calendar', async () => {
    seed(h.db, 'A');
    seed(h.db, 'B');
    web = fakePowerSchoolWeb({ schoology: { 'sec-A': '9001', 'sec-B': '9002' }, sectionInfo: { 9001: info('Block 2'), 9002: info('Block 3') } });
    const s = await run({ deps: { jar: web.jar, fetchImpl: web.fetchImpl, loopBudgetMs: 0 } });
    expect(s).toMatchObject({ stoppedEarly: true, noCourses: false, processed: 0, schoolDays: 0 });
    expect(h.db.prepare('SELECT COUNT(*) n FROM school_days').get().n).toBe(0);
  });

  test('a targeted sync never replaces the school calendar', async () => {
    const a = seed(h.db, 'A', { archived: 1 });
    web = fakePowerSchoolWeb({ schoology: { 'sec-A': '9001' }, sectionInfo: { 9001: info('Block 2') } });
    const s = await run({ courseIds: [a] });
    expect(course(a).block_number).toBe('2');
    expect(s.schoolDays).toBe(0);
    expect(h.db.prepare('SELECT COUNT(*) n FROM school_days').get().n).toBe(0);
  });
});

describe('applyGradeLevels', () => {
  beforeEach(() => { h.db = new Database(':memory:'); migrate(h.db); });

  function seedStudent(schoolUid, gradYear = null) {
    const id = h.db.prepare(
      'INSERT INTO students (first_name, last_name, school_uid, grad_year) VALUES (?, ?, ?, ?)'
    ).run('First', 'Last', schoolUid, gradYear).lastInsertRowid;
    return id;
  }

  test('sets grad_year for matched students and leaves unmatched ones untouched', () => {
    const matched = seedStudent('1_42302', null);     // Gr 10 → 2028
    const other = seedStudent('1_77777', 2099);        // not in the map → preserved
    const map = new Map([['42302', 10], ['00000', 11]]); // 00000 has no matching student

    const updated = applyGradeLevels(h.db, map, new Date('2026-01-15'));

    expect(updated).toBe(1);
    const row = h.db.prepare('SELECT grad_year, updated_at FROM students WHERE id = ?').get(matched);
    expect(row.grad_year).toBe(2028);
    expect(row.updated_at).toBe('2026-01-15T00:00:00.000Z'); // now stamped on the update
    expect(h.db.prepare('SELECT grad_year FROM students WHERE id = ?').get(other).grad_year).toBe(2099);
  });

  test('empty map → no updates', () => {
    seedStudent('1_42302', 2027);
    expect(applyGradeLevels(h.db, new Map(), new Date('2026-01-15'))).toBe(0);
  });

  // The rest of the sync layer threads `now` as a pre-serialised ISO string;
  // applyGradeLevels must accept that form too (not just a Date).
  test('accepts an ISO-string `now`', () => {
    const matched = seedStudent('1_42302', null); // Gr 10 → 2028
    const updated = applyGradeLevels(h.db, new Map([['42302', 10]]), '2026-01-15T00:00:00.000Z');
    expect(updated).toBe(1);
    expect(h.db.prepare('SELECT grad_year FROM students WHERE id = ?').get(matched).grad_year).toBe(2028);
  });
});
