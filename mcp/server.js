import { pathToFileURL } from 'url';
import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb } from '../server/db/index.js';
import { getAssessmentContext } from '../server/services/assessmentContext.js';
import { writeStudentSuggestions, upsertAssessmentAnalysis } from '../server/services/suggestions.js';
import { listCourses, listAssignments, listRubricsTool, readRubric, writeRubric, attachRubricTool } from './handlers.js';

// <2KB tool-search hint (spec §3.4) so a client knows when to surface PrisMCP.
export const INSTRUCTIONS =
  "Read a Prism-tracked course/assignment's roster, rubric measurement-topics, " +
  'and current grades, and write AI grading suggestions back into Prism for ' +
  'teacher review. Use when grading student work for a course managed in Prism.';

// Open the shared Prism DB (resolved relative to server/db, honoring DB_PATH)
// and set busy_timeout so a brief write collision with the Express server
// retries rather than throwing SQLITE_BUSY under WAL (spec §7). Returns the
// shared getDb() singleton — the same connection the tool handlers query.
export function connectDb() {
  const db = getDb();
  db.pragma('busy_timeout = 5000');
  return db;
}

// Build the PrisMCP server with all tools/resources/prompts registered. Pure
// construction — no transport, no DB side effects — so tests can drive it over
// an in-memory transport against a seeded :memory: DB.
export function createServer() {
  const server = new McpServer(
    { name: 'prism', version: '0.1.0' },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool(
    'list_courses',
    { description: 'List active (non-archived) Prism courses, to resolve which class to grade.' },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(listCourses(getDb())) }] })
  );

  server.registerTool(
    'list_assignments',
    {
      description:
        "List a course's assignments (with aligned-topic + latest-submission hints) to resolve which assignment to grade.",
      inputSchema: { course_id: z.union([z.number(), z.string()]).describe('Local Prism course id') },
    },
    async ({ course_id }) => ({
      content: [{ type: 'text', text: JSON.stringify(listAssignments(getDb(), { course_id })) }],
    })
  );

  server.registerTool(
    'get_assignment_context',
    {
      description:
        'Load an assignment\'s roster, aligned measurement topics (rubric skeleton), current finals/comments/display-status, any existing AI suggestions, and the teacher\'s in-progress unpublished draft (draft_feedback: their staged proficiency picks, removed topics, comment, and display-to-student toggle), to grade against. Address each student in feedback by their roster `preferred_first_name` (the teacher-honored display name); `first_name`/`last_name` are the legal name, for matching submissions.',
      inputSchema: {
        course_id: z.union([z.number(), z.string()]).describe('Local Prism course id'),
        assignment_id: z.union([z.number(), z.string()]).describe('Schoology or local assignment id'),
      },
    },
    async ({ course_id, assignment_id }) => ({
      content: [
        { type: 'text', text: JSON.stringify(getAssessmentContext(getDb(), { courseId: course_id, assignmentId: assignment_id })) },
      ],
    })
  );

  server.registerTool(
    'write_student_suggestions',
    {
      description:
        'Write AI grading suggestions (narrative + per-topic levels + reviewer flags) for a whole class in one batched call. Upserts one draft suggestion per student for teacher review in Prism; never writes to Schoology.',
      inputSchema: {
        course_id: z.union([z.number(), z.string()]).describe('Local Prism course id'),
        assignment_id: z.union([z.number(), z.string()]).describe('Schoology or local assignment id'),
        students: z
          .array(
            z.object({
              student: z.union([z.number(), z.string()]).describe('schoology_uid or local student id'),
              narrative_feedback: z.string().optional(),
              rubric_scores: z.record(z.string(), z.string()).optional().describe('{ topic external_id|title: proficiency level code or name } — levels only; Prism owns the points conversion'),
              reviewer_flags: z.string().nullable().optional(),
              strengths: z.array(z.string()).optional(),
              suggestions: z.array(z.string()).optional(),
            })
          )
          .describe('Whole-class batch, one entry per student'),
      },
    },
    async ({ assignment_id, students }) => ({
      content: [{ type: 'text', text: JSON.stringify(writeStudentSuggestions(getDb(), { assignmentId: assignment_id, students })) }],
    })
  );

  server.registerTool(
    'write_assessment_analysis',
    {
      description:
        'Write the assessment-wide reviewer analysis (noticings + optional moderation note) for an assignment, shown in the Reviewer Analysis drawer in Prism.',
      inputSchema: {
        course_id: z.union([z.number(), z.string()]).describe('Local Prism course id'),
        assignment_id: z.union([z.number(), z.string()]).describe('Schoology or local assignment id'),
        noticings: z.array(z.object({ title: z.string(), body: z.string() })).describe('Class-level observations'),
        moderation_note: z.string().optional(),
      },
    },
    async ({ assignment_id, noticings, moderation_note }) => ({
      content: [{ type: 'text', text: JSON.stringify(upsertAssessmentAnalysis(getDb(), { assignmentId: assignment_id, noticings, moderation_note })) }],
    })
  );

  server.registerTool(
    'list_rubrics',
    { description: 'List the reusable rubric library (name, source, criteria count, last updated) so an agent can pick or update a rubric by name.' },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(listRubricsTool(getDb())) }] })
  );

  server.registerTool(
    'read_rubric',
    {
      description: 'Read a rubric by name in portable form — ordered criteria with per-level descriptors and no Prism ids (the JSON twin of the CSV export).',
      inputSchema: { name: z.string().describe('Rubric name (as shown by list_rubrics)') },
    },
    async ({ name }) => ({ content: [{ type: 'text', text: JSON.stringify(readRubric(getDb(), { name })) }] })
  );

  server.registerTool(
    'write_rubric',
    {
      description: 'Create or update a rubric by name. Dedup: if a rubric with identical content already exists (any name), it is reused (no copy) and the result reports { reused_existing, match: "exact" }. If a DIFFERENT rubric already has this name, the write is held back and returns { conflict: "name", ... } — ask the teacher, then re-call with on_name_conflict:"update" (replace it) or "new" (save a separate copy). Criteria are an ordered array (array order = row order). No Prism ids required.',
      inputSchema: {
        name: z.string().describe('Rubric name — the stable handle'),
        on_name_conflict: z.enum(['prompt', 'update', 'new']).optional()
          .describe('How to resolve a same-name-different-content collision: "prompt" (default, return a conflict), "update" (replace the existing), or "new" (save a separate copy)'),
        criteria: z.array(z.object({
          criterion_name: z.string().describe('Friendly label, e.g. "UI/UX"'),
          standard_title: z.string().optional().describe('Measurement-topic title as written by the author'),
          reporting_category: z.string().optional().describe('e.g. "Produce" / "Create"'),
          descriptors: z.object({
            ED: z.string().optional(), EX: z.string().optional(), D: z.string().optional(),
            EM: z.string().optional(), IE: z.string().optional(),
          }).describe('Per-level descriptor prose; IE defaults to "Insufficient Evidence" when omitted'),
        })).describe('Ordered criteria — the array order is the row order'),
      },
    },
    async ({ name, criteria, on_name_conflict }) => ({ content: [{ type: 'text', text: JSON.stringify(writeRubric(getDb(), { name, criteria, on_name_conflict })) }] })
  );

  server.registerTool(
    'attach_rubric',
    {
      description: "Attach a library rubric (by name) to an assignment, auto-matching its criteria to the assignment's measurement topics. Returns { attached_to, rubric, unmatched_criteria } — finish any unmatched criteria in Prism's Map-criteria tab.",
      inputSchema: {
        rubric_name: z.string().describe('Rubric name (as shown by list_rubrics)'),
        assignment_id: z.union([z.number(), z.string()]).describe('Local Prism assignment id (from list_assignments)'),
      },
    },
    async ({ rubric_name, assignment_id }) => ({ content: [{ type: 'text', text: JSON.stringify(attachRubricTool(getDb(), { rubric_name, assignment_id })) }] })
  );

  // Read-only @-mention mirror of the read tools (spec §3.2), so the teacher can
  // inject Prism context into an ad-hoc chat without running the grade prompt.
  const json = (uri, data) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data) }] });

  server.registerResource(
    'courses', 'prism://courses',
    { title: 'Prism courses', description: 'Active Prism courses', mimeType: 'application/json' },
    async (uri) => json(uri, listCourses(getDb()))
  );

  server.registerResource(
    'assignments',
    new ResourceTemplate('prism://course/{courseId}/assignments', { list: undefined }),
    { title: 'Course assignments', description: "A course's assignments", mimeType: 'application/json' },
    async (uri, { courseId }) => json(uri, listAssignments(getDb(), { course_id: courseId }))
  );

  server.registerResource(
    'assignment-context',
    new ResourceTemplate('prism://assignment/{courseId}/{assignmentId}/context', { list: undefined }),
    { title: 'Assignment context', description: 'Roster, topics, grades + suggestions for an assignment', mimeType: 'application/json' },
    async (uri, { courseId, assignmentId }) => json(uri, getAssessmentContext(getDb(), { courseId, assignmentId }))
  );

  // Thin, path-free orchestration kickoff (spec §3.3). Carries NO grading
  // content — it only wires get-context → follow the in-context {type}
  // instructions → write back → stop for teacher review. References instructions
  // and submissions by role/type, never by absolute path, so it ships in-repo.
  server.registerPrompt(
    'grade-assignment',
    {
      title: 'Grade an assignment (Prism)',
      description: 'Wire a grading run: load Prism context, follow your in-context grading instructions, write suggestions back for review.',
      argsSchema: {
        assignment: z.string().describe('Which assignment to grade (free text; resolved via list_assignments)'),
        assignment_type: z.string().optional().describe('Grading-skill hint, e.g. "portfolio" / "essay" (default "portfolio")'),
      },
    },
    ({ assignment, assignment_type }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `You are grading **${assignment}**. If the assignment is ambiguous, call \`list_assignments\` to resolve ` +
              `it. Call \`get_assignment_context\` to load the roster, aligned measurement topics, and current grading ` +
              `state. Then follow your **${assignment_type || 'portfolio'}** grading instructions (already provided in ` +
              `this chat's context) to grade the submissions provided in this chat. When done, call ` +
              `\`write_student_suggestions\` (whole class, one call) and \`write_assessment_analysis\`, then **stop and ` +
              `hand back to the teacher to review in Prism**.`,
          },
        },
      ],
    })
  );

  return server;
}

// Entrypoint: open the shared DB (resolved relative to server/db, honoring
// DB_PATH) and serve over stdio. Guarded so importing this module in tests
// does not boot a server.
async function main() {
  connectDb();
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[prismcp] fatal:', err);
    process.exit(1);
  });
}
