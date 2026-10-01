import { isMain } from '../server/lib/isMain.js';
import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb } from '../server/db/index.js';
import { getAssessmentContext } from '../server/services/assessmentContext.js';
import { writeStudentSuggestions, upsertAssessmentAnalysis } from '../server/services/suggestions.js';
import { listCourses, listAssignments, listStudents, listRubricsTool, readRubric, writeRubric, attachRubricTool } from './handlers.js';
import {
  getTriageTool, listReferralsTool, schoolCalendarTool, recordReferralTool, undoReferralTool, extendDeadlineTool, undoExtensionTool,
} from './handlers.js';
import { assertExplicitDbPath } from './dbGuard.js';

// <2KB tool-search hint (spec §3.4) so a client knows when to surface PrisMCP.
export const INSTRUCTIONS =
  "Read a Prism-tracked course/assignment's roster, rubric measurement-topics, " +
  'and current grades, and write AI grading suggestions back into Prism for ' +
  'teacher review. Use when grading student work for a course managed in Prism. ' +
  'Also triage: which students are approaching an academic-office referral for ' +
  'late summative work, which assessments have waited longest for feedback ' +
  '(all in school days), and school-calendar arithmetic.';

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
    { description: 'List active (non-archived) Prism courses, to resolve which class to grade. Sections of one course share a name — block_number tells them apart.' },
    async () => ({ content: [{ type: 'text', text: JSON.stringify(listCourses(getDb())) }] })
  );

  server.registerTool(
    'list_assignments',
    {
      description:
        "List a course's assignments (with aligned-topic + latest-submission hints) to resolve which assignment to grade. `score_scale` names the Schoology scale an unaligned assignment is graded on (e.g. \"Completion Scale\"), null for rubric-graded ones.",
      inputSchema: { course_id: z.union([z.number(), z.string()]).describe('Local Prism course id') },
    },
    async ({ course_id }) => ({
      content: [{ type: 'text', text: JSON.stringify(listAssignments(getDb(), { course_id })) }],
    })
  );

  server.registerTool(
    'list_students',
    {
      description:
        "List a course's current roster (non-dropped enrolments), independent of any assignment — e.g. to check a meeting attendance list against who's enrolled.",
      inputSchema: { course_id: z.union([z.number(), z.string()]).describe('Local Prism course id') },
    },
    async ({ course_id }) => ({
      content: [{ type: 'text', text: JSON.stringify(listStudents(getDb(), { course_id })) }],
    })
  );

  server.registerTool(
    'get_assignment_context',
    {
      description:
        'Load an assignment\'s roster, aligned measurement topics (rubric skeleton) — or, for an unaligned assignment, its `score_scale` (levels best → worst) and each student\'s `current_scale_level` — current finals/comments/display-status, any existing AI suggestions, and the teacher\'s in-progress unpublished draft (draft_feedback: their staged proficiency picks, removed topics, comment, and display-to-student toggle), to grade against. Address each student in feedback by their roster `preferred_first_name` (the teacher-honored display name); `first_name`/`last_name` are the legal name, for matching submissions.',
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
        'Write AI grading suggestions (narrative + per-topic levels + reviewer flags) for a whole class in one batched call. For an assignment with a `score_scale` (Completion, General Academic Scale (Unaligned), Approaches to Learning), send `scale_level` instead of rubric_scores — e.g. after checking a third-party platform, "Completed" plus an `evidence` note saying what you checked. Upserts one draft suggestion per student for teacher review in Prism (the teacher accepts and publishes); never writes to Schoology.',
      inputSchema: {
        course_id: z.union([z.number(), z.string()]).describe('Local Prism course id'),
        assignment_id: z.union([z.number(), z.string()]).describe('Schoology or local assignment id'),
        students: z
          .array(
            z.object({
              student: z.union([z.number(), z.string()]).describe('schoology_uid or local student id'),
              narrative_feedback: z.string().optional(),
              rubric_scores: z.record(z.string(), z.string()).optional().describe('{ topic external_id|title: proficiency level code or name } — levels only; Prism owns the points conversion'),
              reviewer_flags: z.string().nullable().optional().describe('Teacher-facing detail, one paragraph per flag'),
              reviewer_flags_brief: z.array(z.string()).optional().describe('One short line per reviewer flag (~12 words each), shown at a glance above strengths/suggestions; the full reviewer_flags text sits behind "Show detailed flags". Without it Prism shows the first sentence of each flag paragraph.'),
              strengths: z.array(z.string()).optional(),
              suggestions: z.array(z.string()).optional(),
              scale_level: z.string().optional().describe('Score-scale assignments only: a level code or label from get_assignment_context score_scale, e.g. "Completed"'),
              evidence: z.string().optional().describe('Teacher-facing note on what backs scale_level, e.g. "Codecademy: lesson 4 complete 26/09"'),
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

  const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

  server.registerTool(
    'get_triage',
    {
      description:
        "Late-work referral watch + feedback owed, exactly as Prism's dashboard shows them. lateWork: summative work " +
        'that takes Schoology submissions, not submitted (or submitted after crossing the limit), with daysLate in SCHOOL days and tone green/amber/red ' +
        '(red = at the referral limit). feedbackOwed: per assessment, how many submissions are ungraded and the oldest ' +
        'wait in school days (paper/no-dropbox work counts the whole roster as handed in on the due date). ' +
        'Rows carry courseName + blockNumber (sections of one course share a name) and extension ({ id, lessons, until, note } or null; dueDate stays the original). Includes the limits (settings), calendar source (approx = weekday fallback) and lastSyncAt — ' +
        'say when data may be stale. Use for "who is close to referral?" or "what should I grade first?".',
      inputSchema: {
        course: z.union([z.number(), z.string()]).optional().describe('Course id (list_courses) or a name/code fragment; omit for all current courses'),
        student: z.union([z.number(), z.string()]).optional().describe('Student id or name fragment to filter lateWork'),
        include_formative: z.boolean().optional().describe('Include formative work in feedbackOwed (default: the teacher setting)'),
      },
    },
    async (args) => text(getTriageTool(getDb(), args))
  );

  server.registerTool(
    'list_referrals',
    {
      description: 'Triage history, newest first: { referrals: late-work pairs the teacher marked referred (to the academic office), with notes and the school-day count at the time; extensions: per-student deadline extensions ({ id, lessons, until, note }) }.',
      inputSchema: {
        course: z.union([z.number(), z.string()]).optional().describe('Course id or name/code fragment'),
        student: z.union([z.number(), z.string()]).optional().describe('Student id or name fragment'),
        since: z.string().optional().describe("Only records on/after this date, 'YYYY-MM-DD'"),
      },
    },
    async (args) => text(listReferralsTool(getDb(), args))
  );

  server.registerTool(
    'school_calendar',
    {
      description: "School-calendar arithmetic using the same rule as triage: info for a date (school day?, cycle letter, school-day number) and, with `to`, the count of school days d where date < d <= to. source 'weekdays' / approx = no PowerSchool calendar for that range.",
      inputSchema: {
        date: z.string().optional().describe("'YYYY-MM-DD' (default today)"),
        to: z.string().optional().describe("'YYYY-MM-DD' end date for a school-day count"),
      },
    },
    async (args) => text(schoolCalendarTool(getDb(), args))
  );

  server.registerTool(
    'record_referral',
    {
      description: "Record that the teacher referred a late-work row to the academic office ('referred'). ONLY call when the teacher explicitly says so. Use student_id/assignment_id from get_triage lateWork; rejects pairs not currently on the list, and rows not yet at the referral limit (tone red) with NOT_AT_LIMIT. To give a student more time use extend_deadline; a true exemption is Schoology's Excused flag.",
      inputSchema: {
        student_id: z.number().describe('lateWork[].studentId'),
        assignment_id: z.number().describe('lateWork[].assignmentId'),
        action: z.enum(['referred']),
        note: z.string().optional().describe('Optional note, e.g. "emailed the academic office"'),
      },
    },
    async (args) => text(recordReferralTool(getDb(), args))
  );

  server.registerTool(
    'undo_referral',
    {
      description: 'Undo a referral by its id (from list_referrals or record_referral). The pair returns to the late-work list if still late. Only when the teacher asks.',
      inputSchema: { id: z.number().describe('Referral id') },
    },
    async (args) => text(undoReferralTool(getDb(), args))
  );

  server.registerTool(
    'extend_deadline',
    {
      description: "Give one student more time on a summative assignment: extend its due date by N lessons (lessons = SCHOOL days, the referral limit's unit). ONLY call when the teacher explicitly asks. The student is off the late-work list until the extended date (`until`) passes, then counts late from it. Allowed any time (before or after the due date), for summative work in a current course that targets the student. Extending the same pair again replaces lessons/note. Returns the stored extension.",
      inputSchema: {
        student_id: z.number().describe('Student id (lateWork[].studentId or list_students)'),
        assignment_id: z.number().describe('Assignment id (lateWork[].assignmentId or list_assignments)'),
        lessons: z.number().int().min(1).max(60).describe('Extension in lessons (school days), 1–60'),
        note: z.string().optional().describe('Optional reason, e.g. "sick for a week"'),
      },
    },
    async (args) => text(extendDeadlineTool(getDb(), args))
  );

  server.registerTool(
    'undo_extension',
    {
      description: 'Undo a deadline extension by its id (from list_referrals extensions or extend_deadline). The student is measured from the original due date again. Only when the teacher asks.',
      inputSchema: { id: z.number().describe('Extension id') },
    },
    async (args) => text(undoExtensionTool(getDb(), args))
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
    'roster',
    new ResourceTemplate('prism://course/{courseId}/roster', { list: undefined }),
    { title: 'Course roster', description: "A course's current roster", mimeType: 'application/json' },
    async (uri, { courseId }) => json(uri, listStudents(getDb(), { course_id: courseId }))
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
              `hand back to the teacher to review in Prism**.\n\n` +
              `How Prism shows your suggestions:\n` +
              `- **Flags:** the teacher reads flags at a glance. Whenever you write \`reviewer_flags\` (one paragraph ` +
              `per flag), also send \`reviewer_flags_brief\`: one short line per flag (about 12 words), in the same ` +
              `order. The paragraphs sit behind "Show detailed flags".\n` +
              `- **Scale assignments:** if \`get_assignment_context\` returns a \`score_scale\` (Completion, General ` +
              `Academic Scale (Unaligned), Approaches to Learning), grade with \`scale_level\` (a level from ` +
              `\`score_scale.levels\`) plus an \`evidence\` note saying what you checked, instead of \`rubric_scores\`.\n` +
              `- **Re-runs:** each student's \`existing_suggestion.suggestion_state\` says how the teacher handled your ` +
              `last narrative: \`used\` (it is in their comment), \`ignored\` (they dismissed it), \`revised\` (a ` +
              `previous re-run changed it). Only rewrite \`narrative_feedback\` when you have something new: a changed ` +
              `narrative reopens it for the teacher, tagged Revised.`,
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
  // stderr, never stdout — stdout is the MCP protocol channel.
  console.error(`[prismcp] database: ${assertExplicitDbPath()}`);
  connectDb();
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error('[prismcp] fatal:', err);
    process.exit(1);
  });
}
