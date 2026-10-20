import { describe, it, expect } from 'vitest';
import { diffAnswers, judge } from './parity-prismcp-http.js';

describe('diffAnswers', () => {
  it('returns no paths for equal values', () => {
    expect(diffAnswers({ a: 1, b: [1, { c: 'x' }], d: null }, { d: null, b: [1, { c: 'x' }], a: 1 })).toEqual([]);
  });

  it('names the path of each differing leaf', () => {
    const a = { students: [{ name: 'A', level: 'EX' }, { name: 'B', level: 'D' }], total: 2 };
    const b = { students: [{ name: 'A', level: 'ED' }, { name: 'B', level: 'D' }], total: 3 };
    expect(diffAnswers(a, b)).toEqual(['students[0].level', 'total']);
  });

  it('reports a key present on one side only, and array length differences', () => {
    expect(diffAnswers({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
    expect(diffAnswers({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
    expect(diffAnswers({ l: [1, 2, 3] }, { l: [1, 2] })).toEqual(['l[2]']);
  });

  it('reports a type change at the value, not inside it', () => {
    expect(diffAnswers({ a: { x: 1 } }, { a: [1] })).toEqual(['a']);
    expect(diffAnswers({ a: null }, { a: { x: 1 } })).toEqual(['a']);
    expect(diffAnswers(1, '1')).toEqual(['$']);
  });

  it('treats null and a missing key as different', () => {
    expect(diffAnswers({ a: null }, {})).toEqual(['a']);
  });

  it('skips ignored keys at any depth, on either side', () => {
    const a = { data_as_of: 'x', rows: [{ id: 1, name_source: 'p' }], stale: 1 };
    const b = { data_as_of: 'y', rows: [{ id: 1, name_source: 'q' }] };
    expect(diffAnswers(a, b, { ignore: ['data_as_of', 'name_source'] })).toEqual(['stale']);
    expect(diffAnswers(a, b, { ignore: [/_source$/, 'data_as_of', 'stale'] })).toEqual([]);
  });
});

describe('judge', () => {
  it('excuses a listed key only where it really differs, and says why', () => {
    const r = judge({ data_as_of: 'x', n: 1, name_source: 'a' }, { data_as_of: 'y', n: 1, name_source: 'a' });
    expect(r.real).toEqual([]);
    expect(r.excused).toEqual(['data_as_of']);
    expect(r.reasons).toHaveLength(1);
  });

  it('never hides a difference that is not listed', () => {
    const r = judge({ data_as_of: 'x', n: 1 }, { data_as_of: 'y', n: 2 });
    expect(r.real).toEqual(['n']);
  });

  it('reports nothing for equal answers', () => {
    expect(judge({ a: 1 }, { a: 1 })).toEqual({ real: [], excused: [], reasons: [] });
  });
});
