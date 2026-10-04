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
  setMakeupTrackingTool,
  requestResubmissionTool, gradeStandsTool, listResubmissionsTool, previewStatusLineTool,
  getSubmissionStatusTool,
} from './handlers.js';
import { assertExplicitDbPath } from './dbGuard.js';

// <2KB tool-search hint (spec §3.4) so a client knows when to surface PrisMCP.
export const INSTRUCTIONS =
  "Read a Prism-tracked course/assignment's roster, rubric measurement-topics, " +
  'and current grades, and write AI grading suggestions back into Prism for ' +
  'teacher review. Use when grading student work for a course managed in Prism. ' +
  'Also triage: which students are approaching an academic-office referral for ' +
  'late summative work, which assessments have waited longest for feedback, ' +
  'which students missed a Schoology test and must sit a make-up test ' +
  '(all in school days, numbered with the due/test date as day 1), and ' +
  'school-calendar arithmetic.';

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
    { description: 'List active (non-archived) Prism courses, to resolve which class to grade. Sections of one course share a name: block_number tells them apart.' },
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
        "List a course's current roster (non-dropped enrolments), independent of any assignment, e.g. to check a meeting attendance list against who's enrolled.",
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
        'Load an assignment\'s roster, aligned measurement topics (rubric skeleton); or, for an unaligned assignment, its `score_scale` (levels best → worst) and each student\'s `current_scale_level`; current finals/comments/display-status, any existing AI suggestions, and the teacher\'s in-progress unpublished draft (draft_feedback: their staged proficiency picks, removed topics, comment, and display-to-student toggle), to grade against. Address each student in feedback by their roster `preferred_first_name` (the teacher-honored display name); `first_name`/`last_name` are the legal name, for matching submissions.',
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
        'Write AI grading suggestions (narrative + per-topic levels + reviewer flags) for a whole class in one batched call. For an assignment with a `score_scale` (Completion, General Academic Scale (Unaligned), Approaches to Learning), send `scale_level` instead of rubric_scores, e.g. after checking a third-party platform, "Completed" plus an `evidence` note saying what you checked. Upserts one draft suggestion per student for teacher review in Prism (the teacher accepts and publishes); never writes to Schoology.',
      inputSchema: {
        course_id: z.union([z.number(), z.string()]).describe('Local Prism course id'),
        assignment_id: z.union([z.number(), z.string()]).describe('Schoology or local assignment id'),
        students: z
          .array(
            z.object({
              student: z.union([z.number(), z.string()]).describe('schoology_uid or local student id'),
              narrative_feedback: z.string().optional(),
              rubric_scores: z.record(z.string(), z.string()).optional().describe('{ topic external_id|title: proficiency level code or name }: levels only; Prism owns the points conversion'),
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
      description: 'Read a rubric by name in portable form: ordered criteria with per-level descriptors and no Prism ids (the JSON twin of the CSV export).',
      inputSchema: { name: z.string().describe('Rubric name (as shown by list_rubrics)') },
    },
    async ({ name }) => ({ content: [{ type: 'text', text: JSON.stringify(readRubric(getDb(), { name })) }] })
  );

  server.registerTool(
    'write_rubric',
    {
      description: 'Create or update a rubric by name. Dedup: if a rubric with identical content already exists (any name), it is reused (no copy) and the result reports { reused_existing, match: "exact" }. If a DIFFERENT rubric already has this name, the write is held back and returns { conflict: "name", ... }: ask the teacher, then re-call with on_name_conflict:"update" (replace it) or "new" (save a separate copy). Criteria are an ordered array (array order = row order). No Prism ids required.',
      inputSchema: {
        name: z.string().describe('Rubric name: the stable handle'),
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
        })).describe('Ordered criteria: the array order is the row order'),
      },
    },
    async ({ name, criteria, on_name_conflict }) => ({ content: [{ type: 'text', text: JSON.stringify(writeRubric(getDb(), { name, criteria, on_name_conflict })) }] })
  );

  server.registerTool(
    'attach_rubric',
    {
      description: "Attach a library rubric (by name) to an assignment, auto-matching its criteria to the assignment's measurement topics. Returns { attached_to, rubric, unmatched_criteria }: finish any unmatched criteria in Prism's Map-criteria tab.",
      inputSchema: {
        rubric_name: z.string().describe('Rubric name (as shown by list_rubrics)'),
        assignment_id: z.union([z.number(), z.string()]).describe('Local Prism assignment id (from list_assignments)'),
      },
    },
    async ({ rubric_name, assignment_id }) => ({ content: [{ type: 'text', text: JSON.stringify(attachRubricTool(getDb(), { rubric_name, assignment_id })) }] })
  );

  // Wraps a tool's result as MCP text content. `thunk` is called (and awaited)
  // inside the try so a thrown TriageError (or anything else carrying a
  // `.code`) gets its code prefixed onto the message — e.g. "NOT_AT_DEADLINE:
  // the resubmission deadline (...) has not passed yet" — before the SDK turns
  // it into the tool's error text, so the agent (and the teacher reading its
  // response) sees which rule fired, not just the sentence.
  async function text(thunk) {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await thunk()) }] };
    } catch (err) {
      if (err && err.code && typeof err.message === 'string' && !err.message.startsWith(`${err.code}:`)) {
        err.message = `${err.code}: ${err.message}`;
      }
      throw err;
    }
  }

  server.registerTool(
    'get_triage',
    {
      description:
        "Late-work referral watch, feedback owed and make-up tests, exactly as Prism's dashboard shows them. " +
        'Every row has `day`: the SCHOOL-day number the dashboard shows, counting the due date = day 1 (test date / extended date = day 1 likewise): ' +
        'quote `day` to the teacher, not the raw counts (daysLate / oldestWaitDays / daysSince = day − 1, kept for compatibility). ' +
        'lateWork: summative work that takes Schoology submissions, not submitted (or submitted after the limit; submittedDay = the day it came in), ' +
        'tone green/amber/red: late work is allowed through day {referralLimitDays} (settings, default 8) and referred after day {referralLimitDays} ' +
        '(red, e.g. day 9); amber = the last warnLeadDays allowed days. feedbackOwed: per assessment, how many submissions are ungraded and `day` of the oldest ' +
        'wait (day 1 = the start of the wait: the due date, or a late student\'s submission date), overdue (red) after day {feedbackLimitDays} (paper/no-dropbox work counts the whole roster as handed in on the due date; a Schoology test ' +
        'whose attempts were read counts only the takers). makeUps: students who missed a Schoology test or quiz ' +
        '(any alignment; no attempt, no score, not excused) and must sit it (or their * copy) ASAP: `day` with the test day = day 1, ' +
        'tone green on the test day, amber from day makeUpAmberDay, red from day makeUpRedDay (the makeUpAmberDay/makeUpRedDay settings); clears itself once an attempt ' +
        'syncs. makeUpsUnchecked: past tests whose attempts could not be read (unknown, NOT missed: suggest a re-sync). ' +
        'makeUpsIgnored: past tests the teacher ignores for make-ups (set_makeup_tracking). ' +
        'Rows carry courseName + blockNumber (sections of one course share a name) and extension ({ id, lessons, until, note } or null; dueDate stays the original). Includes the limits (settings), calendar source (approx = weekday fallback) and lastSyncAt: ' +
        'say when data may be stale. Use for "who is close to referral?", "what should I grade first?" or "who still has to sit the test?". ' +
        'resubmissions: per student × assessment, state "waiting" (asked to resubmit; day 1 = the ask day; limit = lessons + 1, red after `until`; source schoology_unsubmit = the teacher unsubmitted OneDrive work) or "arrived" (a resubmission newer than the last feedback; day 1 = the resubmission date, overdue after day {feedbackLimitDays}; afterDeadline = came in after the ask deadline). Explicit asks show for any alignment; unrequested arrivals follow include_formative. ' +
        "lateWork, makeUps and resubmissions rows also carry studentEmail (the student's school email, null when Prism has none), e.g. for building an email list.",
      inputSchema: {
        course: z.union([z.number(), z.string()]).optional().describe('Course id (list_courses) or a name/code fragment; omit for all current courses'),
        student: z.union([z.number(), z.string()]).optional().describe('Student id or name fragment to filter lateWork and makeUps'),
        include_formative: z.boolean().optional().describe('Include formative work in feedbackOwed (default: the teacher setting)'),
      },
    },
    async (args) => text(() => getTriageTool(getDb(), args))
  );

  server.registerTool(
    'get_submission_status',
    {
      description:
        'Roster-wide submission state for a course, one assignment, or one student: answers "who still hasn\'t submitted X?", ' +
        '"has everyone turned in their summative work?" or "give me an email list of everyone with unsubmitted work". ' +
        "Each item's `status` is one of submitted, not_started, in_progress (OneDrive work in progress), excused (Schoology Excused), " +
        'not_tracked (paper / gradebook-only work with no submission channel, never owing) or unknown (no submission signal synced yet, ' +
        'e.g. OneDrive work or a test whose attempts were not read: NEVER treated as missing, since Prism must not accuse a student on missing data). ' +
        '`owing` is true only for not_started / in_progress AND not yet scored: that is the "still outstanding" set. summative = aligned to measurement ' +
        'topics (summative_only keeps only that work). past_due_only keeps only work whose due date has passed (due today is not yet past due). ' +
        "`emails` is a ready-to-paste Outlook To/Bcc list ('a@x; b@x') for the students in the result who have an email. counts.unknown (with " +
        'unknownHint) tells you when a re-sync would answer more confidently. status "not_submitted" (default) lists only students who owe something, ' +
        'the whole-school view; status "all" lists every item (submitted or not) but needs a course, assignment_id or student, since it can be large. ' +
        'Use list_assignments to find an assignment_id by title (e.g. "the Robotics Notebook 3 PowerPoint").',
      inputSchema: {
        course: z.union([z.number(), z.string()]).optional().describe('Course id (list_courses) or a name/code fragment; omit for all current courses'),
        assignment_id: z.number().optional().describe('Restrict to one assignment (list_assignments); resolves its course automatically'),
        student: z.union([z.number(), z.string()]).optional().describe('Student id or name fragment to restrict to one student'),
        summative_only: z.boolean().optional().describe('Only work aligned to measurement topics (default: all work)'),
        past_due_only: z.boolean().optional().describe('Only assignments whose due date has passed (default: all, including not-yet-due and undated work)'),
        status: z.enum(['not_submitted', 'all']).optional().describe('not_submitted (default): only owing items/students. all: every item; requires course, assignment_id or student'),
      },
    },
    async (args) => text(() => getSubmissionStatusTool(getDb(), args))
  );

  server.registerTool(
    'list_referrals',
    {
      description: 'Triage history, newest first: { referrals: late-work pairs the teacher marked referred (to the academic office), with notes and the clock at the time (`day`, due date = day 1; daysLate = day − 1); extensions: per-student deadline extensions ({ id, lessons, until, note }) }.',
      inputSchema: {
        course: z.union([z.number(), z.string()]).optional().describe('Course id or name/code fragment'),
        student: z.union([z.number(), z.string()]).optional().describe('Student id or name fragment'),
        since: z.string().optional().describe("Only records on/after this date, 'YYYY-MM-DD'"),
      },
    },
    async (args) => text(() => listReferralsTool(getDb(), args))
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
    async (args) => text(() => schoolCalendarTool(getDb(), args))
  );

  server.registerTool(
    'record_referral',
    {
      description: "Record that the teacher referred a late-work row to the academic office ('referred'). ONLY call when the teacher explicitly says so. Use student_id/assignment_id from get_triage lateWork; rejects pairs not currently on the list, and rows not yet past the referral limit (tone red, i.e. day > referralLimitDays) with NOT_AT_LIMIT. To give a student more time use extend_deadline; a true exemption is Schoology's Excused flag.",
      inputSchema: {
        student_id: z.number().describe('lateWork[].studentId'),
        assignment_id: z.number().describe('lateWork[].assignmentId'),
        action: z.enum(['referred']),
        note: z.string().optional().describe('Optional note, e.g. "emailed the academic office"'),
      },
    },
    async (args) => text(() => recordReferralTool(getDb(), args))
  );

  server.registerTool(
    'undo_referral',
    {
      description: 'Undo a referral by its id (from list_referrals or record_referral). The pair returns to the late-work list if still late. Only when the teacher asks.',
      inputSchema: { id: z.number().describe('Referral id') },
    },
    async (args) => text(() => undoReferralTool(getDb(), args))
  );

  server.registerTool(
    'extend_deadline',
    {
      description: "Give one student more time on a summative assignment: extend its due date by N lessons (lessons = SCHOOL days, the referral limit's unit). ONLY call when the teacher explicitly asks. The student is off the late-work list until the extended date (`until`) passes, then counts late from it. Allowed any time (before or after the due date), for summative work or a Schoology test/quiz in a current course that targets the student. Also for make-up tests (a makeUps row): the make-up clock then counts from the extended date (= day 1), e.g. sitting the make-up on Thursday. Extending the same pair again replaces lessons/note. Returns the stored extension. With resubmission_id: moves that request's deadline to N lessons after the ask. " +
        "If the teacher wants the student told (normally yes), call preview_status_line FIRST: kind 'extend_resubmission' with resubmission_id + lessons, or kind 'extension' (ordinary work) / 'make_up' (a Schoology test) with student_id/assignment_id/lessons; it works out the due date; do not compute or draft the line yourself. Show the teacher the returned line and resulting comment, then pass the (possibly teacher-edited) line as comment_line here; it replaces Prism's previous status line in the student's Schoology comment (visible to the student and parents). Omit comment_line for a Prism-only change (as before).",
      inputSchema: {
        student_id: z.number().optional().describe('Student id (lateWork[]/makeUps[].studentId or list_students)'),
        assignment_id: z.number().optional().describe('Assignment id (lateWork[]/makeUps[].assignmentId or list_assignments)'),
        lessons: z.number().int().min(1).max(60).describe('Extension in lessons (school days), 1-60'),
        note: z.string().optional().describe('Optional reason, e.g. "sick for a week"'),
        resubmission_id: z.number().optional().describe('Extend an open resubmission request (get_triage resubmissions[].id) instead of an assignment deadline; then only lessons is used'),
        comment_line: z.string().optional().describe('Exact status line to publish to the student\'s Schoology comment, get it from preview_status_line. Omit for a Prism-only change (as before).'),
      },
    },
    async (args) => text(() => extendDeadlineTool(getDb(), args))
  );

  server.registerTool(
    'undo_extension',
    {
      description: 'Undo a deadline extension by its id (from list_referrals extensions or extend_deadline). The student is measured from the original due date again. Only when the teacher asks. Pass remove_line: true to also remove the status line THIS extension published from the student\'s Schoology comment (only if it is still there verbatim: a teacher hand-edit is left alone). This changes a comment the student and parents can see: confirm with the teacher before passing true.',
      inputSchema: {
        id: z.number().describe('Extension id'),
        remove_line: z.boolean().optional().describe('Also remove the status line this extension published from the Schoology comment, if still present verbatim'),
      },
    },
    async (args) => text(() => undoExtensionTool(getDb(), args))
  );

  server.registerTool(
    'request_resubmission',
    {
      description: "Ask a student to resubmit one assessment, with a deadline in lessons (SCHOOL days; default = the teacher's setting, 3). ONLY when the teacher explicitly asks. Works on graded, comment-only or ungraded work. The pair then shows in get_triage resubmissions as 'waiting' (day 1 = the ask day, red after the deadline `until`) until a resubmission arrives ('arrived'), then clears when the visible feedback changes (a new score, rubric level or visible comment). Rejects a second open request (ALREADY_OPEN). " +
        "If the teacher wants the student told (normally yes), call preview_status_line FIRST with kind 'ask' (same student_id/assignment_id/lessons/note); it works out the due date; do not compute or draft the line yourself. Show the teacher the returned line and resulting comment, then pass the (possibly teacher-edited) line as comment_line here; it is published to the student's Schoology comment (visible to the student and parents), replacing Prism's previous status line. Omit comment_line for a Prism-only request: nothing is written to Schoology. " +
        "OneDrive (LTI) work the student has submitted is also UNSUBMITTED in Schoology by default (`unsubmit`, default true for submitted LTI work, false otherwise): this changes the student's submission in Schoology so they can edit their OneDrive work and submit again; the grade and comment stay. Tell the teacher before you call, and pass unsubmit: false if they don't want it. Prism never re-submits work (Undo of the ask leaves it unsubmitted). Passing unsubmit: true for work that isn't submitted LTI work is rejected (NOT_ELIGIBLE) before anything is written. The result's `unsubmit` reports the outcome: { ok: true } or { ok: false, error, url }; the ask is still recorded; give the teacher the url (the Schoology assignment page with its own Unsubmit button). A 'Schoology connection expired' error means the teacher must reconnect in Prism's Settings.",
      inputSchema: {
        student_id: z.number().describe('Student id (list_students / get_triage rows)'),
        assignment_id: z.number().describe('Assignment id (list_assignments / get_triage rows)'),
        lessons: z.number().int().min(1).max(60).optional().describe('Deadline in lessons (school days) from today'),
        note: z.string().optional().describe('What to fix, e.g. "add the evaluation section"'),
        comment_line: z.string().optional().describe('Exact status line to publish to the student\'s Schoology comment, get it from preview_status_line'),
        unsubmit: z.boolean().optional().describe("Unsubmit the student's OneDrive (LTI) submission in Schoology so they can edit it (changes their submission; never re-submits). Default: true when the work is LTI and submitted, else false"),
      },
    },
    async (args) => text(() => requestResubmissionTool(getDb(), args))
  );

  server.registerTool(
    'grade_stands',
    {
      description: "End an open resubmission request because its deadline passed with no resubmission: the original grade stands. ONLY after the deadline (the get_triage row is red: today after `until`); before that it is rejected (NOT_AT_DEADLINE), extend instead. Only when the teacher asks. id from get_triage resubmissions[].id or list_resubmissions. " +
        "If the teacher wants the student told (normally yes), call preview_status_line FIRST with kind 'grade_stands' and the same resubmission_id; it reads the deadline that passed; do not compute or draft the line yourself. Show the teacher the returned line and resulting comment, then pass the (possibly teacher-edited) line as comment_line here; it is published to the student's Schoology comment (visible to the student and parents), replacing Prism's previous status line. Omit comment_line to publish nothing to Schoology.",
      inputSchema: {
        id: z.number().describe('Resubmission request id'),
        comment_line: z.string().optional().describe('Exact status line to publish to the student\'s Schoology comment, get it from preview_status_line'),
      },
    },
    async (args) => text(() => gradeStandsTool(getDb(), args))
  );

  server.registerTool(
    'preview_status_line',
    {
      description:
        "Compute and preview the status line for request_resubmission / extend_deadline / grade_stands, BEFORE calling any of them with comment_line: the agent cannot reliably work out the school-day due date a line embeds, so this renders it server-side using the same calendar rule the real action uses, instead of you drafting the line. " +
        "`kind` picks the rule and matches the tool you are about to call: 'ask': addSchoolDays(today, lessons ?? the teacher's default), for request_resubmission (needs student_id, assignment_id; lessons/note optional). " +
        "'extend_resubmission': addSchoolDays(the open request's ask date, lessons), for extend_deadline with resubmission_id (needs resubmission_id, lessons; note optional). " +
        "'grade_stands': the open request's own deadline (no calendar math), for grade_stands (needs resubmission_id only). " +
        "'extension': addSchoolDays(the assignment's due date, lessons), for extend_deadline on ordinary summative work (needs student_id, assignment_id, lessons; note optional). " +
        "'make_up': same rule as extension, for a Schoology test/quiz (needs student_id, assignment_id, lessons; note optional). " +
        "Templates (date as `Ddd DD/MM`, e.g. `Thu 09/10`; `{note}` and its leading space omitted when there is no note; plain ASCII, no special characters; an edited comment_line is held to the same rule: curly quotes, dashes, … and odd spaces become plain ASCII, and any other non-ASCII character is refused with BAD_LINE): ask: `Resubmission requested - due {Ddd DD/MM}. {note}`; extend_resubmission: `Resubmission requested - now due {Ddd DD/MM}. {note}`; grade_stands: `Resubmission deadline ({Ddd DD/MM}) passed - your grade stands.`; extension: `Extension - now due {Ddd DD/MM} ({n} lessons). {note}`; make_up: `Make-up - sit by {Ddd DD/MM}. {note}`. " +
        "Does a fresh Schoology read only, nothing is written. Returns { line, until, currentComment, visible, storedLine, resultingComment, hiddenWarning, normalisedLine, lineProblem }: `line` is Prism's rendered suggestion and `until` the computed deadline; resultingComment is exactly what the comment would become; hiddenWarning is true when the current comment is hidden from the student but holds the teacher's own text (so publishing would make it visible). normalisedLine is the candidate line exactly as it would be published (typographic characters made plain ASCII); lineProblem is 'BAD_LINE' (with lineProblemMessage) when publishing would refuse it, e.g. a non-ASCII character or a line break, else null: fix the line before publishing. " +
        "To check a teacher's edit instead of Prism's wording, pass that text as `line` in the input: resultingComment then previews it, while the response's `line` still returns Prism's original suggestion for comparison. Show the teacher the line and resultingComment before passing comment_line to the publishing tool.",
      inputSchema: {
        student_id: z.number().optional().describe('Student id: required for kind ask, extension, make_up'),
        assignment_id: z.number().optional().describe('Assignment id: required for kind ask, extension, make_up'),
        kind: z.enum(['ask', 'extend_resubmission', 'grade_stands', 'extension', 'make_up']).describe('Which action/template to render: matches the publishing tool you are about to call'),
        lessons: z.number().int().min(1).max(60).optional().describe('Lessons (school days): required for extend_resubmission/extension/make_up, optional for ask (defaults to the teacher setting), unused for grade_stands'),
        note: z.string().optional().describe('Optional note to append: ask, extend_resubmission, extension, make_up only'),
        resubmission_id: z.number().optional().describe('Required for kind extend_resubmission and grade_stands (get_triage resubmissions[].id)'),
        line: z.string().optional().describe("Preview this exact text instead of Prism's rendered suggestion (e.g. the teacher's edit); the response's `line` still returns the suggestion"),
      },
    },
    async (args) => text(() => previewStatusLineTool(getDb(), args))
  );

  server.registerTool(
    'list_resubmissions',
    {
      description: "Resubmission history, newest first: asks ('asked' = open, with lessons/until/note; 'grade_stands' = deadline passed, grade stands; 'done' = resubmitted and given new visible feedback; 'undone' = an auto-added request the teacher undid; 'closed' = closed for another reason, e.g. the course was archived). source 'schoology_unsubmit' = auto-added because the teacher unsubmitted graded OneDrive work in Schoology.",
      inputSchema: {
        course: z.union([z.number(), z.string()]).optional(),
        student: z.union([z.number(), z.string()]).optional(),
        since: z.string().optional().describe("'YYYY-MM-DD'"),
        state: z.enum(['asked', 'grade_stands', 'done', 'undone', 'closed']).optional(),
      },
    },
    async (args) => text(() => listResubmissionsTool(getDb(), args))
  );

  server.registerTool(
    'set_makeup_tracking',
    {
      description: "Turn make-up tracking off (tracked: false) or back on (tracked: true) for one Schoology test or quiz, for ALL students, e.g. a formative quiz nobody has to re-sit. Only when the teacher asks. An ignored test lists nobody in get_triage makeUps (counted in makeUpsIgnored). Use makeUps[].assignmentId. Rejects anything that isn't a Schoology test in a current course (NOT_ELIGIBLE).",
      inputSchema: {
        assignment_id: z.number().describe('Assignment id of the test/quiz (makeUps[].assignmentId or list_assignments)'),
        tracked: z.boolean().describe('false = ignore it for make-ups; true = track it again'),
      },
    },
    async (args) => text(() => setMakeupTrackingTool(getDb(), args))
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
