import { describe, it, expect } from 'vitest';
import { rosterFilterQuery, keepHeldValues, filterValueLabel, filterValueTitle } from './rosterFilters.js';

describe('rosterFilterQuery', () => {
  it('joins each chosen type, values comma-separated, empty types left out', () => {
    expect(rosterFilterQuery({ level: ['ED', 'none'], gender: ['F'], grade: [] })).toBe('gender=F&level=ED,none');
    expect(rosterFilterQuery({})).toBe('');
  });
});

describe('keepHeldValues', () => {
  it('drops values the new roster does not hold', () => {
    const facets = { gender: [{ value: 'F', count: 2 }], grade: [{ value: '9', count: 1 }], level: [] };
    expect(keepHeldValues({ gender: ['F', 'M'], level: ['ED'] }, facets)).toEqual({ gender: ['F'] });
  });
});

describe('labels', () => {
  it('names values for the pills', () => {
    expect(filterValueLabel('gender', 'F')).toBe('Female');
    expect(filterValueLabel('gender', 'X')).toBe('X');
    expect(filterValueLabel('grade', '10')).toBe('Grade 10');
    expect(filterValueLabel('level', 'EX')).toBe('EX');
    expect(filterValueTitle('level', 'EX')).toBe('Exhibiting');
    expect(filterValueLabel('level', 'none')).toBe('No levels yet');
    expect(filterValueLabel('gender', 'none')).toBe('Not known');
  });
});
