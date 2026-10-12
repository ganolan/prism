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

// Rubric launch buttons. The settings blob is real JSON: the grade HTML inside
// each args array is written with \uXXXX escapes, as on the live page.
const essayBlock = (qid) => `<div class="question-review question-essay"><div class="grade-score">
  <input type="text" name="components[0][${qid}][points]" value="1" />
  <input type="hidden" name="components[0][${qid}][max_points]" value="4" />
  <input type="hidden" name="components[0][${qid}][rubric_score]" value="" />
</div><div class="question-view"><div class="essay-review"><p>An answer.</p></div></div></div>`;
const attemptPage = (qids, settings) => `<html><body><form id="s-assessment-edit-submission-form">${qids.map(essayBlock).join('')}</form><script>jQuery.extend(Drupal.settings, ${settings});</script></body></html>`;

describe('rubric launch buttons', () => {
  test('each question gets its own button ids; an unrelated theme_js entry is ignored', () => {
    const settings = String.raw`{"basePath":"\/","theme_js":{"a":{"template":"s_grades_rubric_grading_launch_btn","module":"gradingRubric","args":["111","222","2001","\u003Cspan class=\u0022grade-val\u0022\u003E1\u003C\/span\u003E",1,1,"5001",3,false,false]},"b":{"template":"other","module":"x","args":["999","888","2001","x",1]},"c":{"template":"s_grades_rubric_grading_launch_btn","module":"gradingRubric","args":["333","444","2002","\u003Cspan class=\u0022grade-val\u0022\u003E2\u003C\/span\u003E",1,1,"5002",4,false,false]}}}`;
    expect(() => JSON.parse(settings)).not.toThrow();
    const { questions } = parseQuizAttempt(attemptPage(['2001', '2002'], settings));
    expect(questions.map(q => [q.qid, q.rubric])).toEqual([
      ['2001', { rubricId: '111', enrollmentId: '222' }],
      ['2002', { rubricId: '333', enrollmentId: '444' }],
    ]);
  });

  test('a launch entry without args does not take the args of the next entry', () => {
    const settings = String.raw`{"theme_js":{"a":{"template":"s_grades_rubric_grading_launch_btn","module":"gradingRubric"},"b":{"template":"other","module":"x","args":["999","888","2001","x",1]}}}`;
    const { questions } = parseQuizAttempt(attemptPage(['2001'], settings));
    expect(questions[0].rubric).toBeNull();
  });
});
