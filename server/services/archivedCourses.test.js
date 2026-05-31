import { describe, test, expect } from 'vitest';
import { getArchivedSections } from './archivedCourses.js';
import { PAST_COURSES_HTML } from '../lib/__fixtures__/pastCoursesSample.js';

describe('getArchivedSections', () => {
  test('parses sections from fetched html', async () => {
    const list = await getArchivedSections(async () => PAST_COURSES_HTML);
    expect(list).toHaveLength(4);
    expect(list.map((s) => s.sectionId)).toContain('7002');
  });

  test('returns null when html is unavailable (no/expired session)', async () => {
    const list = await getArchivedSections(async () => null);
    expect(list).toBeNull();
  });
});
