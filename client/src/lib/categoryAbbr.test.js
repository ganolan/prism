import { describe, it, expect } from 'vitest';
import { categoryAbbreviations } from './categoryAbbr.js';

// #192: a reporting category's short label, from the initial of each main word.
describe('categoryAbbreviations', () => {
  it('takes the initial of each main word', () => {
    expect(categoryAbbreviations(['Producing', 'Creating, Responding, Connecting', 'Content Knowledge', 'Computational Thinking Practices']))
      .toEqual(['P', 'CRC', 'CK', 'CTP']);
  });

  it('leaves out small words such as "and" and "of"', () => {
    expect(categoryAbbreviations(['Design and Development', 'Habits of Mind'])).toEqual(['DD', 'HM']);
  });

  it('adds letters to labels that collide until they differ, first word first', () => {
    expect(categoryAbbreviations(['Content Knowledge', 'Computing Knowledge', 'Producing'])).toEqual(['ConK', 'ComK', 'P']);
    expect(categoryAbbreviations(['Planning', 'Presenting'])).toEqual(['Pl', 'Pr']);
  });

  it('keeps a number for names with the same words, and for a name with no letters', () => {
    expect(categoryAbbreviations(['Producing', 'Producing'], ['4', '5'])).toEqual(['Producing4', 'Producing5']);
    expect(categoryAbbreviations([''], ['3'])).toEqual(['3']);
  });
});
