import { pathToFileURL } from 'url';
import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb } from '../server/db/index.js';
import { getAssessmentContext } from '../server/services/assessmentContext.js';
import { writeStudentSuggestions, upsertAssessmentAnalysis } from '../server/services/suggestions.js';
import { listCourses, listAssignments } from './handlers.js';

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
        'Load an assignment\'s roster, aligned measurement topics (rubric skeleton), current finals/comments/display-status, and any existing AI suggestions, to grade against.',
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
              rubric_scores: z.record(z.string(), z.string()).optional().describe('{ topic external_id|title: level code or full name }'),
              reviewer_flags: z.string().nullable().optional(),
              strengths: z.array(z.string()).optional(),
              suggestions: z.array(z.string()).optional(),
              score: z.number().optional(),
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
