import { describe, test, expect, vi } from 'vitest';
import { getArchivedSections, groupPastSections, linkedSectionsOf } from './archivedCourses.js';

// Rows as GET /users/{me}/sections?include_past=1 returns them (fields observed 2026-10-23, #178).
const row = (id, over = {}) => ({
  id, course_title: 'AI & MACHINE LEARNING', course_code: '6_4016312', section_title: `${id}(A-B)`,
  section_school_code: '44395', active: '0', parent_id: '0', grading_periods: [1045850], ...over,
});

function fakeApi(sections, periods = { 1045850: '2023-2024: 08/15/23 - 06/14/24' }) {
  return vi.fn(async (path) => {
    if (path === '/users/me') return { id: 77 };
    if (path === '/users/77/sections?include_past=1') return { section: sections };
    const gp = path.match(/^\/gradingperiods\/(\d+)$/);
    if (gp && periods[gp[1]]) return { id: Number(gp[1]), title: periods[gp[1]] };
    throw new Error(`Schoology API 404: GET ${path}`);
  });
}

describe('groupPastSections', () => {
  test('keeps past sections only, one row each', () => {
    const rows = groupPastSections([row('1'), row('2', { active: '1' }), row('3', { active: 0 })]);
    expect(rows.map((r) => r.sectionId)).toEqual(['1', '3']);
    expect(rows[0]).toMatchObject({
      courseTitle: 'AI & MACHINE LEARNING', courseCode: '6_4016312', sectionTitle: '1(A-B)', linkedSectionIds: [],
    });
  });

  test('a linked section joins its parent: one row, both titles, the child listed', () => {
    const rows = groupPastSections([row('4'), row('6', { parent_id: '4' }), row('9', { parent_id: null })]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sectionId: '4', sectionTitle: '4(A-B), 6(A-B)', linkedSectionIds: ['6'] });
    expect(rows[1]).toMatchObject({ sectionId: '9', linkedSectionIds: [] });
  });

  test('a child whose parent is not a past section is a row of its own', () => {
    const rows = groupPastSections([row('6', { parent_id: '4' })]);
    expect(rows).toMatchObject([{ sectionId: '6', linkedSectionIds: [] }]);
  });

  test('no course code: courseCode is null (a template)', () => {
    expect(groupPastSections([row('1', { course_code: '' })])[0].courseCode).toBeNull();
  });
});

describe('getArchivedSections (REST, #178)', () => {
  test('lists the past sections with their grading period titles', async () => {
    const get = fakeApi([row('4'), row('6', { parent_id: '4' })]);
    const rows = await getArchivedSections({ get });
    expect(rows).toEqual([{
      sectionId: '4', courseTitle: 'AI & MACHINE LEARNING', courseCode: '6_4016312', sectionTitle: '4(A-B), 6(A-B)',
      gradingPeriod: '2023-2024: 08/15/23 - 06/14/24', linkedSectionIds: ['6'],
    }]);
  });

  test('a grading period that cannot be read leaves the title null', async () => {
    const get = fakeApi([row('1', { grading_periods: [5] })], {});
    expect((await getArchivedSections({ get }))[0].gradingPeriod).toBeNull();
  });

  test('a failed section list returns null', async () => {
    const get = vi.fn().mockRejectedValue(new Error('Schoology API 503'));
    expect(await getArchivedSections({ get })).toBeNull();
  });
});

describe('linkedSectionsOf', () => {
  test('lists the sections linked to a parent', async () => {
    const get = fakeApi([row('4'), row('6', { parent_id: '4' }), row('7', { parent_id: '4', active: '1' }), row('8')]);
    expect(await linkedSectionsOf('4', { get })).toEqual([
      { sectionId: '6', sectionTitle: '6(A-B)' },
      { sectionId: '7', sectionTitle: '7(A-B)' },
    ]);
  });
});
