import { describe, test, expect } from 'vitest';
import { getPastSections } from './pastCourses.js';
import { PAST_COURSES_HTML } from '../lib/__fixtures__/pastCoursesSample.js';

describe('getPastSections', () => {
  test('parses sections from fetched html', async () => {
    const list = await getPastSections(async () => PAST_COURSES_HTML);
    expect(list).toHaveLength(4);
    expect(list.map((s) => s.sectionId)).toContain('7002');
  });

  test('returns null when html is unavailable (no/expired session)', async () => {
    const list = await getPastSections(async () => null);
    expect(list).toBeNull();
  });
});
