import { describe, it, expect } from 'vitest';
import { cardInputs } from './cardInputs.js';
import { feedbackRowTopics, rowScores, rowTopicMapping } from './feedbackRows.js';

const GAS = { name: 'General Academic Scale (Unaligned)', levels: [
  { code: 'ED', label: 'Exhibiting Depth', points: 100, cutoff: 87.5 },
  { code: 'EX', label: 'Exhibiting', points: 75, cutoff: 62.5 },
  { code: 'IE', label: 'Insufficient Evidence', points: 0, cutoff: 0 },
] };
const CRITERIA = [
  { id: 11, position: 1, criterion_name: 'Features and Code', reporting_category: 'PRODUCE', descriptors: { ED: 'a', EX: 'b', IE: 'Insufficient Evidence' } },
  { id: 12, position: 2, criterion_name: 'Playtesting', reporting_category: 'CREATE', descriptors: { ED: 'e', EX: 'f', IE: 'Insufficient Evidence' } },
];
const ROWS = feedbackRowTopics(CRITERIA);

describe('cardInputs', () => {
  it('aligned task passes topics and rubric through', () => {
    const topics = [{ id: 't1', name: 'Topic 1' }];
    const rubricData = { id: 3, rubric: { criteria: CRITERIA }, topicByCriterion: { 11: 't1' } };
    const student = { id: 1, scores: { t1: { grade: 'EX' } } };
    const out = cardInputs({ topics, scoreScale: null, rubricData, student });
    expect(out.topics).toBe(topics);
    expect(out.rubric).toEqual({ criteria: CRITERIA, topicByCriterion: { 11: 't1' } });
    expect(out.student).toBe(student);
  });

  it('feedback-row task turns criteria into row topics and row_levels into scores', () => {
    const rubricData = { id: 3, rubric: { criteria: CRITERIA }, topicByCriterion: {} };
    const student = { id: 1, row_levels: { 'Features and Code': 'ED' } };
    const out = cardInputs({ topics: [], scoreScale: GAS, rubricData, student });
    expect(out.topics.map(t => t.id)).toEqual(ROWS.map(t => t.id));
    expect(out.rubric.topicByCriterion).toEqual(rowTopicMapping(ROWS));
    expect(out.student.scores).toEqual(rowScores(student.row_levels));
    expect(out.student.id).toBe(1);
  });

  it('no rubric gives rubric null', () => {
    const topics = [{ id: 't1' }];
    const student = { id: 1 };
    const out = cardInputs({ topics, scoreScale: GAS, rubricData: null, student });
    expect(out.rubric).toBeNull();
    expect(out.topics).toBe(topics);
    expect(out.student).toBe(student);
  });
});
