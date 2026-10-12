import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseQuizAttempt } from './parseQuizAttempt.js';

const html = readFileSync(new URL('./__fixtures__/quiz/attempt.html', import.meta.url), 'utf8');

describe('parseQuizAttempt', () => {
  const { questions } = parseQuizAttempt(html);

  test('one entry per question in page order', () => {
    expect(questions.map(q => [q.qid, q.kind])).toEqual([['1001', 'mcq'], ['1002', 'mcq'], ['1003', 'frq']]);
  });

  test('MCQ: options by position, the chosen letter, the key and correctness', () => {
    expect(questions[0]).toMatchObject({ chosenLetter: 'B', isCorrect: true, points: 1, maxPoints: 1 });
    expect(questions[0].options.map(o => [o.letter, o.selected, o.isKey])).toEqual([
      ['A', false, false], ['B', true, true], ['C', false, false], ['D', false, false],
    ]);
    expect(questions[1]).toMatchObject({ chosenLetter: 'D', isCorrect: false });
    expect(questions[1].options.find(o => o.isKey).letter).toBe('A');
    expect(questions[0].options[1].html).toContain('HTTP');
  });

  test('FRQ: full answer HTML, points, rubric score, comment and the rubric button ids', () => {
    expect(questions[2]).toMatchObject({
      kind: 'frq', points: 2, maxPoints: 4, rubricScore: 2, comment: 'Good start on part (a).',
      rubric: { rubricId: '55233026', enrollmentId: '3561143308' }, options: null, chosenLetter: null, isCorrect: null,
    });
    expect(questions[2].answerHtml).toContain('&lt;- with an arrow');
    expect(questions[2].answerHtml).toContain('Second part');
  });

  test('null for a page without the attempt form', () => {
    expect(parseQuizAttempt('<html>Sign in</html>')).toBeNull();
  });

  test('an MCQ with nothing selected has a null chosen letter and is not correct', () => {
    const blank = html.replace(' selected correct', ' correct');
    expect(parseQuizAttempt(blank).questions[0]).toMatchObject({ chosenLetter: null, isCorrect: false });
  });
});
