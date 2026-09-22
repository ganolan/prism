import { describe, test, expect } from 'vitest';
import { NAME_FORMATS, SEPARATORS, SAMPLE_STUDENT, formatName, formatClassList } from './nameFormats.js';

// Alex has a teacher override, a Schoology preferred name, and a different legal
// first name — so each format can be checked against the right source.
const alex = {
  id: 1, first_name: 'Alexander', last_name: 'Chen',
  preferred_name: 'Al', preferred_name_teacher: 'Alex',
};
const bao = { id: 2, first_name: 'Bao', last_name: 'Nguyen' };

describe('formatName', () => {
  test('first-last uses the preferred first name', () => {
    expect(formatName(alex, 'first-last')).toBe('Alex Chen');
  });

  test('last-first puts the surname first, comma separated', () => {
    expect(formatName(alex, 'last-first')).toBe('Chen, Alex');
  });

  test('first-initial abbreviates the surname to an initial with a full stop', () => {
    expect(formatName(alex, 'first-initial')).toBe('Alex C.');
  });

  test('first-only drops the surname', () => {
    expect(formatName(alex, 'first-only')).toBe('Alex');
  });

  test('last-only drops the given name', () => {
    expect(formatName(alex, 'last-only')).toBe('Chen');
  });

  test('legal-last uses the legal first name, ignoring both preferred names', () => {
    expect(formatName(alex, 'legal-last')).toBe('Alexander Chen');
  });

  test('falls back to the legal first name when no preferred name is set', () => {
    expect(formatName(bao, 'first-last')).toBe('Bao Nguyen');
  });

  test('omits the surname gracefully when a student has none', () => {
    const noSurname = { id: 3, first_name: 'Prince' };
    expect(formatName(noSurname, 'first-last')).toBe('Prince');
    expect(formatName(noSurname, 'last-first')).toBe('Prince');
    expect(formatName(noSurname, 'first-initial')).toBe('Prince');
  });

  test('an unknown format id falls back to first-last', () => {
    expect(formatName(alex, 'nonsense')).toBe('Alex Chen');
  });
});

describe('formatClassList', () => {
  const roster = [alex, bao];

  test('defaults to one name per line, sorted by surname', () => {
    expect(formatClassList(roster, {})).toBe('Alex Chen\nBao Nguyen');
  });

  test('comma separator joins names on a single line', () => {
    expect(formatClassList(roster, { separator: 'comma' }))
      .toBe('Alex Chen, Bao Nguyen');
  });

  test('sorting by first name reorders the roster', () => {
    const roster2 = [{ id: 4, first_name: 'Zoe', last_name: 'Adams' }, alex];
    expect(formatClassList(roster2, { sort: 'first' })).toBe('Alex Chen\nZoe Adams');
    expect(formatClassList(roster2, { sort: 'last' })).toBe('Zoe Adams\nAlex Chen');
  });

  test('sorting is case-insensitive', () => {
    const roster2 = [{ id: 5, first_name: 'ana', last_name: 'zeta' }, { id: 6, first_name: 'Bo', last_name: 'Alpha' }];
    expect(formatClassList(roster2, { sort: 'first' })).toBe('ana zeta\nBo Alpha');
  });

  test('sorting by surname falls back to the given name to break ties', () => {
    const smiths = [
      { id: 7, first_name: 'Zoe', last_name: 'Smith' },
      { id: 8, first_name: 'Amy', last_name: 'Smith' },
    ];
    expect(formatClassList(smiths, {})).toBe('Amy Smith\nZoe Smith');
  });

  test('applies the chosen format to every name', () => {
    expect(formatClassList(roster, { format: 'last-first', separator: 'comma' }))
      .toBe('Chen, Alex, Nguyen, Bao');
  });

  test('an empty roster produces an empty string', () => {
    expect(formatClassList([], {})).toBe('');
  });

  test('does not mutate the roster it is given', () => {
    const roster2 = [bao, alex];
    formatClassList(roster2, { sort: 'last' });
    expect(roster2[0]).toBe(bao);
  });
});

describe('option lists', () => {
  test('NAME_FORMATS covers every supported format with a label', () => {
    expect(NAME_FORMATS.map(f => f.id)).toEqual([
      'first-last', 'last-first', 'first-initial', 'first-only', 'last-only', 'legal-last',
    ]);
    for (const f of NAME_FORMATS) expect(f.label).toBeTruthy();
  });

  test('the sample student exercises every format distinctly', () => {
    // Distinct legal / Schoology-preferred / teacher-override names, so the
    // preview a teacher sees actually distinguishes the formats from each other.
    expect(NAME_FORMATS.map(f => formatName(SAMPLE_STUDENT, f.id))).toEqual([
      'Alex Chen', 'Chen, Alex', 'Alex C.', 'Alex', 'Chen', 'Alexander Chen',
    ]);
  });

  test('SEPARATORS offers newline first so it reads as the default', () => {
    expect(SEPARATORS.map(s => s.id)).toEqual(['newline', 'comma']);
  });
});
