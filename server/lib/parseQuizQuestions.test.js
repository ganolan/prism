import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseQuizQuestions } from './parseQuizQuestions.js';

const html = readFileSync(new URL('./__fixtures__/quiz/questions.html', import.meta.url), 'utf8');

describe('parseQuizQuestions', () => {
  test('one entry per question, in delta order, with kind, number, stem and points', () => {
    const qs = parseQuizQuestions(html);
    expect(qs.map(q => [q.qid, q.delta, q.number, q.kind, q.points])).toEqual([
      ['1001', 0, 1, 'mcq', 1],
      ['1002', 1, 2, 'mcq', 1],
      ['1003', 37, 3, 'frq', 4],
    ]);
    expect(qs[2].stemHtml).toContain('<pre>');
  });
  test('null for a page with no question rows (a login page, an error)', () => {
    expect(parseQuizQuestions('<html><body>Sign in</body></html>')).toBeNull();
  });
});
