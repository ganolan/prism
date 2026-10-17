// The student page's OneDrive "Open" links (#135): one student's links only,
// several assignments per request, matched against the whole class roster.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });
vi.mock('../services/oneDriveLinks.js', () => ({ getAssignmentFilesMany: vi.fn() }));

import router from './students.js';
import { getDb } from '../db/index.js';
import { getAssignmentFilesMany } from '../services/oneDriveLinks.js';

async function get(path) {
  const app = express();
  app.use('/api/students', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

const ORIGIN = 'https://hkis-my.sharepoint.com';
const file = (name) => ({ Name: name, ServerRelativeUrl: `/d/${name}`, LinkingUrl: `${ORIGIN}/d/${name}?d=w1`, TimeLastModified: '2026-10-01T01:00:00Z' });

let ada, grace, courseId;
beforeEach(() => {
  vi.mocked(getAssignmentFilesMany).mockReset();
  const db = getDb();
  db.exec('DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'MAD')`).run().lastInsertRowid;
  const other = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-2', 'ROB')`).run().lastInsertRowid;
  ada = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
  grace = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u2', 'Grace', 'Hopper')`).run().lastInsertRowid;
  for (const s of [ada, grace]) db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(s, courseId);
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(grace, other);
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission, published) VALUES (?, 'sa-1', 'Design', 1, 1)`).run(courseId);
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission, published) VALUES (?, 'sa-2', 'Build', 1, 1)`).run(courseId);
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission, published) VALUES (?, 'sa-native', 'Essay', 0, 1)`).run(courseId);
  db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission, published) VALUES (?, 'sa-other', 'Bot', 1, 1)`).run(other);
});

describe('GET /api/students/:id/work-links', () => {
  test('returns only this student\'s link per assignment, from one batched lookup', async () => {
    vi.mocked(getAssignmentFilesMany).mockResolvedValue(new Map([
      ['sec-1:sa-1', { status: 'ok', origin: ORIGIN, files: [file('Ada Lovelace - Design - 1.pptx'), file('Grace Hopper - Design - 2.pptx')] }],
      ['sec-1:sa-2', { status: 'ok', origin: ORIGIN, files: [file('Grace Hopper - Build - 3.pptx')] }],
    ]));
    const { status, body } = await get(`/api/students/${ada}/work-links?assignments=sa-1,sa-2`);
    expect(status).toBe(200);
    expect(getAssignmentFilesMany).toHaveBeenCalledTimes(1);
    expect(getAssignmentFilesMany).toHaveBeenCalledWith([
      { sectionId: 'sec-1', assignmentId: 'sa-1' }, { sectionId: 'sec-1', assignmentId: 'sa-2' },
    ]);
    expect(body.links).toEqual({ 'sa-1': expect.objectContaining({ fileName: 'Ada Lovelace - Design - 1.pptx' }), 'sa-2': null });
    expect(body.status).toEqual({ 'sa-1': 'ok', 'sa-2': 'ok' });
    // Nothing about any other student reaches the client.
    expect(JSON.stringify(body)).not.toMatch(/Grace|Hopper|u2/);
  });

  test('skips non-OneDrive assignments and courses the student is not in, without a lookup', async () => {
    const { body } = await get(`/api/students/${ada}/work-links?assignments=sa-native,sa-other`);
    expect(getAssignmentFilesMany).not.toHaveBeenCalled();
    expect(body).toEqual({ links: {}, status: { 'sa-native': 'not_lti', 'sa-other': 'not_lti' } });
  });

  test('passes a lookup failure through as the assignment\'s status', async () => {
    vi.mocked(getAssignmentFilesMany).mockResolvedValue(new Map([['sec-1:sa-1', { status: 'no_session' }]]));
    const { body } = await get(`/api/students/${ada}/work-links?assignments=sa-1`);
    expect(body).toEqual({ links: { 'sa-1': null }, status: { 'sa-1': 'no_session' } });
  });

  test('404 for an unknown student', async () => {
    const { status } = await get('/api/students/999999/work-links?assignments=sa-1');
    expect(status).toBe(404);
  });
});
