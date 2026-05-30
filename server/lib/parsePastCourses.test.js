import { describe, test, expect } from 'vitest';
import { parsePastCourses } from './parsePastCourses.js';
import { PAST_COURSES_HTML } from './__fixtures__/pastCoursesSample.js';

describe('parsePastCourses', () => {
  const rows = parsePastCourses(PAST_COURSES_HTML);

  test('returns one row per section, not one per course', () => {
    expect(rows).toHaveLength(4);
  });

  test('extracts courseId/title/code and sectionId for a single-section course', () => {
    const r = rows.find((x) => x.sectionId === '7001');
    expect(r).toMatchObject({
      courseId: '1001',
      courseTitle: 'Digital Design 9',
      courseCode: 'DSGN9',
      sectionId: '7001',
    });
    expect(r.sectionTitle).toBe('Section 2(A-B)');
  });

  test('emits one row per section for a multi-section course, sharing course fields', () => {
    const multi = rows.filter((x) => x.courseId === '1002');
    expect(multi.map((x) => x.sectionId).sort()).toEqual(['7002', '7003']);
    expect(multi.every((x) => x.courseCode === 'GAME10')).toBe(true);
  });

  test('a course with an empty .course-code yields courseCode null (no-code signal)', () => {
    const master = rows.find((x) => x.sectionId === '7004');
    expect(master.courseCode).toBeNull();
    expect(master.courseTitle).toContain('MASTER');
  });

  test('returns an empty array for empty/garbage html', () => {
    expect(parsePastCourses('')).toEqual([]);
    expect(parsePastCourses('<div>nothing here</div>')).toEqual([]);
  });
});
