import { describe, it, expect } from 'vitest';
import { DEFAULT_TYPE_FILTER, isUnpublished, parseStoredTypeFilter, passesTypeFilter, typeFilterCounts } from './assessmentTypeFilter.js';

const S = { aligned: 1, published: 1 };
const F = { aligned: 0, published: 1 };
const US = { aligned: 1, published: 0 };
const UF = { aligned: 0, published: 0 };

describe('assessmentTypeFilter', () => {
  it('treats a missing published flag as published', () => {
    expect(isUnpublished({ aligned: 1 })).toBe(false);
    expect(isUnpublished({ published: '0' })).toBe(true);
  });

  it('hides unpublished assignments by default', () => {
    expect([S, F, US, UF].filter(a => passesTypeFilter(a))).toEqual([S, F]);
  });

  it('shows unpublished assignments of the selected types when turned on', () => {
    const f = { summative: true, formative: false, unpublished: true };
    expect([S, F, US, UF].filter(a => passesTypeFilter(a, f))).toEqual([S, US]);
  });

  it('counts types within the Unpublished setting and all unpublished', () => {
    expect(typeFilterCounts([S, F, US, UF], DEFAULT_TYPE_FILTER)).toEqual({ summative: 1, formative: 1, unpublished: 2 });
    expect(typeFilterCounts([S, F, US, UF], { ...DEFAULT_TYPE_FILTER, unpublished: true })).toEqual({ summative: 2, formative: 2, unpublished: 2 });
  });
});

describe('parseStoredTypeFilter', () => {
  it('reads back a stored filter', () => {
    const stored = JSON.stringify({ summative: false, formative: true, unpublished: true });
    expect(parseStoredTypeFilter(stored)).toEqual({ summative: false, formative: true, unpublished: true });
  });

  it('fills keys missing from an older stored value from the default', () => {
    expect(parseStoredTypeFilter(JSON.stringify({ summative: false })))
      .toEqual({ ...DEFAULT_TYPE_FILTER, summative: false });
  });

  it.each([
    ['nothing stored', null],
    ['broken JSON', '{summative:'],
    ['a non-object', '"formative"'],
    ['an array', '[true,false]'],
    ['JSON null', 'null'],
    ['an unknown key', JSON.stringify({ summative: true, formative: true, unpublished: false, quizzes: true })],
    ['a non-boolean value', JSON.stringify({ summative: 'yes', formative: true, unpublished: false })],
  ])('falls back to the default for %s', (_label, raw) => {
    expect(parseStoredTypeFilter(raw)).toEqual(DEFAULT_TYPE_FILTER);
  });
});
