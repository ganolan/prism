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

  // Live-verified 2026-05-31: the real /courses/mycourses/past page renders a
  // course once PER TERM, so the same course-{id} appears on multiple
  // course-item rows (45 rows / 19 distinct course ids / 49 unique sections).
  // The parser must NOT dedupe by courseId — it emits one row per section, and
  // each row's title/code comes from ITS OWN course-item row.
  test('a course id recurring across rows yields one row per section, attributed per-row', () => {
    const recurring = `
      <li class="course-item" id="course-500">
        <span class="course-title">Maths 7</span><span class="course-code">MATH7</span>
        <div class="section-item" id="section-9001"><a href="/course/9001">S1</a></div>
      </li>
      <li class="course-item" id="course-500">
        <span class="course-title">Maths 7</span><span class="course-code">MATH7-S2</span>
        <div class="section-item" id="section-9002"><a href="/course/9002">S2</a></div>
      </li>`;
    const out = parsePastCourses(recurring);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.courseId === '500')).toBe(true);
    expect(out.map((r) => r.sectionId).sort()).toEqual(['9001', '9002']);
    // each section keeps the code from its own row, not the first row's
    expect(out.find((r) => r.sectionId === '9002').courseCode).toBe('MATH7-S2');
  });
});
