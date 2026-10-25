import { describe, it, expect } from 'vitest';
import { genderTag, genderOf, GENDER_TAGS, otherValueLabel } from './genderTag.js';

describe('genderTag (the roster shows a code, never a word)', () => {
  it('F and M, whatever the case or spacing', () => {
    expect(genderTag('F')).toEqual({ code: 'F', label: 'Female' });
    expect(genderTag(' m ')).toEqual({ code: 'M', label: 'Male' });
  });

  it('any other value PowerSchool sends is NB, and its label quotes that value exactly', () => {
    expect(genderTag('X')).toEqual({ code: 'NB', label: 'Recorded in PowerSchool as "X"' });
    expect(genderTag(' Non-binary ')).toEqual({ code: 'NB', label: 'Recorded in PowerSchool as "Non-binary"' });
  });

  it('otherValueLabel quotes each distinct value, sorted', () => {
    expect(otherValueLabel(['X', 'U', 'X'])).toBe('Recorded in PowerSchool as "U" or "X"');
    expect(otherValueLabel([])).toBe('Recorded in PowerSchool as another value');
  });

  it('a blank or missing value is ?', () => {
    for (const v of [null, undefined, '', '   ', 7]) {
      expect(genderTag(v)).toEqual({ code: '?', label: 'Not recorded in PowerSchool' });
    }
  });

  it('genderOf reads a student: the filter key F, M, NB or none (blank)', () => {
    expect(genderOf({ gender: 'F' })).toBe('F');
    expect(genderOf({ gender: 'X' })).toBe('NB');
    expect(genderOf({ gender: null })).toBe('none');
    expect(genderOf({})).toBe('none');
    expect(genderOf(undefined)).toBe('none');
  });

  it('the tags by key, in the order the roster lists them', () => {
    expect(Object.keys(GENDER_TAGS)).toEqual(['F', 'M', 'NB', 'none']);
    expect(Object.values(GENDER_TAGS).map((t) => t.code)).toEqual(['F', 'M', 'NB', '?']);
  });
});
