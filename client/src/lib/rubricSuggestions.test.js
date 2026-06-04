import { describe, it, expect } from 'vitest';
import { resolveRubricScores, distributionByTopic } from './rubricSuggestions.js';

const TOPICS = [
  { id: 't1', external_id: 'X1', title: 'Ideation' },
  { id: 't2', external_id: 'X2', title: 'UI Design' },
];

describe('resolveRubricScores', () => {
  it('matches a key against external_id first', () => {
    expect(resolveRubricScores({ X1: 'ED' }, TOPICS)).toEqual({ t1: 'ED' });
  });
  it('falls back to a case-insensitive title match', () => {
    expect(resolveRubricScores({ 'ui design': 'EX' }, TOPICS)).toEqual({ t2: 'EX' });
  });
  it('ignores unresolvable keys and out-of-set values', () => {
    expect(resolveRubricScores({ NOPE: 'ED', X1: '99', X2: 'EX' }, TOPICS)).toEqual({ t2: 'EX' });
  });
  it('returns an empty object for null/empty input', () => {
    expect(resolveRubricScores(null, TOPICS)).toEqual({});
    expect(resolveRubricScores({}, TOPICS)).toEqual({});
  });
});

describe('distributionByTopic', () => {
  it('counts resolved levels per topic across rows', () => {
    const rows = [
      { feedback_parsed: { rubric_scores: { X1: 'ED', X2: 'ED' } } },
      { feedback_parsed: { rubric_scores: { X1: 'ED', X2: 'EX' } } },
    ];
    const dist = distributionByTopic(rows, TOPICS);
    expect(dist.t1).toEqual({ ED: 2, EX: 0, D: 0, EM: 0, IE: 0 });
    expect(dist.t2).toEqual({ ED: 1, EX: 1, D: 0, EM: 0, IE: 0 });
  });

  it('zero-initialises every topic for null or empty rows', () => {
    const empty = { ED: 0, EX: 0, D: 0, EM: 0, IE: 0 };
    expect(distributionByTopic(null, TOPICS)).toEqual({ t1: empty, t2: empty });
    expect(distributionByTopic([], TOPICS)).toEqual({ t1: empty, t2: empty });
  });
});
