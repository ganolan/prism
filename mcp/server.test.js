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
    'DELETE FROM referrals; DELETE FROM extensions; DELETE FROM resubmissions; DELETE FROM school_days; ' +
    'DELETE FROM rubric_attachment_topics; DELETE FROM rubric_attachments; ' +
    'DELETE FROM rubric_descriptors; DELETE FROM rubric_criteria; DELETE FROM rubrics; ' +
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

  test('list_courses include_archived adds archived courses with school year and term; list_students include_dropped adds leavers', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO courses (schoology_section_id, course_name, grading_period) VALUES ('s1', 'Robotics', 'HS 26-27 S1')`).run();
    const old = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, grading_period, archived) VALUES ('s0', 'MAD', 'Semester 1: 08/15/23 - 01/07/24', 1)`).run().lastInsertRowid;
    const s1 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name, grad_year) VALUES ('uid-1', 'Ada', 'Lovelace', 2027)`).run().lastInsertRowid;
    const s2 = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-2', 'Grace', 'Hopper')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(s1, old);
    db.prepare(`INSERT INTO enrolments (student_id, course_id, dropped_at) VALUES (?, ?, '2023-09-01')`).run(s2, old);

    const client = await connect();
    const plain = JSON.parse((await client.callTool({ name: 'list_courses', arguments: {} })).content[0].text);
    expect(plain.map((c) => c.course_name)).toEqual(['Robotics']);
    const all = JSON.parse((await client.callTool({ name: 'list_courses', arguments: { include_archived: true } })).content[0].text);
    expect(all.map((c) => [c.course_name, c.school_year, c.term, c.archived])).toEqual([
      ['Robotics', '2026-27', 'Semester 1', false],
      ['MAD', '2023-24', 'Semester 1', true],
    ]);
    const roster = JSON.parse((await client.callTool({ name: 'list_students', arguments: { course_id: old, include_dropped: true } })).content[0].text);
    expect(roster.map((s) => [s.schoology_uid, s.grad_year, s.dropped_at ?? null])).toEqual([['uid-1', 2027, null], ['uid-2', null, '2023-09-01']]);
  });

  test('find_student then get_student_history reach a student across archived courses, comments verbatim, no AI suggestions', async () => {
    const db = getDb();
    const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name, grading_period, archived) VALUES ('s0', 'MOBILE GAMES DEVELOPMENT', 'Semester 2: 01/06/25 - 06/15/25', 1)`).run().lastInsertRowid;
    const st = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name, preferred_name_teacher, email, grad_year) VALUES ('uid-t', 'Mei Lin', 'Wong', 'Molly', '270555@hkis.edu.hk', 2027)`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(st, c);
    const a = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date) VALUES (?, 'a1', 'MGD: Final Pitch (S)', '2025-06-05 15:30:00')`).run(c).lastInsertRowid;
    db.prepare(`INSERT INTO grades (student_id, assignment_id, score, max_score, grade_comment) VALUES (?, ?, 100, 100, 'trying to bringing new life')`).run(st, a);
    db.prepare(`INSERT INTO feedback (student_id, assignment_id, status, feedback_json) VALUES (?, ?, 'draft', '{"narrative_feedback":"AI TEXT"}')`).run(st, a);

    const client = await connect();
    const found = JSON.parse((await client.callTool({ name: 'find_student', arguments: { query: 'Molly Wong' } })).content[0].text);
    expect(found.candidates.map((x) => [x.id, x.legal_first_name, x.preferred_first_name, x.courses[0].school_year])).toEqual([[st, 'Mei Lin', 'Molly', '2024-25']]);

    const res = await client.callTool({ name: 'get_student_history', arguments: { student: st } });
    const h = JSON.parse(res.content[0].text);
    expect(h.courses[0].assessments.map((x) => x.comment)).toEqual(['trying to bringing new life']);
    expect(res.content[0].text).not.toContain('AI TEXT');
  });

  test('get_student_history refuses an ambiguous name with the candidates', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name, email) VALUES ('u1', 'Ming', 'Lee', '270001@hkis.edu.hk')`).run();
    db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name, email) VALUES ('u2', 'Ming', 'Lee', '290002@hkis.edu.hk')`).run();
    const client = await connect();
    const res = await client.callTool({ name: 'get_student_history', arguments: { student: 'Ming Lee' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/AMBIGUOUS: "Ming Lee" matches 2 students/);
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

  test('asks for the glanceable flag lines, scale levels, and respects the teacher\'s handling', async () => {
    const client = await connect();
    const { messages } = await client.getPrompt({ name: 'grade-assignment', arguments: { assignment: 'X' } });
    const text = messages[0].content.text;
    // One short line per flag, alongside the detailed reviewer_flags.
    expect(text).toContain('reviewer_flags_brief');
    // Unaligned scale assignments are graded by level + evidence, not by topic.
    expect(text).toContain('score_scale');
    expect(text).toContain('scale_level');
    expect(text).toContain('evidence');
    // used / ignored / revised state of the previous narrative.
    expect(text).toContain('suggestion_state');
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

describe('PrisMCP triage tools', () => {
  test('get_triage is exposed and returns all three lists', async () => {
    const client = await connect();
    const res = await client.callTool({ name: 'get_triage', arguments: {} });
    const data = JSON.parse(res.content[0].text);
    expect(data).toHaveProperty('lateWork');
    expect(data).toHaveProperty('feedbackOwed');
    expect(data).toHaveProperty('makeUps');
    expect(data).toHaveProperty('makeUpsUnchecked');
  });

  test('make-up tests are advertised: instructions, get_triage and extend_deadline', async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    const desc = (name) => tools.find((t) => t.name === name).description;
    expect(INSTRUCTIONS).toMatch(/make-up tests?/i);
    expect(desc('get_triage')).toMatch(/makeUps/);
    expect(desc('get_triage')).toMatch(/makeUpsUnchecked/);
    expect(desc('extend_deadline')).toMatch(/make-up/i);
  });

  test('day numbers: get_triage says `day` is the dashboard number (due/test date = day 1) and to quote it', async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    const desc = (name) => tools.find((t) => t.name === name).description;
    expect(desc('get_triage')).toMatch(/due date = day 1/);
    expect(desc('get_triage')).toMatch(/quote `day`/);
    expect(desc('get_triage')).toMatch(/after day \{referralLimitDays\}/);
    expect(desc('get_triage')).toMatch(/after day \{feedbackLimitDays\}/);
    expect(desc('get_triage')).toMatch(/makeUpAmberDay\/makeUpRedDay/);
    expect(INSTRUCTIONS).toMatch(/day 1/);
  });

  test('lists all eight triage tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'get_triage', 'list_referrals', 'school_calendar', 'record_referral', 'undo_referral', 'extend_deadline', 'undo_extension',
      'set_makeup_tracking',
    ]));
  });

  test('set_makeup_tracking takes assignment_id + tracked (boolean), only when the teacher asks', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'set_makeup_tracking');
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['assignment_id', 'tracked']));
    expect(tool.inputSchema.properties.tracked.type).toBe('boolean');
    expect(tool.description).toMatch(/only when the teacher/i);
  });

  test("record_referral's action enum is 'referred' or 'waived'", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'record_referral');
    expect(tool.inputSchema.properties.action.enum).toEqual(['referred', 'waived']);
  });

  test('extend_deadline takes lessons as a 1–60 integer; student_id/assignment_id optional (resubmission_id path)', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'extend_deadline');
    expect(tool.inputSchema.required).toEqual(['lessons']);
    expect(tool.inputSchema.properties.lessons).toMatchObject({ type: 'integer', minimum: 1, maximum: 60 });
  });
});

describe('PrisMCP resubmission tools', () => {
  test('lists the resubmission tools', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'request_resubmission', 'grade_stands', 'list_resubmissions',
    ]));
    expect(names).not.toContain('mark_resubmission_reviewed');
    expect(names).not.toContain('close_resubmission');
    const list = (await client.listTools()).tools.find((t) => t.name === 'list_resubmissions');
    expect(list.inputSchema.properties.state.enum).toEqual(['asked', 'grade_stands', 'done', 'undone', 'closed']);
  });

  test('extend_deadline accepts resubmission_id and no longer requires student_id/assignment_id', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'extend_deadline');
    expect(tool.inputSchema.properties).toHaveProperty('resubmission_id');
    expect(tool.inputSchema.required ?? []).not.toEqual(expect.arrayContaining(['student_id']));
  });
});

describe('PrisMCP status lines (Amendment B)', () => {
  test('request_resubmission, extend_deadline and grade_stands take an optional comment_line and point the agent at preview_status_line', async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    const tool = (name) => tools.find((t) => t.name === name);

    expect(tool('request_resubmission').inputSchema.properties).toHaveProperty('comment_line');
    expect(tool('request_resubmission').inputSchema.properties).toHaveProperty('unsubmit');
    expect(tool('request_resubmission').inputSchema.required ?? []).not.toContain('unsubmit');
    expect(tool('request_resubmission').description).toMatch(/never re-submits/);
    expect(tool('request_resubmission').inputSchema.required ?? []).not.toContain('comment_line');
    expect(tool('request_resubmission').description).toContain('preview_status_line');

    expect(tool('extend_deadline').inputSchema.properties).toHaveProperty('comment_line');
    expect(tool('extend_deadline').description).toContain('preview_status_line');

    expect(tool('grade_stands').inputSchema.properties).toHaveProperty('comment_line');
    expect(tool('grade_stands').description).toContain('preview_status_line');
  });

  test('undo_extension takes an optional remove_line, and warns it changes a comment the student/parents see', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'undo_extension');
    expect(tool.inputSchema.properties).toHaveProperty('remove_line');
    expect(tool.inputSchema.properties.remove_line.type).toBe('boolean');
    expect(tool.inputSchema.required ?? []).not.toContain('remove_line');
    expect(tool.description).not.toContain('comment_line');
    expect(tool.description).toMatch(/student and parents/);
  });

  test('preview_status_line renders the line server-side: kind is required, with the per-kind args and the exact templates in its description', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'preview_status_line');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['kind']);
    expect(tool.inputSchema.properties.kind.enum).toEqual(['ask', 'extend_resubmission', 'grade_stands', 'extension', 'make_up']);
    expect(tool.inputSchema.properties).toHaveProperty('student_id');
    expect(tool.inputSchema.properties).toHaveProperty('assignment_id');
    expect(tool.inputSchema.properties).toHaveProperty('lessons');
    expect(tool.inputSchema.properties).toHaveProperty('note');
    expect(tool.inputSchema.properties).toHaveProperty('resubmission_id');
    expect(tool.inputSchema.properties).toHaveProperty('line');
    expect(tool.description).toContain('Resubmission requested - due {Ddd DD/MM}. {note}');
    expect(tool.description).not.toContain('undo_extension');
  });
  // preview_status_line's actual Schoology read/compose behaviour (including the
  // calendar math per kind) is covered in mcp/handlers.test.js and
  // server/services/statusLinePublisher.test.js, both of which mock
  // server/services/schoology.js — this file never mocks it, so no test here
  // calls a tool that would reach the real fresh-read path.

  test('a TriageError thrown by a tool has its code prefixed onto the MCP error text', async () => {
    const db = getDb();
    const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s1', 'AP CSP')`).run().lastInsertRowid;
    const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u1', 'Rae', 'So')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(studentId, courseId);
    const assignmentId = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, published) VALUES (?, 'a1', 'Task', '2026-10-05 15:30:00', 1)`
    ).run(courseId).lastInsertRowid;
    const client = await connect();
    const asked = await client.callTool({ name: 'request_resubmission', arguments: { student_id: studentId, assignment_id: assignmentId, lessons: 2 } });
    const { id } = JSON.parse(asked.content[0].text);
    // Asked today: the deadline is still ahead, so grade_stands is rejected
    // (NOT_AT_DEADLINE) before anything is published — no Schoology mock needed.
    const res = await client.callTool({ name: 'grade_stands', arguments: { id } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^NOT_AT_DEADLINE: /);
  });
});
