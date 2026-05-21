import { describe, test, expect } from 'vitest';
import { groupAssignmentsByFolder } from './assessmentGroups.js';

const folders = [
  { schoology_folder_id: '10', title: 'Unit 1', parent_id: '0' },
  { schoology_folder_id: '20', title: 'Unit 2', parent_id: '0' },
  { schoology_folder_id: '21', title: 'Quizzes', parent_id: '20' },
];

describe('groupAssignmentsByFolder', () => {
  test('groups assignments by their folder, preserving order', () => {
    const assignments = [
      { id: 1, title: 'A', folder_id: '10' },
      { id: 2, title: 'B', folder_id: '10' },
      { id: 3, title: 'C', folder_id: '20' },
    ];
    const groups = groupAssignmentsByFolder(assignments, folders);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ folderId: '10', title: 'Unit 1' });
    expect(groups[0].assignments.map(a => a.id)).toEqual([1, 2]);
    expect(groups[1]).toMatchObject({ folderId: '20', title: 'Unit 2' });
    expect(groups[1].assignments.map(a => a.id)).toEqual([3]);
  });

  test('folder groups appear in first-appearance order, not folder list order', () => {
    const assignments = [
      { id: 1, title: 'A', folder_id: '20' },
      { id: 2, title: 'B', folder_id: '10' },
    ];
    const groups = groupAssignmentsByFolder(assignments, folders);
    expect(groups.map(g => g.folderId)).toEqual(['20', '10']);
  });

  test('reuses an earlier group when a folder reappears later in the order', () => {
    const assignments = [
      { id: 1, title: 'A', folder_id: '10' },
      { id: 2, title: 'B', folder_id: '20' },
      { id: 3, title: 'C', folder_id: '10' },
    ];
    const groups = groupAssignmentsByFolder(assignments, folders);
    expect(groups.map(g => g.folderId)).toEqual(['10', '20']);
    expect(groups[0].assignments.map(a => a.id)).toEqual([1, 3]);
  });

  test('nested folder titles include the parent path', () => {
    const assignments = [{ id: 1, title: 'A', folder_id: '21' }];
    const groups = groupAssignmentsByFolder(assignments, folders);
    expect(groups[0].title).toBe('Unit 2 / Quizzes');
  });

  test('assignments with no folder are grouped under folderId null', () => {
    const assignments = [
      { id: 1, title: 'A', folder_id: null },
      { id: 2, title: 'B', folder_id: '0' },
      { id: 3, title: 'C', folder_id: '10' },
    ];
    const groups = groupAssignmentsByFolder(assignments, folders);
    const ungrouped = groups.find(g => g.folderId === null);
    expect(ungrouped.title).toBeNull();
    expect(ungrouped.assignments.map(a => a.id)).toEqual([1, 2]);
  });

  test('unknown folder id still forms a group with a null title', () => {
    const assignments = [{ id: 1, title: 'A', folder_id: '999' }];
    const groups = groupAssignmentsByFolder(assignments, folders);
    expect(groups[0]).toMatchObject({ folderId: '999', title: null });
  });

  test('empty assignment list yields no groups', () => {
    expect(groupAssignmentsByFolder([], folders)).toEqual([]);
  });
});
