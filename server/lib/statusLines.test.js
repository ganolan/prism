import { describe, test, expect } from 'vitest';
import { lineDate, askLine, gradeStandsLine, extensionLine, makeUpLine, receivedLine, extendResubmissionLine, composeComment, teacherText } from './statusLines.js';

describe('status lines', () => {
  test('templates', () => {
    expect(lineDate('2026-10-08')).toBe('Thu 08/10');
    expect(askLine({ until: '2026-10-08', note: 'add tests' })).toBe('⟳ Resubmission requested — due Thu 08/10. add tests');
    expect(askLine({ until: '2026-10-08', note: '' })).toBe('⟳ Resubmission requested — due Thu 08/10.');
    expect(extendResubmissionLine({ until: '2026-10-13', note: null })).toBe('⟳ Resubmission requested — now due Tue 13/10.');
    expect(gradeStandsLine({ until: '2026-10-08' })).toBe('⟳ Resubmission deadline (Thu 08/10) passed — your grade stands.');
    expect(extensionLine({ until: '2026-10-09', lessons: 3, note: 'sick' })).toBe('⟳ Extension — now due Fri 09/10 (3 lessons). sick');
    expect(extensionLine({ until: '2026-10-09', lessons: 1 })).toBe('⟳ Extension — now due Fri 09/10 (1 lesson).');
    expect(extensionLine({ until: '2026-10-09', lessons: '1' })).toBe('⟳ Extension — now due Fri 09/10 (1 lesson).');
    expect(makeUpLine({ until: '2026-10-09', note: '' })).toBe('⟳ Make-up — sit by Fri 09/10.');
    expect(receivedLine({ on: '2026-10-14' })).toBe('⟳ Resubmission received 14/10 — regraded.');
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
