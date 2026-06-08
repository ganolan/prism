import { describe, test, expect } from 'vitest';
import { normalizeTitle, autoMatch } from './rubricMatch.js';

const TOPICS = [
  { id: 't1', external_id: 'ART.5.1', title: 'Select, analyze, and interpret artistic work for presentation' },
  { id: 't2', external_id: 'ART.5.2', title: 'Develop and refine artistic techniques and work for presentation' },
];

describe('rubricMatch', () => {
  test('normalizeTitle strips the "Anchor Standard N:" prefix and punctuation', () => {
    expect(normalizeTitle('Anchor Standard 4: Select, analyze, and interpret artistic work for presentation'))
      .toBe(normalizeTitle('Select analyze and interpret artistic work for presentation'));
  });

  test('autoMatch binds by normalized title', () => {
    const criteria = [
      { id: 'c1', standard_title: 'Anchor Standard 4: Select, analyze, and interpret artistic work for presentation' },
      { id: 'c2', standard_title: 'Develop and refine artistic techniques and work for presentation' },
    ];
    const { mapping, unmatched } = autoMatch(criteria, TOPICS);
    expect(mapping).toEqual([
      { criterion_id: 'c1', topic_id: 't1' },
      { criterion_id: 'c2', topic_id: 't2' },
    ]);
    expect(unmatched).toEqual([]);
  });

  test('External ID exact match wins and a non-match is reported unmatched', () => {
    const criteria = [
      { id: 'c1', external_id: 'ART.5.2', standard_title: 'whatever' },
      { id: 'c2', standard_title: 'No such topic here' },
    ];
    const { mapping, unmatched } = autoMatch(criteria, TOPICS);
    expect(mapping).toContainEqual({ criterion_id: 'c1', topic_id: 't2' });
    expect(unmatched).toEqual(['c2']);
  });

  test('external_id set but unresolved falls through to title match', () => {
    const criteria = [
      { id: 'c1', external_id: 'NOPE.9.9',
        standard_title: 'Develop and refine artistic techniques and work for presentation' },
    ];
    const { mapping, unmatched } = autoMatch(criteria, TOPICS);
    expect(mapping).toEqual([{ criterion_id: 'c1', topic_id: 't2' }]);
    expect(unmatched).toEqual([]);
  });

  test('normalizeTitle strips a bare "Standard N:" prefix to the plain title', () => {
    expect(normalizeTitle('Standard 2: Develop and refine artistic techniques'))
      .toBe('develop and refine artistic techniques');
  });

  test('normalizeTitle strips a framework code prefix like "VA:Cr1.1"', () => {
    expect(normalizeTitle('VA:Cr1.1 Generate and conceptualize artistic ideas'))
      .toBe(normalizeTitle('Generate and conceptualize artistic ideas'));
  });

  test('normalizeTitle strips leading list numbering "1." and "1)"', () => {
    const target = normalizeTitle('Select, analyze, and interpret artistic work for presentation');
    expect(normalizeTitle('1. Select, analyze, and interpret artistic work for presentation')).toBe(target);
    expect(normalizeTitle('1) Select, analyze, and interpret artistic work for presentation')).toBe(target);
  });

  test('normalizeTitle does not strip a plain "Word: phrase" with no code digit', () => {
    // "Critique:" is not a framework code — must survive (only its punctuation collapses)
    expect(normalizeTitle('Critique: respond to art')).toBe('critique respond to art');
  });

  test('normalizeTitle does not strip a lowercase "word:digit" prose prefix', () => {
    expect(normalizeTitle('Note:2 things to improve')).toBe('note 2 things to improve');
  });

  test('normalizeTitle strips list numbering with an en-dash separator', () => {
    expect(normalizeTitle('1 – Select, analyze, and interpret artistic work'))
      .toBe(normalizeTitle('Select, analyze, and interpret artistic work'));
  });
});
