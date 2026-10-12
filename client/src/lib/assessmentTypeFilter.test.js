import { describe, it, expect } from 'vitest';
import { DEFAULT_TYPE_FILTER, isUnpublished, passesTypeFilter, typeFilterCounts } from './assessmentTypeFilter.js';

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
