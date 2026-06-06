// PrisMCP end-to-end smoke (spec §12, headless portion). Run: `npm run mcp:e2e`.
//
// Seeds a THROWAWAY temp DB (never the real students.db), spawns mcp/server.js
// as a real stdio subprocess, runs the grade-assignment prompt + both write
// tools, then reads the result back from a SEPARATE ("Express-side")
// connection to prove cross-process WAL coexistence (spec §7) and that the
// written rows are in the shape /assessment/:id renders.
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = join(tmpdir(), 'prismcp-e2e.db');
for (const ext of ['', '-wal', '-shm']) { try { rmSync(DB + ext); } catch {} }
process.env.DB_PATH = DB;

const { getDb } = await import(pathToFileURL(join(ROOT, 'server/db/index.js')).href);
const express = getDb(); // stands in for the running Express server's connection

const courseId = express.prepare(`INSERT INTO courses (schoology_section_id, course_name, section_name) VALUES ('sec-e2e', 'AIML', 'Block A')`).run().lastInsertRowid;
express.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'ART.5', 'Creating')`).run(courseId);
express.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('topic-1', 'cat-1', ?, 'ART.5.1', 'Generates media')`).run(courseId);
const aid = express.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, max_points) VALUES (?, 'sa-e2e', 'Generative Art Project', 100)`).run(courseId).lastInsertRowid;
express.prepare(`INSERT INTO mastery_alignments (assignment_schoology_id, topic_id, course_id) VALUES ('sa-e2e', 'topic-1', ?)`).run(courseId);
const sid = express.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-e2e', 'Ada', 'Lovelace')`).run().lastInsertRowid;
express.prepare(`INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-e2e')`).run(sid, courseId);
express.prepare(`INSERT INTO grades (student_id, assignment_id, grade_comment, comment_status, exception) VALUES (?, ?, '', 1, 0)`).run(sid, aid);
console.log(`seeded temp DB ${DB}: course ${courseId}, assignment sa-e2e (#${aid}), student uid-e2e`);

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'mcp/server.js')], env: { ...process.env, DB_PATH: DB }, cwd: ROOT });
const client = new Client({ name: 'e2e', version: '1.0.0' });
await client.connect(transport);
console.log('MCP subprocess connected over stdio (Express connection already open → concurrent)');

const checks = [];
const prompt = await client.getPrompt({ name: 'grade-assignment', arguments: { assignment: 'Generative Art Project', assignment_type: 'portfolio' } });
checks.push(['grade-assignment prompt wires the loop + stops for review', /review in Prism/i.test(prompt.messages[0].content.text)]);

const w = JSON.parse((await client.callTool({ name: 'write_student_suggestions', arguments: {
  course_id: courseId, assignment_id: 'sa-e2e',
  students: [{ student: 'uid-e2e', narrative_feedback: 'Strong conceptual exploration; tighten the technical writeup.', rubric_scores: { 'ART.5.1': 'Exhibiting Depth' }, reviewer_flags: 'Confirm the dataset license.' }],
} })).content[0].text);
checks.push(['write_student_suggestions reports written', w.results?.[0]?.status === 'written']);

const a = JSON.parse((await client.callTool({ name: 'write_assessment_analysis', arguments: {
  course_id: courseId, assignment_id: 'sa-e2e',
  noticings: [{ title: 'AI tool use', body: '~half the class used generative tools; all disclosed.' }],
  moderation_note: 'Spot-check the EX/ED boundary.',
} })).content[0].text);
checks.push(['write_assessment_analysis reports written', a.status === 'written']);

await client.close();

// The Express-side connection (opened before the MCP subprocess existed) reads
// the rows the MCP wrote — proving cross-process coexistence and the UI shape.
const fb = express.prepare(`SELECT status, feedback_json FROM feedback WHERE assignment_id = ?`).get(aid);
const an = express.prepare(`SELECT analysis_json FROM assessment_analysis WHERE assignment_id = ?`).get(aid);
checks.push(['Express-side read sees a draft ✦ with normalized level (ED)', fb?.status === 'draft' && JSON.parse(fb.feedback_json).rubric_scores['ART.5.1'] === 'ED']);
checks.push(['Express-side read sees the assessment analysis', JSON.parse(an?.analysis_json || '{}').noticings?.length === 1]);

let ok = true;
for (const [label, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`); ok = ok && pass; }
console.log(ok ? '\nPrisMCP e2e PASS' : '\nPrisMCP e2e FAIL');
process.exit(ok ? 0 : 1);
