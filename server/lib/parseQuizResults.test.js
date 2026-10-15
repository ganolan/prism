import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseQuizResults, parseStudentStats } from './parseQuizResults.js';

const fixture = (n) => readFileSync(new URL(`./__fixtures__/quiz/${n}`, import.meta.url), 'utf8');

describe('parseQuizResults', () => {
  test('one row per assignee; attempted when the submissions cell starts with a count of 1 or more', () => {
    expect(parseQuizResults(fixture('results.html'))).toEqual([
      { uid: '701', attempted: true },
      { uid: '702', attempted: false },
      { uid: '703', attempted: true },
    ]);
  });
  test('a submissions cell other than "-" or a count is unknown (null), never "not attempted"', () => {
    const row = (cell) => `<tr class="student-row-9 odd"><td class="cell-submissions">${cell}</td></tr>`;
    expect(['-', '0/1', '1/1', '', 'In progress', 'Late'].map(c => parseQuizResults(row(c))[0].attempted))
      .toEqual([false, false, true, null, null, null]);
  });
  test('null with no student rows', () => {
    expect(parseQuizResults('<table></table>')).toBeNull();
  });
});

describe('parseStudentStats', () => {
  test('every attempt with its times and score; never the unsubmit or delete links', () => {
    const rows = parseStudentStats(fixture('student-stats.html'), { uid: '703' });
    expect(rows).toEqual([
      { attemptId: '5001', startedAt: '2026-10-09 08:51', completedAt: '2026-10-09 09:31', score: 17, maxScore: 24 },
      { attemptId: '5002', startedAt: '2026-10-10 09:00', completedAt: '2026-10-10 09:35', score: 20, maxScore: 24 },
    ]);
  });
  test('empty for a page without attempts', () => {
    expect(parseStudentStats('<table></table>', { uid: '703' })).toEqual([]);
  });
});
