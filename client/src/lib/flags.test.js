import { describe, it, expect } from 'vitest';
import { FLAGS, FLAG_ORDER, FLAGS_MENU_HEADING, flagGuide, isFlag } from './flags.js';

describe('Schoology flags (#40, probed 21 October 2026)', () => {
  it('codes 1 Exempt, 2 Incomplete, 3 Missing, 5 Absent, 6 Late; 4 is not a flag', () => {
    expect(FLAGS).toEqual({
      1: { key: 'exempt', name: 'Exempt', verb: 'exempt' },
      2: { key: 'incomplete', name: 'Incomplete', verb: 'incomplete' },
      3: { key: 'missing', name: 'Missing', verb: 'missing' },
      5: { key: 'absent', name: 'Absent', verb: 'absent' },
      6: { key: 'late', name: 'Late', verb: 'late' },
    });
    expect(FLAG_ORDER).toEqual([1, 6, 5, 2, 3]);
  });

  it('isFlag is true for the five codes (numbers or numeric strings) only', () => {
    for (const c of [1, 2, 3, 5, 6, '6']) expect(isFlag(c)).toBe(true);
    for (const c of [0, 4, 7, null, undefined, '', 'x']) expect(isFlag(c)).toBe(false);
  });

  it('the menu heading', () => {
    expect(FLAGS_MENU_HEADING).toBe('Flag in Schoology');
  });

  it('flagGuide gives the menu lines verbatim, with the first name', () => {
    expect(flagGuide(1, 'Sam')).toBe("Left out of Sam's grade.");
    expect(flagGuide(6, 'Sam')).toBe("Left out of Sam's grade while flagged.");
    expect(flagGuide(5, 'Sam')).toBe("Absent for this task. Left out of Sam's grade.");
    expect(flagGuide(2, 'Sam')).toBe('No grade while flagged.');
    expect(flagGuide(3, 'Sam')).toBe("Counts as zero in Sam's grade.");
  });

  it('flagGuide says "the student" with no name, and nothing for a non-flag', () => {
    expect(flagGuide(1)).toBe("Left out of the student's grade.");
    expect(flagGuide(4, 'Sam')).toBe('');
  });

  it('no guide line has an em dash (UI copy rule)', () => {
    for (const c of FLAG_ORDER) expect(flagGuide(c, 'Sam')).not.toMatch(/—/);
  });
});
