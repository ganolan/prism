import { describe, test, expect, vi } from 'vitest';
import { reportPastCourses, checkPastCourses } from './check-past-courses.js';

const row = (over) => ({ courseTitle: 'PCG', sectionTitle: '10(A-B)', courseCode: 'P', sectionId: '1', gradingPeriod: '2023-2024', imported: true, noCourseCode: false, givenUp: false, linkedSectionIds: [], ...over });

describe('reportPastCourses (#178)', () => {
  test('every coded section held: ok, templates counted apart', () => {
    const r = reportPastCourses([row(), row({ sectionId: '2', noCourseCode: true, imported: false })]);
    expect(r).toEqual({ ok: true, lines: ['2 past sections in Schoology: 1 held by Prism, 0 missing, 1 template (no course code, never imported)'] });
  });

  test('lists each missing section with why', () => {
    const r = reportPastCourses([
      row({ imported: false, sectionId: '6803621358', courseTitle: 'AI & ML', sectionTitle: '4(A-B), 6(A-B)', linkedSectionIds: ['6803621359'] }),
      row({ imported: false, givenUp: true, sectionId: '9' }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.lines.slice(1)).toEqual([
      '  missing: AI & ML 4(A-B), 6(A-B) [2023-2024] section 6803621358 (linked: 6803621359): not imported yet: the past-course import takes it after the next full sync',
      '  missing: PCG 10(A-B) [2023-2024] section 9: the import failed twice: import it from the Archived tab',
    ]);
  });
});

describe('checkPastCourses', () => {
  test('reads the discover endpoint', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ available: true, sections: [row()] }) }));
    expect((await checkPastCourses('http://x', { fetchImpl })).ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/courses/archived/discover');
  });

  test('Schoology unreadable, an HTTP error or no server: not ok', async () => {
    const unavailable = vi.fn(async () => ({ ok: true, json: async () => ({ available: false, reason: 'unavailable' }) }));
    expect(await checkPastCourses('http://x', { fetchImpl: unavailable })).toEqual({ ok: false, lines: ['http://x: Schoology could not be read (unavailable)'] });
    expect((await checkPastCourses('http://x', { fetchImpl: async () => ({ ok: false, status: 500 }) })).lines).toEqual(['http://x: HTTP 500']);
    expect((await checkPastCourses('http://x', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).ok).toBe(false);
  });
});
