import { describe, it, expect } from 'vitest';
import { FLAGS, FLAG_ORDER, FLAGS_MENU_HEADING, FINAL_FLAGS, flagGuide, isFlag, isExempt, isFinalFlag, isMarker, flagEffect } from './flags.js';

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

  it('isExempt: Exempt (1) only; Absent (5) is a marker, not a decision (the server mirror agrees)', () => {
    for (const c of [1, '1']) expect(isExempt(c)).toBe(true);
    for (const c of [0, 2, 3, 4, 5, '5', 6, null, undefined, '']) expect(isExempt(c)).toBe(false);
  });

  it('flagEffect says what Schoology does to the grade: Missing counts it as zero, the rest remove it', () => {
    expect(flagEffect(3)).toBe('Schoology counts this as zero while it is flagged.');
    for (const c of [1, 2, 5, 6]) expect(flagEffect(c)).toBe('Schoology removes the grade while it is flagged.');
    expect(flagEffect(4)).toBe('');
  });

  it('final flags (Exempt, Missing) and markers (Incomplete, Absent, Late), as the server has them', () => {
    expect(FINAL_FLAGS).toEqual([1, 3]);
    for (const c of [1, 3, '3']) expect(isFinalFlag(c)).toBe(true);
    for (const c of [0, 2, 4, 5, 6, null, undefined, '']) expect(isFinalFlag(c)).toBe(false);
    for (const c of [2, 5, 6, '6']) expect(isMarker(c)).toBe(true);
    for (const c of [0, 1, 3, 4, null, undefined, '']) expect(isMarker(c)).toBe(false);
  });

  it('the menu heading', () => {
    expect(FLAGS_MENU_HEADING).toBe('Flag in Schoology');
  });

  it('flagGuide gives the menu lines verbatim, with the first name', () => {
    expect(flagGuide(1, 'Sam')).toBe("Left out of Sam's grade.");
    expect(flagGuide(6, 'Sam')).toBe("Left out of Sam's grade while flagged.");
    expect(flagGuide(5, 'Sam')).toBe("Absent for this task. Left out of Sam's grade.");
    expect(flagGuide(2, 'Sam')).toBe('No grade while flagged.');
    // Missing keeps the topic levels already entered and they still count (probe, 22 Oct 2026).
    expect(flagGuide(3, 'Sam', { aligned: true })).toBe('Scores this task as zero. Topic levels already entered still count.');
    expect(flagGuide(3, 'Sam', { aligned: false })).toBe('Scores this task as zero.');
    expect(flagGuide(3, 'Sam')).toBe('Scores this task as zero.'); // topics unknown: the line that is always true
  });

  it('flagGuide says "the student" with no name, and nothing for a non-flag', () => {
    expect(flagGuide(1)).toBe("Left out of the student's grade.");
    expect(flagGuide(4, 'Sam')).toBe('');
  });

  it('no guide line has an em dash (UI copy rule)', () => {
    for (const c of FLAG_ORDER) expect(flagGuide(c, 'Sam')).not.toMatch(/—/);
  });
});
