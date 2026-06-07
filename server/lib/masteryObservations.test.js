import { describe, test, expect } from 'vitest';
import { groupObservationsByTopic, normalizeObservation } from './masteryObservations.js';

describe('normalizeObservation', () => {
  test('maps the batched POST shape (gradeable_material.material.id + string points) to the GET shape', () => {
    const post = {
      objective_id: 't-aaa', student_uid: 5,
      gradeable_material: { material: { id: 7947070745, type: 'ASSIGNMENT' }, section_id: 99 },
      points: '75',
    };
    const n = normalizeObservation(post);
    expect(n.gradeable_material.material_id).toBe(7947070745);
    expect(n.points).toBe(75); // numeric, not "75"
  });

  test('leaves the per-topic GET shape unchanged (material_id already present, points numeric)', () => {
    const get = {
      objective_id: 't-aaa', student_uid: 5,
      gradeable_material: { material_id: 7947070797, material_type: 'ASSIGNMENT' },
      points: 100,
    };
    const n = normalizeObservation(get);
    expect(n.gradeable_material.material_id).toBe(7947070797);
    expect(n.points).toBe(100);
  });

  test('null points stays null; missing material → null material_id', () => {
    const n = normalizeObservation({ gradeable_material: {}, points: null });
    expect(n.points).toBeNull();
    expect(n.gradeable_material.material_id).toBeNull();
  });
});

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
