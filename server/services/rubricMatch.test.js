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
});
