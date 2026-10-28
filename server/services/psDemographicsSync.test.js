// #191: each current student's Demographics screen, read once per school year by the teacher's click path.
// #190: on the same visit, the student's counselors (GET /ws/studentcounselor/{dcid}), also once per school year.
import { describe, test, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';
import { syncDemographics, studentsToRead, schoolYearStart, storeCounselors, DEMOGRAPHICS_PER_RUN } from './psDemographicsSync.js';
import { applyGradeLevels } from './psAttendanceSync.js';

const NOW = new Date('2026-10-28T01:00:00Z');
const row = (label, value) => `<tr><td><strong>${label}</strong></td><td>${value}</td></tr>`;
const demo = ({ number, dob = '06/15/2010', year = '2028', room = 'Teacher, Sam', guardianship = '' }) =>
  `<table>${row('Address', '1 Example Road')}${row('DOB', dob)}${row('Graduation Year', year)}${row('Home Room', room)}${row('Guardianship', guardianship)}${row('Student number', number)}</table>`;

let db;
const student = (dcid, number, extra = {}) => db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name, school_uid, email, grad_year, demographics_read_at, counselors_read_at)
  VALUES (?, 'A', 'B', ?, ?, ?, ?, ?)`).run(`u${dcid}`, `1_${dcid}`, number ? `${number}@hkis.edu.hk` : null, extra.gradYear ?? null, extra.readAt ?? null, ('counselorsAt' in extra ? extra.counselorsAt : extra.readAt) ?? null).lastInsertRowid;
const counselorRows = (id) => db.prepare('SELECT ps_user_dcid, first_name, last_name, is_primary, email FROM student_counselors WHERE student_id = ? ORDER BY ps_user_dcid').all(id);
const pair = (dcid) => [
  { id: 1, studentDcid: Number(dcid), userDcid: 71, userFirstName: 'Sam', userLastName: 'Lee', isPrimary: true, '@extensions': null },
  { id: 2, studentDcid: Number(dcid), userDcid: 72, userFirstName: 'Jo', userLastName: 'Chan', isPrimary: false, '@extensions': null },
];
const stored = (id) => db.prepare('SELECT date_of_birth, ps_grad_year, grad_year, home_room, guardianship, demographics_read_at FROM students WHERE id = ?').get(id);

// A PowerSchoolWeb stand-in: records each teacher page and its Referer; answers demo.html from `pages` by dcid, and
// the counselor read from `counselors` by dcid (default: the student's pair; an Error is thrown).
function fakePs(pages, { endOnce = null, security = null, counselors = {} } = {}) {
  const visits = [];
  let ended = false;
  return {
    visits,
    teacherJson: async (path, { referer } = {}) => {
      visits.push([path, referer?.split('?')[0] ?? null]);
      const dcid = path.split('/').pop();
      const answer = dcid in counselors ? counselors[dcid] : pair(dcid);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    teacherPage: async (path, { referer } = {}) => {
      visits.push([path.split('?')[0], referer?.split('?')[0] ?? null]);
      const dcid = (path.match(/frn=001(\d+)/) || [])[1];
      if (security && path.includes(`frn=001${security}`) && path.includes('demo.html')) {
        throw Object.assign(new Error('Security Violation Logged'), { code: 'PS_SECURITY' });
      }
      if (endOnce && dcid === endOnce && !ended && path.includes('menu.html') === false && path.includes('demo.html')) {
        ended = true;
        throw Object.assign(new Error('PowerSchool answered 302'), { code: 'PS_SESSION', sessionEnded: true });
      }
      return path.includes('demo.html') ? pages[dcid] ?? '<html></html>' : '<html>page</html>';
    },
  };
}
const opts = (extra = {}) => ({ now: NOW, sleep: async () => {}, ...extra });

beforeEach(() => { db = new Database(':memory:'); migrate(db); });

describe('syncDemographics', () => {
  test('follows the click path with each Referer, and stores only the kept fields; PowerSchool\'s graduation year wins', async () => {
    const ana = student('5001', '280123', { gradYear: 2027 });
    const ps = fakePs({ 5001: demo({ number: '280123' }) });
    const r = await syncDemographics(db, ps, [{ sectionDcid: '9001', roster: [{ studentdcid: '5001' }] }], opts());
    expect(r).toEqual({ read: 1, stored: 1, mismatched: 0, failed: 0, counselors: { stored: 1, mismatched: 0, failed: 0 } });
    expect(ps.visits).toEqual([
      ['/teachers/home.html', null],
      ['/teachers/summary.html', '/teachers/home.html'],
      ['/teachers/menu.html', '/teachers/summary.html'],
      ['/teachers/studentpages/home.html', '/teachers/menu.html'],
      ['/teachers/studentpages/demo.html', '/teachers/studentpages/home.html'],
      ['/ws/studentcounselor/5001', '/teachers/studentpages/demo.html'],
    ]);
    expect(counselorRows(ana)).toEqual([
      { ps_user_dcid: '71', first_name: 'Sam', last_name: 'Lee', is_primary: 1, email: null },
      { ps_user_dcid: '72', first_name: 'Jo', last_name: 'Chan', is_primary: 0, email: null },
    ]);
    expect(stored(ana)).toEqual({
      date_of_birth: '2010-06-15', ps_grad_year: 2028, grad_year: 2028, home_room: 'Teacher, Sam', guardianship: null,
      demographics_read_at: NOW.toISOString(),
    });
    // The derived year from a grade level no longer overrides PowerSchool's own.
    applyGradeLevels(db, new Map([['5001', 11]]), NOW);
    expect(stored(ana).grad_year).toBe(2028);
  });

  test('a page whose Student number is another student\'s, or a student with no number in Prism, stores nothing', async () => {
    const ana = student('5001', '280123');
    const bo = student('5002', null);
    const ps = fakePs({ 5001: demo({ number: '280999' }), 5002: demo({ number: '280124' }) });
    const r = await syncDemographics(db, ps, [{ sectionDcid: '9001', roster: [{ studentdcid: '5001' }, { studentdcid: '5002' }] }], opts());
    expect(r).toMatchObject({ read: 2, stored: 0, mismatched: 2 });
    expect(stored(ana).date_of_birth).toBeNull();
    expect(stored(bo).demographics_read_at).toBeNull();
  });

  test('a student read since 1 August is not read again; one read last school year is', async () => {
    student('5001', '280123', { readAt: '2026-09-01T00:00:00.000Z' });
    const old = student('5002', '280124', { readAt: '2026-06-01T00:00:00.000Z' });
    const ps = fakePs({ 5002: demo({ number: '280124' }) });
    const sections = [{ sectionDcid: '9001', roster: [{ studentdcid: '5001' }, { studentdcid: '5002' }, { studentdcid: '7777' }] }];
    expect(studentsToRead(db, sections, NOW)).toEqual([{ sectionDcid: '9001', students: [{ id: old, dcid: '5002', number: '280124', demographics: true, counselors: true }] }]);
    expect(schoolYearStart(NOW)).toBe('2026-08-01');
    expect(schoolYearStart(new Date('2027-03-01T00:00:00Z'))).toBe('2026-08-01');
    await syncDemographics(db, ps, sections, opts());
    expect(stored(old).demographics_read_at).toBe(NOW.toISOString());
  });

  test('a student whose counselors are due but not the Demographics: the counselors are read, the Demographics kept', async () => {
    const ana = student('5001', '280123', { readAt: '2026-09-01T00:00:00.000Z', counselorsAt: null });
    const ps = fakePs({ 5001: demo({ number: '280123', dob: '01/02/2011' }) });
    const r = await syncDemographics(db, ps, [{ sectionDcid: '9001', roster: [{ studentdcid: '5001' }] }], opts());
    expect(r).toMatchObject({ read: 1, stored: 0, counselors: { stored: 1 } });
    expect(stored(ana)).toMatchObject({ date_of_birth: null, demographics_read_at: '2026-09-01T00:00:00.000Z' });
    expect(counselorRows(ana)).toHaveLength(2);
  });

  test('a counselor list for another student, or a page not the student\'s, stores no counselors', async () => {
    const ana = student('5001', '280123');
    const bo = student('5002', '280124');
    const ps = fakePs({ 5001: demo({ number: '280123' }), 5002: demo({ number: '280999' }) }, { counselors: { 5001: pair('5009') } });
    const r = await syncDemographics(db, ps, [{ sectionDcid: '9001', roster: [{ studentdcid: '5001' }, { studentdcid: '5002' }] }], opts());
    expect(r.counselors).toEqual({ stored: 0, mismatched: 1, failed: 0 });
    expect(ps.visits.filter(([p]) => p.startsWith('/ws/'))).toEqual([['/ws/studentcounselor/5001', '/teachers/studentpages/demo.html']]);
    expect(counselorRows(ana)).toEqual([]);
    expect(db.prepare('SELECT counselors_read_at FROM students WHERE id IN (?, ?)').all(ana, bo).map((x) => x.counselors_read_at)).toEqual([null, null]);
  });

  test('a failed counselor read is counted, keeps the Demographics and is tried again next night', async () => {
    const ana = student('5001', '280123');
    const ps = fakePs({ 5001: demo({ number: '280123' }) }, { counselors: { 5001: Object.assign(new Error('PowerSchool answered 500'), { code: 'PS_SESSION' }) } });
    const r = await syncDemographics(db, ps, [{ sectionDcid: '9001', roster: [{ studentdcid: '5001' }] }], opts());
    expect(r).toMatchObject({ stored: 1, counselors: { stored: 0, failed: 1 } });
    expect(stored(ana).date_of_birth).toBe('2010-06-15');
    expect(studentsToRead(db, [{ sectionDcid: '9001', roster: [{ studentdcid: '5001' }] }], NOW)[0].students[0]).toMatchObject({ demographics: false, counselors: true });
  });

  test('a Security Violation page on the counselor read stops the sync', async () => {
    student('5001', '280123');
    const ps = fakePs({ 5001: demo({ number: '280123' }) }, { counselors: { 5001: Object.assign(new Error('Security Violation Logged'), { code: 'PS_SECURITY' }) } });
    await expect(syncDemographics(db, ps, [{ sectionDcid: '9001', roster: [{ studentdcid: '5001' }] }], opts())).rejects.toMatchObject({ code: 'PS_SECURITY' });
  });

  test('storeCounselors replaces the list; a counselor still on it keeps their matched email', () => {
    const ana = student('5001', '280123');
    storeCounselors(db, ana, [{ userDcid: '71', firstName: 'Sam', lastName: 'Lee', isPrimary: true }, { userDcid: '72', firstName: 'Jo', lastName: 'Chan', isPrimary: false }], NOW);
    db.prepare("UPDATE student_counselors SET email = 'slee@hkis.edu.hk' WHERE ps_user_dcid = '71'").run();
    storeCounselors(db, ana, [{ userDcid: '71', firstName: 'Sam', lastName: 'Lee', isPrimary: false }, { userDcid: '73', firstName: 'Al', lastName: 'Ng', isPrimary: true }], NOW);
    expect(counselorRows(ana)).toEqual([
      { ps_user_dcid: '71', first_name: 'Sam', last_name: 'Lee', is_primary: 0, email: 'slee@hkis.edu.hk' },
      { ps_user_dcid: '73', first_name: 'Al', last_name: 'Ng', is_primary: 1, email: null },
    ]);
    storeCounselors(db, ana, [], NOW);
    expect(counselorRows(ana)).toEqual([]);
  });

  test('a student in two sections is read once, and one run reads at most the cap', () => {
    for (let i = 0; i < DEMOGRAPHICS_PER_RUN + 5; i++) student(String(6000 + i), String(290000 + i));
    const roster = Array.from({ length: DEMOGRAPHICS_PER_RUN + 5 }, (_, i) => ({ studentdcid: String(6000 + i) }));
    const plan = studentsToRead(db, [{ sectionDcid: '1', roster }, { sectionDcid: '2', roster: roster.slice(0, 3) }], NOW);
    expect(plan.reduce((n, s) => n + s.students.length, 0)).toBe(DEMOGRAPHICS_PER_RUN);
    expect(plan.map((s) => s.sectionDcid)).toEqual(['1']);
  });

  test('a session that ends mid-read is started again once and the path walked again', async () => {
    const ana = student('5001', '280123');
    let relaunched = 0;
    const ps = fakePs({ 5001: demo({ number: '280123' }) }, { endOnce: '5001' });
    const r = await syncDemographics(db, ps, [{ sectionDcid: '9001', roster: [{ studentdcid: '5001' }] }], opts({ relaunch: async () => { relaunched += 1; } }));
    expect(relaunched).toBe(1);
    expect(r).toMatchObject({ stored: 1 });
    expect(ps.visits.map(([p]) => p).slice(5)).toEqual(['/teachers/home.html', '/teachers/summary.html', '/teachers/menu.html', '/teachers/studentpages/home.html', '/teachers/studentpages/demo.html', '/ws/studentcounselor/5001']);
    expect(stored(ana).date_of_birth).toBe('2010-06-15');
  });

  test('a Security Violation page stops at once: thrown, and no later student is read', async () => {
    student('5001', '280123');
    const bo = student('5002', '280124');
    const ps = fakePs({ 5002: demo({ number: '280124' }) }, { security: '5001' });
    await expect(syncDemographics(db, ps, [{ sectionDcid: '9001', roster: [{ studentdcid: '5001' }, { studentdcid: '5002' }] }], opts()))
      .rejects.toMatchObject({ code: 'PS_SECURITY' });
    expect(ps.visits.filter(([p]) => p === '/teachers/studentpages/demo.html')).toHaveLength(1);
    expect(stored(bo).demographics_read_at).toBeNull();
  });

  test('another failed page is counted and the next student is still read', async () => {
    student('5001', '280123');
    const bo = student('5002', '280124');
    const ps = fakePs({ 5002: demo({ number: '280124' }) });
    const page = ps.teacherPage;
    ps.teacherPage = async (path, o) => {
      if (path.includes('demo.html') && path.includes('frn=0015001')) throw Object.assign(new Error('PowerSchool answered 500'), { code: 'PS_SESSION', sessionEnded: false });
      return page(path, o);
    };
    const r = await syncDemographics(db, ps, [{ sectionDcid: '9001', roster: [{ studentdcid: '5001' }, { studentdcid: '5002' }] }], opts());
    expect(r).toMatchObject({ failed: 1, stored: 1 });
    expect(stored(bo).date_of_birth).toBe('2010-06-15');
  });
});
