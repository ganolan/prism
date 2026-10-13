import { describe, test, expect } from 'vitest';
import { pickFrq, compareAttempts, captureRecord, assertOutsideRepo, readRatingCell, selectedLevel, levelCellIndex } from './attemptProbe.js';

const RUBRIC = { id: '77', title: 'FRQ', rows: [{ id: '5', title: 'Content Knowledge', levels: [
  { points: 4, name: 'Exhibiting Depth' }, { points: 3, name: 'Exhibiting' }, { points: 2, name: 'Developing' }, { points: 1, name: 'Emerging' }] }] };
const q = (over) => ({ qid: '100', kind: 'mcq', points: 1, rubricScore: null, comment: '', rubric: null, ...over });
const frq = (over) => q({ qid: '200', kind: 'frq', points: 3, maxPoints: 4, rubricScore: 3, comment: 'Good', rubric: { rubricId: '77', enrollmentId: '9' }, ...over });

describe('pickFrq', () => {
  test('the marked rubric FRQ, with its level name', () => {
    expect(pickFrq({ questions: [q(), frq()] }, { 77: RUBRIC })).toEqual({ qid: '200', rubricId: '77', enrollmentId: '9', levelName: 'Exhibiting', points: 3, comment: 'Good' });
  });
  test('reasons: no FRQ with a rubric, not marked, off the rubric, several rows', () => {
    expect(pickFrq({ questions: [q()] }, {})).toEqual({ reason: 'no FRQ with a Schoology rubric' });
    expect(pickFrq({ questions: [frq({ rubricScore: null })] }, { 77: RUBRIC })).toEqual({ reason: 'FRQ not marked' });
    expect(pickFrq({ questions: [frq({ rubricScore: 2.5 })] }, { 77: RUBRIC })).toEqual({ reason: 'stored score 2.5 is not a rubric level' });
    const two = { ...RUBRIC, rows: [RUBRIC.rows[0], { ...RUBRIC.rows[0], id: '6' }] };
    expect(pickFrq({ questions: [frq()] }, { 77: two })).toEqual({ reason: 'rubric has 2 rows' });
  });
});

describe('compareAttempts', () => {
  const before = { questions: [q(), frq()] };
  test('unchanged, ignoring spacing in the comment', () => {
    expect(compareAttempts(before, { questions: [q(), frq({ comment: ' Good \n' })] })).toEqual([]);
  });
  test('every difference is named', () => {
    const after = { questions: [q({ points: 0 }), frq({ rubricScore: 4, points: 4, comment: 'Changed' })] };
    expect(compareAttempts(before, after)).toEqual([
      'question 100: points 1 -> 0',
      'question 200: points 3 -> 4',
      'question 200: rubric score 3 -> 4',
      'question 200: comment changed',
    ]);
  });
  test('a missing question or page is a difference', () => {
    expect(compareAttempts(before, null)).toEqual(['attempt page did not parse']);
    expect(compareAttempts(before, { questions: [q()] })).toEqual(['question 200: missing after the save']);
  });
});

describe('captureRecord', () => {
  test('method, url, content type, header names only, and the body', () => {
    const req = { method: () => 'POST', url: () => 'https://schoology.hkis.edu.hk/x', headers: () => ({ 'content-type': 'application/json', cookie: 'secret', 'x-csrf-token': 't' }), postData: () => '{"a":1}' };
    expect(captureRecord(req)).toEqual({ method: 'POST', url: 'https://schoology.hkis.edu.hk/x', contentType: 'application/json', headerNames: ['content-type', 'cookie', 'x-csrf-token'], body: '{"a":1}' });
  });
});

describe('assertOutsideRepo', () => {
  test('refuses unset or inside the repo, accepts outside', () => {
    expect(() => assertOutsideRepo('', '/r/prism')).toThrow(/OUT_DIR/);
    expect(() => assertOutsideRepo('/r/prism/tmp', '/r/prism')).toThrow(/outside the repo/);
    expect(() => assertOutsideRepo('/r/prism', '/r/prism')).toThrow(/outside the repo/);
    expect(() => assertOutsideRepo('/tmp/probe', '/r/prism')).not.toThrow();
    expect(() => assertOutsideRepo('/r/prism-other', '/r/prism')).not.toThrow();
  });
});

describe('rubric popup cells', () => {
  test('a cell text gives its points, level and whether it is selected', () => {
    expect(readRatingCell('This item is selected.4Exhibiting Depth: The response shows')).toEqual({ selected: true, points: 4, level: 'Exhibiting Depth' });
    expect(readRatingCell('3Exhibiting: The response demonstrates')).toEqual({ selected: false, points: 3, level: 'Exhibiting' });
    expect(readRatingCell('Not a cell')).toBeNull();
  });
  test('selectedLevel: exactly one selected cell, else null', () => {
    expect(selectedLevel(['This item is selected.4Exhibiting Depth: x', '3Exhibiting: y'])).toEqual({ selected: true, points: 4, level: 'Exhibiting Depth' });
    expect(selectedLevel(['4Exhibiting Depth: x', '3Exhibiting: y'])).toBeNull();
  });
});

describe('levelCellIndex', () => {
  const texts = ['This item is selected.4Exhibiting Depth: a', '3Exhibiting: b', '2Developing: c', '1Emerging: d'];
  test('the index of the cell with that level, matched by its whole name', () => {
    expect(levelCellIndex(texts, 'Exhibiting')).toBe(1);
    expect(levelCellIndex(texts, 'Exhibiting Depth')).toBe(0);
    expect(levelCellIndex(texts, 'Great')).toBe(-1);
  });
});
