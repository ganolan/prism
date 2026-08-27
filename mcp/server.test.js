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
    'DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;' +
    'DELETE FROM rubric_attachment_topics; DELETE FROM rubric_attachments; ' +
    'DELETE FROM rubric_descriptors; DELETE FROM rubric_criteria; DELETE FROM rubrics; '
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

  test('exposes list_students returning the course roster, independent of any assignment', async () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'AIML')`).run().lastInsertRowid;
    const s1 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
    const s2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-2', 'Grace', 'Hopper')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'e1')`).run(s1, courseId);
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id, dropped_at) VALUES (?, ?, 'e2', '2026-01-01T00:00:00.000Z')`).run(s2, courseId);

    const client = await connect();
    const res = await client.callTool({ name: 'list_students', arguments: { course_id: courseId } });
    const data = JSON.parse(res.content[0].text);
    expect(data.map((s) => s.schoology_uid)).toEqual(['uid-1']); // dropped student excluded
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

describe('grade-assignment prompt', () => {
  test('expands to the path-free orchestration message that wires the loop', async () => {
    const client = await connect();
    const { messages } = await client.getPrompt({
      name: 'grade-assignment',
      arguments: { assignment: 'the MAD app project', assignment_type: 'essay' },
    });
    const text = messages[0].content.text;
    expect(text).toContain('the MAD app project');
    expect(text).toContain('essay');
    for (const tool of ['list_assignments', 'get_assignment_context', 'write_student_suggestions', 'write_assessment_analysis']) {
      expect(text).toContain(tool);
    }
    expect(text).toMatch(/review in Prism/i);
    // Path-free: no absolute paths leak into the shipped prompt.
    expect(text).not.toMatch(/\/Users\//);
  });

  test('defaults assignment_type to portfolio when omitted', async () => {
    const client = await connect();
    const { messages } = await client.getPrompt({ name: 'grade-assignment', arguments: { assignment: 'X' } });
    expect(messages[0].content.text).toContain('portfolio');
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

  test('prism://course/{courseId}/roster mirrors list_students', async () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'AIML')`).run().lastInsertRowid;
    const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'e1')`).run(studentId, courseId);
    const client = await connect();
    const res = await client.readResource({ uri: `prism://course/${courseId}/roster` });
    expect(JSON.parse(res.contents[0].text).map((s) => s.schoology_uid)).toEqual(['uid-1']);
  });
});

describe('PrisMCP rubric tools', () => {
  const CRITERIA = [
    { criterion_name: 'UI/UX', standard_title: 'Visual design', reporting_category: 'Produce',
      descriptors: { ED: 'Polished', EX: 'Clear', D: 'Rough', EM: 'Weak' } },
    { criterion_name: 'Code', standard_title: 'Programming', reporting_category: 'Produce',
      descriptors: { ED: 'Clean', EX: 'Works', D: 'Messy', EM: 'Broken' } },
  ];

  test('write_rubric then read_rubric round-trips ordered criteria with no Prism ids', async () => {
    const client = await connect();
    await client.callTool({ name: 'write_rubric', arguments: { name: 'AIML U2', criteria: CRITERIA } });
    const res = await client.callTool({ name: 'read_rubric', arguments: { name: 'AIML U2' } });
    const r = JSON.parse(res.content[0].text);
    expect(r.name).toBe('AIML U2');
    expect(r.criteria.map((c) => c.criterion_name)).toEqual(['UI/UX', 'Code']); // order preserved
    expect(r.criteria[0].descriptors.IE).toBe('Insufficient Evidence');         // IE defaulted
    expect(JSON.stringify(r)).not.toMatch(/"id"/);                               // no ids leak
  });

  test('write_rubric does NOT overwrite a same-name different-content rubric — returns a conflict', async () => {
    const client = await connect();
    await client.callTool({ name: 'write_rubric', arguments: { name: 'Dupe', criteria: CRITERIA } });
    const res = await client.callTool({ name: 'write_rubric', arguments: { name: 'Dupe', criteria: [CRITERIA[0]] } });
    expect(JSON.parse(res.content[0].text).conflict).toBe('name');
    const list = JSON.parse((await client.callTool({ name: 'list_rubrics', arguments: {} })).content[0].text);
    expect(list.filter((r) => r.name === 'Dupe')).toHaveLength(1); // not duplicated, not replaced
  });

  test('write_rubric reuses an existing rubric with identical content under a different name', async () => {
    const client = await connect();
    await client.callTool({ name: 'write_rubric', arguments: { name: 'Design', criteria: CRITERIA } });
    const res = await client.callTool({ name: 'write_rubric', arguments: { name: 'Weather Design', criteria: CRITERIA } });
    expect(JSON.parse(res.content[0].text)).toMatchObject({ reused_existing: 'Design', match: 'exact' });
    const list = JSON.parse((await client.callTool({ name: 'list_rubrics', arguments: {} })).content[0].text);
    expect(list).toHaveLength(1); // no copy created
  });

  test('attach_rubric binds a written rubric to an assignment', async () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1','AIML')`).run().lastInsertRowid;
    const asgId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-7', 'Project')`).run(courseId).lastInsertRowid;
    db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('rc1', ?, 'ART.5', 'Presenting')`).run(courseId);
    db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1','rc1',?, 'ART.5.1','Visual design')`).run(courseId);
    db.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-7','t1',?)`).run(courseId);
    const client = await connect();
    await client.callTool({ name: 'write_rubric', arguments: { name: 'Design', criteria: [
      { criterion_name: 'UI/UX', standard_title: 'Visual design', reporting_category: 'Produce', descriptors: { ED: 'a' } },
    ] } });
    const res = await client.callTool({ name: 'attach_rubric', arguments: { rubric_name: 'Design', assignment_id: asgId } });
    expect(JSON.parse(res.content[0].text)).toMatchObject({ attached_to: asgId, rubric: 'Design', unmatched_criteria: [] });
  });
});
