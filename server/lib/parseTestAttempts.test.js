import { describe, test, expect } from 'vitest';
import { parseTestAttempts } from './parseTestAttempts.js';

// Cell shapes observed live (2026-10-02 spike, .claude/schoology-api-reference.md
// "Tests and quizzes > Did the student take the test?").
const PAYLOAD = {
  response_code: 200,
  body: {
    grades: {
      701: {
        8556117685: { uid: '701', grade_item_nid: '8556117685', grade: 100, exception: 0, submission: 'assessment', has_assessment: true },
        8556133426: { uid: '701', grade_item_nid: '8556133426', not_assigned: true },
      },
      702: {
        8556117685: { uid: '702', grade_item_nid: '8556117685', has_assessment: true },
      },
    },
  },
};

describe('parseTestAttempts', () => {
  test('took = submission "assessment"; notAssigned from not_assigned; ids as strings', () => {
    const m = parseTestAttempts(PAYLOAD);
    expect([...m.keys()]).toEqual(['701', '702']);
    expect(m.get('701').get('8556117685')).toEqual({ took: true, notAssigned: false });
    expect(m.get('701').get('8556133426')).toEqual({ took: false, notAssigned: true });
    expect(m.get('702').get('8556117685')).toEqual({ took: false, notAssigned: false }); // assigned, no attempt
  });

  test('a grade-only cell (e.g. the "Result (S)" companion) is not an attempt', () => {
    const m = parseTestAttempts({ body: { grades: { 701: { 9: { uid: '701', grade_item_nid: '9', grade: 80 } } } } });
    expect(m.get('701').get('9')).toEqual({ took: false, notAssigned: false });
  });

  test('anything without a grades object is a failed read (null), never "nobody took it"', () => {
    for (const bad of [null, undefined, {}, { body: [] }, { body: {} }, { body: { grades: [] } }, { body: { grades: 'x' } }]) {
      expect(parseTestAttempts(bad)).toBeNull();
    }
  });

  test('skips malformed per-student entries', () => {
    const m = parseTestAttempts({ body: { grades: { 701: null, 702: [], 703: { 5: null, 6: { submission: 'assessment' } } } } });
    expect([...m.keys()]).toEqual(['703']);
    expect([...m.get('703').entries()]).toEqual([['6', { took: true, notAssigned: false }]]);
  });
});
