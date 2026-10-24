import { describe, test, expect } from 'vitest';
import { PowerSchoolWeb } from './powerschoolWeb.js';
import { readSectionGradeLevels, readGradeLevels } from './psGradeLevelRead.js';
import { fakePowerSchoolWeb } from '../testing/fakePowerSchoolWeb.js';

const TODAY = '2026-10-16';
const s = (studentid, studentdcid, gradeLevel, extra = {}) => ({ studentid, studentdcid, gradeLevel, ...extra });
const SECTIONS = {
  9001: [s('101', '5001', 10), s('102', '5002', 9)],
  9002: [s('201', '6001', 11), s('202', '6002', 12)],
};

async function started(opts = {}) {
  const web = fakePowerSchoolWeb({ schoology: { S1: '9001', S2: '9002' }, sections: SECTIONS, ...opts });
  const ps = new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl });
  await ps.launch('S1');
  return { web, ps };
}
const paths = (web) => web.requests.map((r) => r.path);
const sorted = (grades) => [...grades].sort((a, b) => a.dcid.localeCompare(b.dcid));

describe('readSectionGradeLevels', () => {
  test('reads the section student list, joined to dcids through the roster, with no date read', async () => {
    const { web, ps } = await started();
    const r = await readSectionGradeLevels(ps, { sectionDcid: '9001', userDcid: '100', today: TODAY });
    expect(r.source).toBe('students_integration');
    expect(sorted(r.grades)).toEqual([{ dcid: '5001', gradeLevel: 10 }, { dcid: '5002', gradeLevel: 9 }]);
    expect(sorted(r.genders)).toEqual([{ dcid: '5001', gender: 'F' }, { dcid: '5002', gender: 'F' }]);
    expect(paths(web)).toContain('/ws/pt/v1/section/P9001/students_integration');
    expect(paths(web)).not.toContain('/ws/attendance/section_attendance');
    // /ws/pt/v1 answers 500 without exactly this Accept (AGENTS.md).
    const list = web.requests.find((q) => q.path.endsWith('/students_integration'));
    expect(list).toMatchObject({ method: 'GET', accept: 'application/json' });
  });

  test('uses a section_info already in hand instead of reading it again', async () => {
    const { web, ps } = await started();
    const sectionInfo = { psmSectionId: 'P9001', calenderDays: { [TODAY]: { inSession: true } } };
    const r = await readSectionGradeLevels(ps, { sectionDcid: '9001', userDcid: '100', sectionInfo, today: TODAY });
    expect(r.grades).toHaveLength(2);
    expect(paths(web)).not.toContain('/ws/attendance/section_info');
  });

  test('falls back to section_attendance over a date range when the student list fails', async () => {
    const { web, ps } = await started({ failRead: (name) => name === 'students_integration' });
    const r = await readSectionGradeLevels(ps, { sectionDcid: '9001', userDcid: '100', today: TODAY });
    expect(r.source).toBe('section_attendance');
    expect(r.genders).toEqual([]); // section_attendance carries no gender
    expect(r.fallbackReason).toMatch(/500/);
    expect(sorted(r.grades)).toEqual([{ dcid: '5001', gradeLevel: 10 }, { dcid: '5002', gradeLevel: 9 }]);
    const sa = web.requests.find((q) => q.path === '/ws/attendance/section_attendance');
    expect(sa).toMatchObject({ method: 'GET', accept: 'application/json' });
    expect(sa.params).toMatchObject({ sectionDcid: '9001', userDcid: '100', includeStudentAlerts: 'false' });
    expect(sa.params.startDate <= sa.params.endDate).toBe(true);
  });

  test('falls back when section_info has no psmSectionId', async () => {
    const { ps } = await started({ sectionInfo: { 9001: { calenderDays: { [TODAY]: { inSession: true } } } } });
    const r = await readSectionGradeLevels(ps, { sectionDcid: '9001', userDcid: '100', today: TODAY });
    expect(r).toMatchObject({ source: 'section_attendance', fallbackReason: 'no psmSectionId' });
    expect(r.grades).toHaveLength(2);
  });

  test('falls back when the list joins no student', async () => {
    const sections = { 9001: [s('101', '5001', 10, { photoURL: '/images/nophoto.png' })] };
    const { ps } = await started({ sections });
    const r = await readSectionGradeLevels(ps, { sectionDcid: '9001', userDcid: '100', today: TODAY });
    expect(r).toMatchObject({ source: 'section_attendance', grades: [{ dcid: '5001', gradeLevel: 10 }] });
    expect(r.fallbackReason).toMatch(/no student/);
  });

  test('throws when both reads fail, so the section keeps its grades', async () => {
    const { ps } = await started({ failRead: (name) => name === 'students_integration' || name === 'section_attendance' });
    await expect(readSectionGradeLevels(ps, { sectionDcid: '9001', userDcid: '100', today: TODAY })).rejects.toThrow();
  });
});

describe('readGradeLevels', () => {
  const sections = [
    { name: 'A', schoologySectionId: 'S1', sectionDcid: '9001', userDcid: '100' },
    { name: 'B', schoologySectionId: 'S2', sectionDcid: '9002', userDcid: '100' },
  ];
  const fresh = (opts = {}) => {
    const web = fakePowerSchoolWeb({ schoology: { S1: '9001', S2: '9002' }, sections: SECTIONS, ...opts });
    return { web, ps: new PowerSchoolWeb({ sgyJar: web.jar, fetchImpl: web.fetchImpl }) };
  };

  test('starts one PowerSchool session and merges every section', async () => {
    const { web, ps } = fresh();
    const r = await readGradeLevels({ ps, sections, today: TODAY });
    expect(web.launches()).toBe(1);
    expect([...r.gradeByDcid].sort()).toEqual([['5001', 10], ['5002', 9], ['6001', 11], ['6002', 12]]);
    expect([...r.genderByDcid.keys()].sort()).toEqual(['5001', '5002', '6001', '6002']);
    expect(r.sources).toEqual({ students_integration: 2, section_attendance: 0, failed: 0 });
  });

  test('a section that fails both reads is counted and skipped; the others still read', async () => {
    const { ps } = fresh({ failRead: (name, entry) => (name === 'students_integration' && entry.path.includes('P9002')) || (name === 'section_attendance' && entry.params.sectionDcid === '9002') });
    const r = await readGradeLevels({ ps, sections, today: TODAY });
    expect(r.sources).toEqual({ students_integration: 1, section_attendance: 0, failed: 1 });
    expect([...r.gradeByDcid.keys()].sort()).toEqual(['5001', '5002']);
  });

  test('a PowerSchool session that ends mid-pass is started again and the section re-read', async () => {
    const { web, ps } = fresh({ expireOnce: 'students_integration' });
    const r = await readGradeLevels({ ps, sections, today: TODAY });
    expect(web.launches()).toBe(2);
    expect(r.sources).toEqual({ students_integration: 2, section_attendance: 0, failed: 0 });
    expect(r.gradeByDcid.size).toBe(4);
  });

  test('a session PowerSchool will not start reads nothing and does not throw', async () => {
    const { ps } = fresh({ launchStatus: 403 });
    const r = await readGradeLevels({ ps, sections, today: TODAY });
    expect(r.gradeByDcid.size).toBe(0);
    expect(r.error).toMatch(/403/);
  });

  test('sections without a sectionDcid are skipped', async () => {
    const { web, ps } = fresh();
    const r = await readGradeLevels({ ps, sections: [{ name: 'T', schoologySectionId: 'S1', sectionDcid: null }], today: TODAY });
    expect(r.gradeByDcid.size).toBe(0);
    expect(web.launches()).toBe(0);
  });
});
