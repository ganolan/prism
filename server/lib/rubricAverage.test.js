import { describe, test, expect } from 'vitest';
import { rubricAverage } from './rubricAverage.js';
import shared from '../../client/src/lib/rubricAverage.cases.json';

describe('rubricAverage (server copy)', () => {
  for (const c of shared.cases) {
    test(c.name, () => {
      const names = c.levels.map((_, i) => `r${i}`);
      const levels = Object.fromEntries(c.levels.map((l, i) => [`r${i}`, l]).filter(([, l]) => l != null));
      expect(rubricAverage(shared.scale, names, levels)).toEqual(c.expect);
    });
  }
  test('no scale gives no level', () => {
    expect(rubricAverage(null, ['a'], { a: 'EX' })).toEqual({ level: null, reason: 'incomplete' });
  });
});
