import { describe, it, expect } from 'vitest';
import { buildDescriptorRows } from './rubricDescriptorRows.js';

const criteria = [
  { id: 'c2', position: 2, criterion_name: 'Func', descriptors: { ED: 'e' } },
  { id: 'c1', position: 1, criterion_name: 'UI/UX', descriptors: { ED: 'a' } },
];

describe('buildDescriptorRows', () => {
  it('orders rows by criterion position and puts unmapped topics last', () => {
    const topics = [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }, { id: 't3', title: 'Three' }];
    const rows = buildDescriptorRows(topics, {
      criteria, topicByCriterion: [{ criterion_id: 'c1', topic_id: 't2' }, { criterion_id: 'c2', topic_id: 't1' }],
    });
    expect(rows.map((r) => [r.topic.id, r.criterion?.id ?? null])).toEqual([['t2', 'c1'], ['t1', 'c2'], ['t3', null]]);
  });
});
