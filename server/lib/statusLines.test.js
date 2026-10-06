import { describe, test, expect } from 'vitest';
import { lineDate, plainLine, isPlainLine, askLine, gradeStandsLine, extensionLine, makeUpLine, receivedLine, extendResubmissionLine, composeComment, teacherText } from './statusLines.js';

describe('status lines', () => {
  test('templates', () => {
    expect(lineDate('2026-10-08')).toBe('Thu 08/10');
    expect(askLine({ until: '2026-10-08', note: 'add tests' })).toBe('Resubmission requested - due Thu 08/10. add tests');
    expect(askLine({ until: '2026-10-08', note: '' })).toBe('Resubmission requested - due Thu 08/10.');
    expect(extendResubmissionLine({ until: '2026-10-13', note: null })).toBe('Resubmission requested - now due Tue 13/10.');
    expect(gradeStandsLine({ until: '2026-10-08' })).toBe('Resubmission deadline (Thu 08/10) passed - your grade stands.');
    expect(extensionLine({ until: '2026-10-09', lessons: 3, note: 'sick' })).toBe('Extension - now due Fri 09/10 (3 school days). sick');
    expect(extensionLine({ until: '2026-10-09', lessons: 1 })).toBe('Extension - now due Fri 09/10 (1 school day).');
    expect(extensionLine({ until: '2026-10-09', lessons: '1' })).toBe('Extension - now due Fri 09/10 (1 school day).');
    expect(makeUpLine({ until: '2026-10-09', note: '' })).toBe('Make-up - sit by Fri 09/10.');
    expect(receivedLine({ on: '2026-10-14' })).toBe('Resubmission received 14/10 - regraded.');
  });
  // ASCII-only since 2026-10-03 (teacher decision): nothing Prism sends to Schoology
  // carries a special character, so no encoding round-trip can alter a stored line.
  // Notes are the teacher's own text and exempt — tested here with ASCII notes.
  test('every template is plain printable ASCII', () => {
    const ascii = /^[\x20-\x7E]*$/;
    for (const until of ['2026-10-08', '2026-12-31', '2027-01-04', '2026-02-28']) {
      for (const note of ['', null, 'add tests', 'see me Tue (bring draft)']) {
        expect(askLine({ until, note })).toMatch(ascii);
        expect(extendResubmissionLine({ until, note })).toMatch(ascii);
        expect(makeUpLine({ until, note })).toMatch(ascii);
        for (const lessons of [1, 3]) expect(extensionLine({ until, lessons, note })).toMatch(ascii);
      }
      expect(gradeStandsLine({ until })).toMatch(ascii);
      expect(receivedLine({ on: until })).toMatch(ascii);
    }
  });
  test('plainLine turns typographic punctuation and odd spaces into ASCII; isPlainLine checks printable ASCII', () => {
    expect(plainLine('\u2018a\u2019 \u201Cb\u201D c\u2013d\u2014e f\u2026')).toBe('\'a\' "b" c-d-e f...');
    expect(plainLine('a\u00A0b\u202Fc\u2009d')).toBe('a b c d');
    expect(plainLine(null)).toBe('');
    expect(plainLine('caf\u00E9 \u27F3')).toBe('caf\u00E9 \u27F3');                 // not typographic: left for checkLine to refuse
    expect(isPlainLine('Make-up - sit by Fri 09/10.')).toBe(true);
    expect(isPlainLine('caf\u00E9')).toBe(false);
    expect(isPlainLine('a\tb')).toBe(false);
  });
  test('composeComment replaces only an exact stored line at the start', () => {
    expect(composeComment('Great work.', null, 'L1')).toBe('L1\n\nGreat work.');
    expect(composeComment('L1\n\nGreat work.', 'L1', 'L2')).toBe('L2\n\nGreat work.');
    expect(composeComment('L1', 'L1', 'L2')).toBe('L2');
    expect(composeComment('L1 (edited)\n\nGreat work.', 'L1', 'L2')).toBe('L2\n\nL1 (edited)\n\nGreat work.');
    expect(composeComment('', null, 'L1')).toBe('L1');
    expect(composeComment('L1\n\nGreat work.', 'L1', '')).toBe('Great work.');
  });
  test('composeComment normalises CRLF to LF before matching the stored line', () => {
    expect(composeComment('L1\r\n\r\nGreat work.', 'L1', 'L2')).toBe('L2\n\nGreat work.');
  });
  test('teacherText strips the stored line only', () => {
    expect(teacherText('L1\n\nGreat work.', 'L1')).toBe('Great work.');
    expect(teacherText('L1', 'L1')).toBe('');
    expect(teacherText('L1 edited', 'L1')).toBe('L1 edited');
    expect(teacherText('  ', null)).toBe('');
  });
});
