import { describe, test, expect } from 'vitest';
import { hashRubricContent } from './rubricHash.js';

const crit = (over = {}) => ({
  criterion_name: 'UI/UX', standard_title: 'Visual design', reporting_category: 'Produce',
  descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' }, ...over,
});

describe('hashRubricContent', () => {
  test('is name-independent — identical criteria hash the same regardless of name/source', () => {
    expect(hashRubricContent({ name: 'Design', source: 'csv', criteria: [crit()] }))
      .toBe(hashRubricContent({ name: 'Weather Design', source: 'mcp', criteria: [crit()] }));
  });

  test('a changed descriptor changes the hash', () => {
    expect(hashRubricContent({ criteria: [crit()] }))
      .not.toBe(hashRubricContent({ criteria: [crit({ descriptors: { ED: 'CHANGED', EX: 'b', D: 'c', EM: 'd', IE: 'Insufficient Evidence' } })] }));
  });

  test('omitted IE and explicit "Insufficient Evidence" hash the same (IE defaulted)', () => {
    expect(hashRubricContent({ criteria: [crit({ descriptors: { ED: 'a', EX: 'b', D: 'c', EM: 'd' } })] }))
      .toBe(hashRubricContent({ criteria: [crit()] }));
  });

  test('null and "" collapse; extra keys (external_id, position) are ignored', () => {
    const a = hashRubricContent({ criteria: [crit({ standard_title: null })] });
    const b = hashRubricContent({ criteria: [crit({ standard_title: '', external_id: 'X1', position: 7 })] });
    expect(a).toBe(b);
  });

  test('criterion order is significant — reordering changes the hash', () => {
    const one = crit({ criterion_name: 'A' });
    const two = crit({ criterion_name: 'B' });
    expect(hashRubricContent({ criteria: [one, two] }))
      .not.toBe(hashRubricContent({ criteria: [two, one] }));
  });
});
