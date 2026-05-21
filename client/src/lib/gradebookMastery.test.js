import { describe, test, expect } from 'vitest';
import { indexMastery, buildAssignmentRubric } from './gradebookMastery.js';

// A course-mastery payload shaped like GET /api/mastery/:courseId returns.
const mastery = {
  categories: [
    { id: 'cat-1', external_id: 'RC.1', title: 'Creating' },
    { id: 'cat-2', external_id: 'RC.2', title: 'Responding' },
  ],
  topics: [
    { id: 't1', category_id: 'cat-1', external_id: 'RC.1.1', title: 'Generates media' },
    { id: 't2', category_id: 'cat-1', external_id: 'RC.1.2', title: 'Refines work' },
    { id: 't3', category_id: 'cat-2', external_id: 'RC.2.1', title: 'Evaluates ethics' },
  ],
  alignments: [
    { assignment_schoology_id: 'sa-1', topic_id: 't2', topic_title: 'Refines work',
      topic_external_id: 'RC.1.2', category_id: 'cat-1', category_title: 'Creating',
      category_external_id: 'RC.1' },
    { assignment_schoology_id: 'sa-1', topic_id: 't1', topic_title: 'Generates media',
      topic_external_id: 'RC.1.1', category_id: 'cat-1', category_title: 'Creating',
      category_external_id: 'RC.1' },
    { assignment_schoology_id: 'sa-1', topic_id: 't3', topic_title: 'Evaluates ethics',
      topic_external_id: 'RC.2.1', category_id: 'cat-2', category_title: 'Responding',
      category_external_id: 'RC.2' },
  ],
  scores: [
    { student_uid: 'uid-1', assignment_schoology_id: 'sa-1', topic_id: 't1', points: 100, grade: 'ED' },
    { student_uid: 'uid-1', assignment_schoology_id: 'sa-1', topic_id: 't2', points: 75, grade: 'EX' },
    // uid-1 has no score on t3 for sa-1.
  ],
};

describe('indexMastery', () => {
  test('topicsByAssignment lists aligned topics ordered by category then topic external_id', () => {
    const idx = indexMastery(mastery);
    expect(idx.topicsByAssignment['sa-1']).toEqual(['t1', 't2', 't3']);
  });

  test('topicMeta carries title, external_id and category_title per topic', () => {
    const idx = indexMastery(mastery);
    expect(idx.topicMeta['t3']).toMatchObject({
      title: 'Evaluates ethics', external_id: 'RC.2.1', category_title: 'Responding',
    });
  });

  test('gradeLookup maps student → assignment → topic → grade', () => {
    const idx = indexMastery(mastery);
    expect(idx.gradeLookup['uid-1']['sa-1']['t1']).toBe('ED');
    expect(idx.gradeLookup['uid-1']['sa-1']['t2']).toBe('EX');
  });

  test('falls back to score-derived topics when an assignment has no alignment rows', () => {
    const noAlign = {
      ...mastery,
      alignments: [],
      scores: [
        { student_uid: 'uid-1', assignment_schoology_id: 'sa-9', topic_id: 't3', points: 50, grade: 'D' },
        { student_uid: 'uid-1', assignment_schoology_id: 'sa-9', topic_id: 't1', points: 100, grade: 'ED' },
      ],
    };
    const idx = indexMastery(noAlign);
    expect(idx.topicsByAssignment['sa-9']).toEqual(['t1', 't3']);
  });

  test('handles a null mastery payload without throwing', () => {
    const idx = indexMastery(null);
    expect(idx.topicsByAssignment).toEqual({});
    expect(idx.gradeLookup).toEqual({});
  });
});

describe('buildAssignmentRubric', () => {
  test('returns ordered topics with the student grade, null where ungraded', () => {
    const idx = indexMastery(mastery);
    const rubric = buildAssignmentRubric('sa-1', 'uid-1', idx);
    expect(rubric).toEqual([
      { topic_id: 't1', title: 'Generates media', external_id: 'RC.1.1', category_title: 'Creating', grade: 'ED' },
      { topic_id: 't2', title: 'Refines work',    external_id: 'RC.1.2', category_title: 'Creating', grade: 'EX' },
      { topic_id: 't3', title: 'Evaluates ethics', external_id: 'RC.2.1', category_title: 'Responding', grade: null },
    ]);
  });

  test('a student with no scores gets all-null grades but the full topic list', () => {
    const idx = indexMastery(mastery);
    const rubric = buildAssignmentRubric('sa-1', 'uid-unknown', idx);
    expect(rubric.map(t => t.topic_id)).toEqual(['t1', 't2', 't3']);
    expect(rubric.every(t => t.grade === null)).toBe(true);
  });

  test('an unknown assignment yields an empty list', () => {
    const idx = indexMastery(mastery);
    expect(buildAssignmentRubric('sa-nope', 'uid-1', idx)).toEqual([]);
  });
});
