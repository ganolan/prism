import { describe, it, expect } from 'vitest';
import { diffAnswers, judge, judgeCase, checkCoverage, checkWarning, EXCEPTIONS } from './parity-prismcp-http.js';

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

  it('skips an ignored key whose value differs, at any depth', () => {
    const a = { data_as_of: 'x', rows: [{ id: 1, name_source: 'p' }], stale: 1 };
    const b = { data_as_of: 'y', rows: [{ id: 1, name_source: 'q' }], stale: 1 };
    expect(diffAnswers(a, b, { ignore: ['data_as_of', 'name_source'] })).toEqual([]);
    expect(diffAnswers(a, b, { ignore: [/_source$/, 'data_as_of'] })).toEqual([]);
  });

  it('never lets an ignored key hide a key missing on one side', () => {
    expect(diffAnswers({ data_as_of: 'x', n: 1 }, { n: 1 }, { ignore: ['data_as_of'] })).toEqual(['data_as_of']);
    expect(diffAnswers({ n: 1 }, { rows: [{ data_as_of: 'x' }], n: 1 }, { ignore: ['data_as_of'] })).toEqual(['rows']);
    expect(diffAnswers({ rows: [{ id: 1 }] }, { rows: [{ id: 1, data_as_of: 'x' }] }, { ignore: ['data_as_of'] })).toEqual(['rows[0].data_as_of']);
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

describe('exceptions', () => {
  it('lists exact key names only, so scale_level_source is never excused', () => {
    expect(EXCEPTIONS.every((e) => typeof e.rule === 'string')).toBe(true);
    expect(EXCEPTIONS.map((e) => e.rule).sort()).toEqual(
      ['data_as_of', 'mastery_source', 'submission_comments_source', 'submission_files_source']);
    const r = judge({ scale_level_source: 'ai' }, { scale_level_source: 'teacher' });
    expect(r.real).toEqual(['scale_level_source']);
  });

  it('excuses the three listed source fields where they differ', () => {
    const r = judge({ mastery_source: 'a', submission_files_source: 'a', submission_comments_source: 'a' },
      { mastery_source: 'b', submission_files_source: 'b', submission_comments_source: 'b' });
    expect(r.real).toEqual([]);
    expect(r.excused).toHaveLength(3);
  });
});

const ok = { isError: false, content: [{ rows: 1 }] };
const err = { isError: true, content: ['NO_SUCH_GROUP: x'] };

describe('judgeCase', () => {
  it('passes equal successful answers', () => {
    expect(judgeCase({ expectError: false }, ok, ok).failures).toEqual([]);
  });

  it('fails a tool that answered an error on both sides when no error was expected', () => {
    const r = judgeCase({ expectError: false }, err, err);
    expect(r.real).toEqual([]);
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it('fails a side that did not answer the error that was expected', () => {
    expect(judgeCase({ expectError: true }, err, ok).failures.length).toBeGreaterThan(0);
    expect(judgeCase({ expectError: true }, ok, ok).failures.length).toBeGreaterThan(0);
  });

  it('passes the same expected error on both sides', () => {
    expect(judgeCase({ expectError: true }, err, err).failures).toEqual([]);
  });

  it('always fails a protocol-level error, even where an error was expected', () => {
    const proto = { isError: true, content: ['PROTOCOL: Invalid arguments'] };
    expect(judgeCase({ expectError: true }, proto, proto).failures.length).toBeGreaterThan(0);
  });

  it('carries the differing paths', () => {
    expect(judgeCase({ expectError: false }, ok, { isError: false, content: [{ rows: 2 }] }).real).toEqual(['content[0].rows']);
  });
});

describe('checkCoverage', () => {
  const served = ['a', 'b', 'c', 'd'];
  it('is clean when every served tool is in exactly one list and every compared tool ran', () => {
    expect(checkCoverage({ served, ran: ['a'], excluded: ['b'], writers: ['c', 'd'] })).toEqual([]);
  });
  it('fails on a served tool in none of the lists', () => {
    expect(checkCoverage({ served, ran: ['a'], excluded: ['b'], writers: ['c'] }).join(' ')).toMatch(/d/);
  });
  it('fails on a tool listed twice', () => {
    expect(checkCoverage({ served, ran: ['a', 'b'], excluded: ['b'], writers: ['c', 'd'] }).join(' ')).toMatch(/b.*more than one/);
  });
  it('fails on a listed tool the server does not serve', () => {
    expect(checkCoverage({ served, ran: ['a'], excluded: ['b'], writers: ['c', 'd', 'gone'] }).join(' ')).toMatch(/gone.*not served/);
  });
});

describe('checkWarning', () => {
  it('passes when every /mcp result led with the dev-copy warning', () => {
    expect(checkWarning({ dropped: 22, results: 22 })).toBeNull();
  });
  it('fails when any result lacked it (the target may not be a dev copy)', () => {
    expect(checkWarning({ dropped: 21, results: 22 })).toMatch(/21 of 22/);
    expect(checkWarning({ dropped: 0, results: 0 })).toMatch(/0 of 0/);
  });
});
