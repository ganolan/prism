// server/lib/quizText.test.js
import { describe, test, expect } from 'vitest';
import { normalizeStem, optionLetter, parseUsDateTime, questionFingerprint, plainText, plainTextLines } from './quizText.js';

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
  test('keeps the comparison operators, so x < 5 and x > 5 differ', () => {
    expect(normalizeStem('x < 5')).not.toBe(normalizeStem('x > 5'));
    expect(normalizeStem('a ≠ b')).toBe('a≠b');
    expect(normalizeStem('a ≤ b ≥ c')).toBe('a≤b≥c');
  });
  test('keeps Unicode letters, such as CJK text', () => {
    expect(normalizeStem('<p>這是什麼?</p>')).toBe('這是什麼');
  });
  test('ignores case', () => {
    expect(normalizeStem('Which is TRUE?')).toBe(normalizeStem('which is true'));
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
  test('rejects out-of-range month, day, hour and minute', () => {
    expect(parseUsDateTime('13/45/26 8:00am')).toBeNull();
    expect(parseUsDateTime('13/09/26 8:51am')).toBeNull();
    expect(parseUsDateTime('10/09/26 13:00pm')).toBeNull();
    expect(parseUsDateTime('10/09/26 0:30am')).toBeNull();
    expect(parseUsDateTime('10/00/26 8:51am')).toBeNull();
    expect(parseUsDateTime('10/09/26 8:60am')).toBeNull();
  });
  test('accepts the range edges', () => {
    expect(parseUsDateTime('12/31/26 12:59pm')).toBe('2026-12-31 12:59');
    expect(parseUsDateTime('1/1/26 1:00am')).toBe('2026-01-01 01:00');
  });
});

test('questionFingerprint joins kind, stem key and points', () => {
  expect(questionFingerprint({ kind: 'mcq', stemHtml: '<p>Hi</p>', points: 1 })).toBe('mcq|hi|1');
});

test('plainText keeps words and decodes entities', () => {
  expect(plainText('<p>a &amp; b<br/>c</p>')).toBe('a & b c');
});

describe('plainText block handling', () => {
  test('pre content is parsed as HTML, so markup is not leaked', () => {
    expect(plainText('<pre><code>if (a &lt; b) x</code></pre>')).toBe('if (a < b) x');
  });
  test('style and script text is dropped', () => {
    expect(plainText('<style>p{color:red}</style><p>hi</p>')).toBe('hi');
    expect(plainText('<script>var a=1;</script><p>hi</p>')).toBe('hi');
  });
  test('adjacent block elements are separated by a space', () => {
    expect(plainText('<p>First</p><p>Second</p>')).toBe('First Second');
    expect(plainText('<ul><li>one</li><li>two</li></ul>')).toBe('one two');
  });
});

test('plainTextLines keeps line breaks and collapses spaces within a line', () => {
  expect(plainTextLines('<p>a)  first&nbsp;line</p><p>seconds &larr; 4<br>DISPLAY(x)</p><p></p><p></p>'))
    .toBe('a) first line\nseconds ← 4\nDISPLAY(x)');
});
