import { describe, test, expect } from 'vitest';
import { compareQuestionLists, matchCopies, compareLoadedQuestion, storedLetterFor } from './quizParity.js';

const q = (qid, stem, kind = 'mcq', points = 1) => ({ qid, stemHtml: stem, kind, points });
const STD = [q('1', 'Which is true?'), q('2', 'Which is true?'), q('3', 'Explain', 'frq', 4)];

describe('compareQuestionLists', () => {
  test('same questions in another order and with markup differences: ok', () => {
    const copy = [q('9', '<p>Explain</p>', 'frq', 4), q('7', 'which is TRUE?'), q('8', 'Which is true?')];
    expect(compareQuestionLists([{ assignmentId: 1, title: 'A', questions: STD }, { assignmentId: 2, title: 'A *', questions: copy }]))
      .toEqual({ ok: true, differences: [] });
  });
  test('a changed question is listed as missing and extra', () => {
    const copy = [q('7', 'Which is true?'), q('8', 'Which is false?'), q('9', 'Explain', 'frq', 4)];
    const r = compareQuestionLists([{ assignmentId: 1, title: 'A', questions: STD }, { assignmentId: 2, title: 'A *', questions: copy }]);
    expect(r.ok).toBe(false);
    expect(r.differences).toEqual([{ assignmentId: 2, title: 'A *', missing: ['Which is true?'], extra: ['Which is false?'] }]);
  });
  test('different points are a difference', () => {
    const copy = [q('7', 'Which is true?'), q('8', 'Which is true?'), q('9', 'Explain', 'frq', 6)];
    expect(compareQuestionLists([{ assignmentId: 1, title: 'A', questions: STD }, { assignmentId: 2, title: 'B', questions: copy }]).ok).toBe(false);
  });
  test('a single list is ok', () => {
    expect(compareQuestionLists([{ assignmentId: 1, title: 'A', questions: STD }]).ok).toBe(true);
  });
});

describe('matchCopies', () => {
  test('duplicate stems pair by occurrence order', () => {
    const copy = [q('9', 'Explain', 'frq', 4), q('7', 'Which is true?'), q('8', 'Which is true?')];
    expect([...matchCopies(STD, copy)]).toEqual([['9', '3'], ['7', '1'], ['8', '2']]);
  });
  test('throws PARITY when the sets differ', () => {
    expect(() => matchCopies(STD, [q('7', 'Other')])).toThrow(expect.objectContaining({ code: 'PARITY' }));
  });
});

describe('compareLoadedQuestion', () => {
  const opts = (key) => ['A', 'B'].map(l => ({ letter: l, html: `opt ${l}`, isKey: l === key }));
  test('same options and key: null', () => {
    expect(compareLoadedQuestion({ options: opts('A') }, { options: opts('A') })).toBeNull();
  });
  test('a different key is reported', () => {
    expect(compareLoadedQuestion({ options: opts('A') }, { options: opts('B') })).toMatch(/key/);
  });
  test('a different rubric is reported', () => {
    expect(compareLoadedQuestion({ options: null, rubricId: '1' }, { options: null, rubricId: '2' })).toMatch(/rubric/);
  });
  test('the same options in another order are not a mismatch', () => {
    const a = [{ letter: 'A', html: 'x', isKey: false }, { letter: 'B', html: 'y', isKey: true }, { letter: 'C', html: 'z', isKey: false }];
    const b = [{ letter: 'A', html: 'z', isKey: false }, { letter: 'B', html: 'x', isKey: false }, { letter: 'C', html: 'y', isKey: true }];
    expect(compareLoadedQuestion({ options: a }, { options: b })).toBeNull();
  });
  test('a key on a different option text is still a different key', () => {
    const a = [{ letter: 'A', html: 'x', isKey: true }, { letter: 'B', html: 'y', isKey: false }];
    const b = [{ letter: 'A', html: 'y', isKey: true }, { letter: 'B', html: 'x', isKey: false }];
    expect(compareLoadedQuestion({ options: a }, { options: b })).toMatch(/key/);
  });
});

describe('storedLetterFor', () => {
  const stored = [{ letter: 'A', html: '<p>x</p>' }, { letter: 'B', html: 'y' }, { letter: 'C', html: 'z' }];
  const loaded = [{ letter: 'A', html: 'z' }, { letter: 'B', html: 'x' }, { letter: 'C', html: 'y' }];
  test('maps a chosen letter to the stored letter with the same text', () => {
    expect(storedLetterFor(stored, loaded, 'A')).toBe('C');
    expect(storedLetterFor(stored, loaded, 'B')).toBe('A');
  });
  test('null for no answer or an unknown letter', () => {
    expect(storedLetterFor(stored, loaded, null)).toBeNull();
    expect(storedLetterFor(stored, loaded, 'E')).toBeNull();
  });
});
