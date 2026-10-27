import { describe, it, expect } from 'vitest';
import { categoryAbbreviations, categoryName, categoryLabels, topicNumber } from './categoryAbbr.js';

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

// #196: the same labels where a view holds topics rather than the course's categories.
describe('categoryName, categoryLabels and topicNumber', () => {
  it('drops the course prefix from a category title', () => {
    expect(categoryName('AP CS: Content Knowledge')).toBe('Content Knowledge');
    expect(categoryName('Producing')).toBe('Producing');
  });

  it('labels each distinct title once, ignoring repeats and blanks', () => {
    const labels = categoryLabels(['HS Art: Producing', null, 'HS Art: Creating, Responding, Connecting', 'HS Art: Producing', '']);
    expect([...labels.keys()]).toEqual(['HS Art: Producing', 'HS Art: Creating, Responding, Connecting']);
    expect(labels.get('HS Art: Producing')).toEqual({ abbr: 'P', name: 'Producing' });
    expect(labels.get('HS Art: Creating, Responding, Connecting')).toEqual({ abbr: 'CRC', name: 'Creating, Responding, Connecting' });
  });

  it('keeps colliding labels apart, as on the roster', () => {
    const labels = categoryLabels(['AP CS: Content Knowledge', 'AP CS: Computing Knowledge']);
    expect([...labels.values()].map((l) => l.abbr)).toEqual(['ConK', 'ComK']);
  });

  it('gives a topic number without the course prefix', () => {
    expect(topicNumber('APCS.2.3')).toBe('2.3');
    // #189: the course prefix is every leading part that is not a number.
    expect(topicNumber('HS.ART.2.3')).toBe('2.3');
    expect(topicNumber('APCS.2.3.1')).toBe('2.3.1');
    expect(topicNumber('A.B')).toBe('B');
    expect(topicNumber('X9')).toBe('X9');
    expect(topicNumber('')).toBe('');
  });
});
