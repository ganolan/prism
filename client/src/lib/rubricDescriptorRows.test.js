import { describe, it, expect } from 'vitest';
import { buildDescriptorRows, feedbackDescriptorRows, feedbackRowView } from './rubricDescriptorRows.js';

describe('feedbackRowView (feedback rows, #135)', () => {
  const attachment = {
    mode: 'feedback_rows',
    rubric: { criteria: [
      { id: 'c2', position: 2, criterion_name: 'Playtesting', standard_title: 'Refine', descriptors: {} },
      { id: 'c1', position: 1, criterion_name: 'Design', standard_title: 'Plan', descriptors: {} },
    ] },
    topicByCriterion: [],
    rowLevels: { Playtesting: 'EX' },
  };

  it('makes one row per criterion, in position order, with the student\'s level per row', () => {
    const view = feedbackRowView(attachment);
    expect(view.rows.map((r) => r.criterion.criterion_name)).toEqual(['Design', 'Playtesting']);
    expect(view.gradeByTopic).toEqual({ 'row:Design': null, 'row:Playtesting': 'EX' });
  });

  it('is null for a topics rubric or no attachment', () => {
    expect(feedbackRowView({ ...attachment, mode: 'topics' })).toBeNull();
    expect(feedbackRowView(null)).toBeNull();
  });
});

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

describe('feedbackDescriptorRows', () => {
  const topics = [{ topic_id: 't1', title: 'One', grade: 'EX' }];
  const attachment = { rubric: { criteria }, topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }] };

  it('pairs the student\'s topics (keyed topic_id) with the attached criteria', () => {
    const rows = feedbackDescriptorRows(topics, attachment);
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toMatchObject({ id: 't1', grade: 'EX' });
    expect(rows[0].criterion.id).toBe('c1');
  });

  it('is null without topics, without an attachment, or when no topic is mapped', () => {
    expect(feedbackDescriptorRows([], attachment)).toBeNull();
    expect(feedbackDescriptorRows(topics, null)).toBeNull();
    expect(feedbackDescriptorRows(topics, { rubric: { criteria }, topicByCriterion: [] })).toBeNull();
  });
});
