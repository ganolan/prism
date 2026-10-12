// server/lib/quizText.test.js
import { describe, test, expect } from 'vitest';
import { normalizeStem, optionLetter, parseUsDateTime, questionFingerprint, plainText } from './quizText.js';

describe('normalizeStem', () => {
  test('ignores tags, entities, case, spacing and the arrow', () => {
    const a = '<p>Set <code>count &larr; 3</code><br />then&nbsp;DISPLAY</p>';
    const b = 'set count ← 3 then display';
    expect(normalizeStem(a)).toBe(normalizeStem(b));
    expect(normalizeStem(a)).toBe('setcount3thendisplay');
  });
  test('a different word gives a different key', () => {
    expect(normalizeStem('<p>Which is true?</p>')).not.toBe(normalizeStem('<p>Which is false?</p>'));
  });
  test('empty input gives an empty key', () => {
    expect(normalizeStem(null)).toBe('');
  });
});

test('optionLetter', () => {
  expect([0, 1, 2, 3, 4].map(optionLetter)).toEqual(['A', 'B', 'C', 'D', 'E']);
});

describe('parseUsDateTime', () => {
  test('Schoology M/DD/YY h:mmam', () => {
    expect(parseUsDateTime('10/09/26 8:51am')).toBe('2026-10-09 08:51');
    expect(parseUsDateTime(' 9/8/26 2:13pm ')).toBe('2026-09-08 14:13');
    expect(parseUsDateTime('12/1/26 12:05am')).toBe('2026-12-01 00:05');
    expect(parseUsDateTime('12/1/26 12:05pm')).toBe('2026-12-01 12:05');
  });
  test('anything else is null', () => {
    expect(parseUsDateTime('-')).toBeNull();
    expect(parseUsDateTime('')).toBeNull();
  });
});

test('questionFingerprint joins kind, stem key and points', () => {
  expect(questionFingerprint({ kind: 'mcq', stemHtml: '<p>Hi</p>', points: 1 })).toBe('mcq|hi|1');
});

test('plainText keeps words and decodes entities', () => {
  expect(plainText('<p>a &amp; b<br/>c</p>')).toBe('a & b c');
});
