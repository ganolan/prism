import { describe, test, expect } from 'vitest';
import { groupObservationsByTopic } from './masteryObservations.js';

describe('groupObservationsByTopic', () => {
  const topicIds = ['t-aaa', 't-bbb', 't-ccc'];

  test('regroups a flat batched response by objective_id', () => {
    const obs = [
      { objective_id: 't-aaa', student_uid: 1, points: 100 },
      { objective_id: 't-bbb', student_uid: 1, points: 75 },
      { objective_id: 't-aaa', student_uid: 2, points: 50 },
    ];
    const g = groupObservationsByTopic(obs, topicIds);
    expect(g['t-aaa']).toHaveLength(2);
    expect(g['t-bbb']).toHaveLength(1);
    expect(g['t-ccc']).toEqual([]); // topic with no observations → empty array, not undefined
  });

  test('falls back through alternate objective-id field names', () => {
    const obs = [
      { objective: { id: 't-aaa' }, student_uid: 1, points: 100 },
      { objectiveId: 't-bbb', student_uid: 2, points: 75 },
    ];
    const g = groupObservationsByTopic(obs, topicIds);
    expect(g['t-aaa']).toHaveLength(1);
    expect(g['t-bbb']).toHaveLength(1);
  });

  test('coerces ids to strings and ignores rows with no objective id', () => {
    const g = groupObservationsByTopic(
      [{ objective_id: 123, points: 1 }, { points: 2 }],
      [123]
    );
    expect(g['123']).toHaveLength(1);
  });

  test('nullish observations → all topics empty', () => {
    const g = groupObservationsByTopic(null, topicIds);
    expect(g).toEqual({ 't-aaa': [], 't-bbb': [], 't-ccc': [] });
  });
});
