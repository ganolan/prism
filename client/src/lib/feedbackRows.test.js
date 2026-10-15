import { describe, it, expect } from 'vitest';
import { feedbackRowTopics, rowScores, rowTopicMapping } from './feedbackRows.js';

const criteria = [
  { id: 12, position: 2, criterion_name: 'Playtesting', reporting_category: 'CREATE' },
  { id: 11, position: 1, criterion_name: 'Features and Code', reporting_category: 'PRODUCE' },
];

describe('feedback rows as pseudo-topics', () => {
  it('orders rows by position with row: ids', () => {
    expect(feedbackRowTopics(criteria).map(t => [t.id, t.title, t.category_title])).toEqual([
      ['row:Features and Code', 'Features and Code', 'PRODUCE'], ['row:Playtesting', 'Playtesting', 'CREATE'],
    ]);
  });
  it('maps row levels to card scores and criteria to rows', () => {
    expect(rowScores({ Playtesting: 'ED' })).toEqual({ 'row:Playtesting': { grade: 'ED' } });
    expect(rowTopicMapping(feedbackRowTopics(criteria))).toEqual([
      { criterion_id: 11, topic_id: 'row:Features and Code' }, { criterion_id: 12, topic_id: 'row:Playtesting' },
    ]);
  });
});
