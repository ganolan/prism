import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDb } from '../server/db/index.js';
import { createServer, connectDb, INSTRUCTIONS } from './server.js';

// Spin up the PrisMCP server and a client linked by an in-memory transport
// pair, so tests exercise the real MCP request/response path (registration,
// dispatch, serialization) without stdio.
async function connect() {
  const server = createServer();
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

beforeEach(() => {
  getDb().exec(
    'DELETE FROM assessment_analysis; DELETE FROM feedback; DELETE FROM mastery_alignments; ' +
    'DELETE FROM mastery_scores; DELETE FROM measurement_topics; DELETE FROM reporting_categories; ' +
    'DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;'
  );
});

describe('PrisMCP server', () => {
  test('exposes list_courses returning active courses to a connected client', async () => {
    getDb().prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'Robotics')`
    ).run();
    const client = await connect();
    const res = await client.callTool({ name: 'list_courses', arguments: {} });
    const data = JSON.parse(res.content[0].text);
    expect(data.map((c) => c.course_name)).toEqual(['Robotics']);
  });

  test('exposes list_assignments scoped to the requested course', async () => {
    const db = getDb();
    const c1 = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'MAD')`).run().lastInsertRowid;
    const c2 = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s2', 'ROB')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'a1', 'App Project')`).run(c1);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'a2', 'Other Course Task')`).run(c2);
    const client = await connect();
    const res = await client.callTool({ name: 'list_assignments', arguments: { course_id: c1 } });
    const data = JSON.parse(res.content[0].text);
    expect(data.map((a) => a.title)).toEqual(['App Project']);
  });

  test('exposes get_assignment_context accepting a Schoology assignment id', async () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'AIML')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'ART.5', 'Creating')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('topic-1', 'cat-1', ?, 'ART.5.1', 'Generates media')`).run(courseId);
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`).run(courseId);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-1', 'topic-1', ?)`).run(courseId);
    const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-1')`).run(studentId, courseId);

    const client = await connect();
    const res = await client.callTool({ name: 'get_assignment_context', arguments: { course_id: courseId, assignment_id: 'sa-1' } });
    const ctx = JSON.parse(res.content[0].text);
    expect(ctx.assignment.schoology_assignment_id).toBe('sa-1');
    expect(ctx.topics.map((t) => t.external_id)).toEqual(['ART.5.1']);
    expect(ctx.students.map((s) => s.schoology_uid)).toEqual(['uid-1']);
  });

  test('write_student_suggestions writes drafts and returns a per-student summary', async () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'AIML')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'ART.5', 'Creating')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('topic-1', 'cat-1', ?, 'ART.5.1', 'Generates media')`).run(courseId);
    const assignmentLocalId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-1', 'topic-1', ?)`).run(courseId);
    db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run();

    const client = await connect();
    const res = await client.callTool({
      name: 'write_student_suggestions',
      arguments: {
        course_id: courseId,
        assignment_id: 'sa-1',
        students: [{ student: 'uid-1', narrative_feedback: 'Strong work', rubric_scores: { 'ART.5.1': 'Exhibiting' } }],
      },
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.results[0]).toMatchObject({ student: 'uid-1', status: 'written' });
    const row = db.prepare('SELECT status, feedback_json FROM feedback WHERE assignment_id = ?').get(assignmentLocalId);
    expect(row.status).toBe('draft');
    expect(JSON.parse(row.feedback_json).rubric_scores).toEqual({ 'ART.5.1': 'EX' });
  });

  test('write_assessment_analysis upserts the assessment-wide analysis row', async () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'AIML')`).run().lastInsertRowid;
    const assignmentLocalId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`).run(courseId).lastInsertRowid;

    const client = await connect();
    const res = await client.callTool({
      name: 'write_assessment_analysis',
      arguments: {
        course_id: courseId,
        assignment_id: 'sa-1',
        noticings: [{ title: 'AI use', body: 'half the class leaned on it' }],
        moderation_note: 'spot-check the borderline calls',
      },
    });
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({ status: 'written', assignment_id: assignmentLocalId });
    const row = db.prepare('SELECT analysis_json FROM assessment_analysis WHERE assignment_id = ?').get(assignmentLocalId);
    expect(JSON.parse(row.analysis_json)).toEqual({
      noticings: [{ title: 'AI use', body: 'half the class leaned on it' }],
      moderation_note: 'spot-check the borderline calls',
    });
  });

  test('advertises the tool-search instructions to the client', async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS.length).toBeLessThan(2048);
  });

  test('connectDb sets busy_timeout so MCP writes coexist with the Express server', () => {
    const db = connectDb();
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });
});

describe('PrisMCP resources (@-mention mirror)', () => {
  test('prism://courses mirrors list_courses', async () => {
    getDb().prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'Robotics')`).run();
    const client = await connect();
    const res = await client.readResource({ uri: 'prism://courses' });
    expect(JSON.parse(res.contents[0].text).map((c) => c.course_name)).toEqual(['Robotics']);
  });

  test('prism://course/{courseId}/assignments mirrors list_assignments', async () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'MAD')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'a1', 'App Project')`).run(courseId);
    const client = await connect();
    const res = await client.readResource({ uri: `prism://course/${courseId}/assignments` });
    expect(JSON.parse(res.contents[0].text).map((a) => a.title)).toEqual(['App Project']);
  });

  test('prism://assignment/{courseId}/{assignmentId}/context mirrors get_assignment_context', async () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'AIML')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`).run(courseId);
    const client = await connect();
    const res = await client.readResource({ uri: `prism://assignment/${courseId}/sa-1/context` });
    expect(JSON.parse(res.contents[0].text).assignment.schoology_assignment_id).toBe('sa-1');
  });
});
