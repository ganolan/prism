import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import router from './tools.js';
import { getDb } from '../db/index.js';

async function get(path) {
  const app = express();
  app.use('/api/tools', router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

let courseA;
let courseB;

function addStudent({ first, last, preferred = null, teacher = null, courses = [courseA], dropped = null }) {
  const db = getDb();
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO students (first_name, last_name, preferred_name, preferred_name_teacher) VALUES (?,?,?,?)'
  ).run(first, last, preferred, teacher);
  for (const c of courses) {
    db.prepare('INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?,?,?)')
      .run(lastInsertRowid, c, dropped);
  }
  return lastInsertRowid;
}

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM enrolments; DELETE FROM students; DELETE FROM courses;');
  courseA = db.prepare("INSERT INTO courses (schoology_section_id, course_name) VALUES ('secA', 'Course A')").run().lastInsertRowid;
  courseB = db.prepare("INSERT INTO courses (schoology_section_id, course_name) VALUES ('secB', 'Course B')").run().lastInsertRowid;
});

describe('GET /api/tools/roster/:courseId', () => {
  test('returns enrolled students ordered by surname, with a count', async () => {
    addStudent({ first: 'Zoe', last: 'Adams' });
    addStudent({ first: 'Alexander', last: 'Chen' });

    const { status, body } = await get(`/api/tools/roster/${courseA}`);

    expect(status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.students.map(s => s.last_name)).toEqual(['Adams', 'Chen']);
  });

  test('includes every name field the client needs to format a list', async () => {
    addStudent({ first: 'Alexander', last: 'Chen', preferred: 'Al', teacher: 'Alex' });

    const { body } = await get(`/api/tools/roster/${courseA}`);

    expect(body.students[0]).toMatchObject({
      first_name: 'Alexander',
      last_name: 'Chen',
      preferred_name: 'Al',
      preferred_name_teacher: 'Alex',
    });
    expect(body.students[0].id).toBeTypeOf('number');
  });

  test('excludes students who have dropped the course', async () => {
    addStudent({ first: 'Bao', last: 'Nguyen' });
    addStudent({ first: 'Gone', last: 'Away', dropped: '2026-01-15T00:00:00Z' });

    const { body } = await get(`/api/tools/roster/${courseA}`);

    expect(body.students.map(s => s.first_name)).toEqual(['Bao']);
  });

  test('spans several courses and lists a student enrolled in both only once', async () => {
    addStudent({ first: 'Dual', last: 'Enrolled', courses: [courseA, courseB] });
    addStudent({ first: 'Only', last: 'Bee', courses: [courseB] });

    const { body } = await get(`/api/tools/roster/${courseA},${courseB}`);

    expect(body.count).toBe(2);
    expect(body.students.map(s => s.last_name)).toEqual(['Bee', 'Enrolled']);
  });

  test('a course with no enrolments returns an empty roster, not an error', async () => {
    const { status, body } = await get(`/api/tools/roster/${courseB}`);

    expect(status).toBe(200);
    expect(body).toEqual({ students: [], count: 0 });
  });
});
