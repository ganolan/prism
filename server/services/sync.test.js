import { describe, test, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/index.js';

vi.mock('./schoology.js', () => ({
  getMyUserId: vi.fn(),
  getMySections: vi.fn(),
  getSectionEnrollments: vi.fn(),
  getSectionAssignments: vi.fn(),
  getSectionGrades: vi.fn(),
  getSectionGradingPeriods: vi.fn(),
  getSectionFolders: vi.fn(),
  getSectionGradingCategories: vi.fn(),
  getSectionGradingScales: vi.fn(),
  getUserProfile: vi.fn(),
  getSubmissionStatus: vi.fn(),
}));

import {
  getSectionEnrollments,
  getSectionAssignments,
  getSectionGrades,
  getSubmissionStatus,
} from './schoology.js';
import { syncSectionData } from './sync.js';

describe('syncSectionData — assignee mapping (#54)', () => {
  let db;
  let courseId;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Algebra')`
    ).run().lastInsertRowid;
    getSectionEnrollments.mockReset();
    getSectionAssignments.mockReset();
    getSectionGrades.mockReset();
    getSubmissionStatus.mockReset();
    getSectionGrades.mockResolvedValue([]);
    getSubmissionStatus.mockResolvedValue(null);
  });

  test('translates Schoology assignees[] (enrollment ids) into user UIDs', async () => {
    // Schoology returns enrollment ids in `assignees`, not user uids.
    getSectionEnrollments.mockResolvedValue([
      { id: '900001', uid: '700001', name_first: 'Ada', name_last: 'Lovelace', admin: '0' },
      { id: '900002', uid: '700002', name_first: 'Alan', name_last: 'Turing', admin: '0' },
      { id: '900003', uid: '700003', name_first: 'Grace', name_last: 'Hopper', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      {
        id: '5001', title: 'Targeted to two students', published: 1,
        num_assignees: 2,
        // Enrollment ids — must be mapped to uids 700001 and 700003 before insert.
        assignees: '[900001,900003]',
      },
    ]);

    await syncSectionData(db, 'sec-1', courseId, new Date().toISOString());

    const rows = db.prepare(`
      SELECT aa.schoology_uid
      FROM assignment_assignees aa
      JOIN assignments a ON a.id = aa.assignment_id
      WHERE a.schoology_assignment_id = '5001'
      ORDER BY aa.schoology_uid
    `).all();
    expect(rows.map(r => r.schoology_uid)).toEqual(['700001', '700003']);
  });

  test('open-to-all assignment (empty assignees) writes no rows', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '900001', uid: '700001', name_first: 'Ada', name_last: 'Lovelace', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: '5002', title: 'Open', published: 1, num_assignees: 0, assignees: '[]' },
    ]);

    await syncSectionData(db, 'sec-1', courseId, new Date().toISOString());

    const count = db.prepare(`
      SELECT COUNT(*) AS n FROM assignment_assignees aa
      JOIN assignments a ON a.id = aa.assignment_id
      WHERE a.schoology_assignment_id = '5002'
    `).get().n;
    expect(count).toBe(0);
  });

  test('skips assignees whose enrollment id is not in this section (defensive)', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '900001', uid: '700001', name_first: 'Ada', name_last: 'Lovelace', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      {
        id: '5003', title: 'Mixed', published: 1, num_assignees: 2,
        assignees: '[900001,999999]', // 999999 not enrolled here
      },
    ]);

    await syncSectionData(db, 'sec-1', courseId, new Date().toISOString());

    const rows = db.prepare(`
      SELECT aa.schoology_uid FROM assignment_assignees aa
      JOIN assignments a ON a.id = aa.assignment_id
      WHERE a.schoology_assignment_id = '5003'
    `).all();
    expect(rows.map(r => r.schoology_uid)).toEqual(['700001']);
  });
});
