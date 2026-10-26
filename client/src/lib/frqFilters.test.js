import { describe, it, expect } from 'vitest';
import { matchesFilter } from './frqFilters.js';

const mark = (over) => ({ state: 'suggested', suggested: { cells: { 146: 4 }, comment: 's' }, final: null, suggestion_revised: false, writeback: { status: null }, changed_in_schoology: false, ...over });

describe('matchesFilter', () => {
  it('to review: unmarked with nothing in Schoology, a suggestion not yet acted on, or a revised one', () => {
    expect(matchesFilter({ schoology: null, mark: null }, 'review')).toBe(true);
    expect(matchesFilter({ schoology: { cells: {}, comment: 'x' }, mark: null }, 'review')).toBe(false);
    expect(matchesFilter({ mark: mark() }, 'review')).toBe(true);
    expect(matchesFilter({ mark: mark({ state: 'edited', suggestion_revised: true }) }, 'review')).toBe(true);
  });
});
