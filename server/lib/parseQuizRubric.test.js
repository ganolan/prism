import { describe, test, expect } from 'vitest';
import { parseQuizRubric, parseRubricGradeInfo, levelNameFor } from './parseQuizRubric.js';

const RUBRIC = { response_code: 200, body: {
  id: 55233026, title: 'AP CSP Free Response Question', total_points: 4, realm: 'course', realm_id: 1,
  rows: [{ id: 146012384, title: 'AP CS: Content Knowledge', description: 'General', max_points: 4, weight: 1, columns: [
    { pts: 1, description: 'Emerging:\n\nYou attempt the question.' },
    { pts: 4, description: 'Exhibiting Depth:\n\nEverything at Exhibiting, plus.' },
    { pts: 3, description: 'Exhibiting:\n\nEvery part.' },
    { pts: 2, description: 'Developing:\n\nAt least one part.' },
  ] }],
} };

describe('parseQuizRubric', () => {
  test('rows with levels highest first, the level name taken from before the first colon', () => {
    const r = parseQuizRubric(RUBRIC);
    expect([r.id, r.title, r.totalPoints]).toEqual(['55233026', 'AP CSP Free Response Question', 4]);
    expect(r.rows[0].levels.map(l => [l.points, l.name])).toEqual([
      [4, 'Exhibiting Depth'], [3, 'Exhibiting'], [2, 'Developing'], [1, 'Emerging'],
    ]);
  });
  test('null without a body.rows array', () => {
    expect(parseQuizRubric({ body: null })).toBeNull();
  });
});

describe('parseRubricGradeInfo', () => {
  test('points per row', () => {
    expect(parseRubricGradeInfo({ body: { gradeInfo: { 146012384: { grade: '2', comment: '' } }, overrideGrade: null } }))
      .toEqual({ 146012384: { points: 2, comment: '' } });
  });
  test('an empty grade is null points', () => {
    expect(parseRubricGradeInfo({ body: { gradeInfo: { 9: { grade: '', comment: '' } } } })).toEqual({ 9: { points: null, comment: '' } });
  });
  test('null on a bad payload', () => {
    expect(parseRubricGradeInfo({})).toBeNull();
  });
});

test('levelNameFor', () => {
  const r = parseQuizRubric(RUBRIC);
  expect(levelNameFor(r, '146012384', 3)).toBe('Exhibiting');
  expect(levelNameFor(r, '146012384', 7)).toBeNull();
});
