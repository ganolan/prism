import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../server/db/index.js';
import { getAssessmentContext } from '../server/services/assessmentContext.js';
import { writeStudentSuggestions, upsertAssessmentAnalysis } from '../server/services/suggestions.js';
import { getAssignmentContextTool, listCourses, listAssignments, listStudents, listRubricsTool, readRubric, writeRubric, attachRubricTool, findStudentTool, getStudentHistoryTool, getSupportSummaryTool, listQuizGroupsTool, loadQuizResultsTool, setQuestionTagsTool, getTagResultsTool, getFrqResponsesTool, writeFrqSuggestionsTool, listFrqWritebacksTool, markFrqWritebackTool, getQuizResultsTool, writeQuizOverallSuggestionsTool } from './handlers.js';
import {
  getTriageTool, listReferralsTool, schoolCalendarTool, recordReferralTool, undoReferralTool, extendDeadlineTool, undoExtensionTool,
  setMakeupTrackingTool,
  requestResubmissionTool, gradeStandsTool, listResubmissionsTool, previewStatusLineTool,
  getSubmissionStatusTool,
} from './handlers.js';
import { ALERT_DEFS } from '../server/lib/psAlerts.js';
import { DEV_COPY_WARNING } from './devCopy.js';

// #117: the PowerSchool alert fields list_students and get_assignment_context add per
// student (when powerschool_alerts is on in config.yaml). Labels only, per ADR 0002.
const ALERT_KEYS_BY_CATEGORY = ['learning', 'health', 'other', 'family']
  .map((c) => `${c}: ${ALERT_DEFS.filter((d) => d.category === c).map((d) => d.key).join(', ')}`).join('; ');
const POWERSCHOOL_ALERTS_NOTE =
  `Each student also has \`powerschool_alerts\` [{ key, label, category }]: the PowerSchool alerts Prism keeps (${ALERT_KEYS_BY_CATEGORY}), as of \`powerschool_alerts_read_at\` (ISO, read on each sync; null = never read, so an empty list then means unknown, not none). ` +
  'They say a plan or alert exists, not what it contains (e.g. how much extra time): for a student with support_summary, get_support_summary reads the Student Support Summary live (extra time is in its Support Notes); otherwise check PowerSchool for the detail. They are labels for the teacher only: use them for the teacher\'s decisions (who needs accommodations in a test; which guardian gets correspondence); never put them in student feedback or anything a student or parent reads. Family alerts (correspondence, divorced, employee_child, siblings) are especially private.';

// <2KB tool-search hint (spec §3.4) so a client knows when to surface PrisMCP.
export const INSTRUCTIONS =
  "Read a Prism-tracked course/assignment's roster, rubric measurement-topics, " +
  'and current grades, and write AI grading suggestions back into Prism for ' +
  'teacher review. Use when grading student work for a course managed in Prism. ' +
  'Also triage: which students are approaching an academic-office referral for ' +
  'late summative work, which assessments have waited longest for feedback, ' +
  'which students missed a Schoology test and must sit a make-up test ' +
  '(all in school days, numbered with the due/test date as day 1), and ' +
  'school-calendar arithmetic. Also a student\'s full history across every ' +
  'course and year with the teacher (archived included), with the teacher\'s ' +
  'levels and comments verbatim, e.g. for reference letters. Also linked ' +
  'quizzes: per-question results of Schoology tests that Prism combined, and ' +
  'tags per question; get_tag_results follows one tag across a course. FRQ marking: get_frq_responses, write_frq_suggestions, then the teacher accepts in Prism; ' +
  'the teacher publishes accepted marks with Publish all to Schoology on the Free response tab; ' +
  'list_frq_writebacks and mark_frq_writeback are the fallback when that button is absent. Overall result: get_quiz_results, then ' +
  'write_quiz_overall_suggestions (levels and an impression; Prism builds the comment).';

// A tool that waits for a queue run tells the client it is alive: an MCP progress notification
// (every 10 s, from gradingSync's onProgress) when the request carries a progressToken. → a
// function for the tool's onProgress, or undefined when the client did not ask.
export function progressNotifier(extra) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || typeof extra?.sendNotification !== 'function') return undefined;
  return ({ runId, waitedMs }) => Promise.resolve(extra.sendNotification({
    method: 'notifications/progress',
    params: { progressToken, progress: waitedMs, message: `Waiting for the Schoology sync (run ${runId}), ${Math.round(waitedMs / 1000)} s so far` },
  })).catch(() => {});
}

// Open the shared Prism DB (resolved relative to server/db, honoring DB_PATH)
// and set busy_timeout so a brief write collision retries rather than throwing
// SQLITE_BUSY under WAL. The Prism server hosts PrisMCP at /mcp (server/routes/mcp.js)
// on its own connection; this helper is for tests and scripts that open a database
// themselves (scripts/parity-prismcp-http.js). Returns the shared getDb() singleton,
// the same connection the tool handlers query.
export function connectDb() {
  const db = getDb();
  db.pragma('busy_timeout = 5000');
  return db;
}

export { DEV_COPY_WARNING };

// Build the PrisMCP server with all tools/resources/prompts registered. Pure
// construction — no transport, no DB side effects — so tests can drive it over
// an in-memory transport against a seeded :memory: DB. `devCopy` (a server that
// is not a deployed release): every tool result starts with DEV_COPY_WARNING,
// and the tools that write to Schoology refuse (handlers.js assertSchoologyWritable).
export function createServer({ devCopy = false } = {}) {
  const server = new McpServer(
    { name: 'prism', version: '0.1.0' },
    { instructions: INSTRUCTIONS }
  );

  if (devCopy) {
    // Wrap every tool so its result, an error too, leads with the warning. (Arguments the SDK
    // rejects before a tool runs are not wrapped: nothing ran.)
    const register = server.registerTool.bind(server);
    server.registerTool = (name, config, cb) => register(name, config, async (...args) => {
      let result;
      try {
        result = await cb(...args);
      } catch (err) {
        result = { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
      }
      return { ...result, content: [{ type: 'text', text: DEV_COPY_WARNING }, ...result.content] };
    });
  }

  server.registerTool(
    'list_courses',
    {
      description: 'List active (non-archived) Prism courses, to resolve which class to grade. Sections of one course share a name: block_number tells them apart. include_archived: true adds archived (past) courses, each with school_year (e.g. "2024-25"), term and archived: true.',
      inputSchema: { include_archived: z.boolean().optional().describe('Also list archived (past) courses. Default false.') },
    },
    async ({ include_archived } = {}) => ({ content: [{ type: 'text', text: JSON.stringify(listCourses(getDb(), { include_archived })) }] })
  );

  server.registerTool(
    'list_assignments',
    {
      description:
        "List a course's assignments (with aligned-topic + latest-submission hints) to resolve which assignment to grade. `score_scale` names the Schoology scale an unaligned assignment is graded on (e.g. \"Completion Scale\"), null for rubric-graded ones. `feedback_rubric` names the rubric attached to an unaligned assignment as feedback rows (null otherwise).",
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
        "List a course's current roster (non-dropped enrolments), independent of any assignment, e.g. to check a meeting attendance list against who's enrolled. Works for archived course ids too (list_courses include_archived). include_dropped: true appends students who left, each with dropped_at. " + POWERSCHOOL_ALERTS_NOTE,
      inputSchema: {
        course_id: z.union([z.number(), z.string()]).describe('Local Prism course id'),
        include_dropped: z.boolean().optional().describe('Also list students who dropped the course. Default false.'),
      },
    },
    async ({ course_id, include_dropped }) => ({
      content: [{ type: 'text', text: JSON.stringify(listStudents(getDb(), { course_id, include_dropped })) }],
    })
  );

  server.registerTool(
    'get_assignment_context',
    {
      description:
        'Every call first runs a fresh Schoology sync of this task and waits for it (usually under a minute; longer behind a sync already running), so the data is never older than the call: task details, submissions and grades, mastery levels and grade comments, the comment threads and the files of every student who uploaded. Only a task whose last such sync finished under 5 minutes ago is not read again. The answer carries `data_as_of` (ISO, when the task\'s data was last read) and `context_id` (integer, this read): pass that `context_id` to write_student_suggestions, so the suggestions record the data you graded from. ' +
        'If the answer is an error that starts SYNC_PENDING, the sync is still running: call get_assignment_context again with the same arguments (it follows the same run). SYNC_FAILED names the run and the reason: tell the teacher what failed. They may retry (call again to start a new sync), or, if a read keeps failing, choose `use_stored_data: true`, which returns the data Prism already holds with the `stale_data` warning; never choose stored data yourself. ' +
        'SESSION_LAPSED means Prism is signed out of Schoology, so it cannot read the latest data: tell the teacher and give them the sign-in link in the error. Ask them (never decide yourself) whether to sign in and call again, or to call again with `use_stored_data: true`, which skips the sync and answers from the data Prism already holds; that answer begins with `stale_data` ("Data as of <time>. Sign in to Schoology for a fresh sync."): say so to the teacher, and grade only if they chose it. NOT_FOUND means no such assignment, or a `course_id` that is not the assignment\'s course (the error names the right one). ' +
        'Load an assignment\'s roster, aligned measurement topics (rubric skeleton); or, for an unaligned assignment, its `score_scale` (levels best → worst) and each student\'s `current_scale_level`; when that assignment has a rubric attached, also `rubric` { name, rows: [{ criterion, standard, category, descriptors }] } and each student\'s `current_row_levels` { criterion: level } (the teacher\'s published row levels; feedback rows are Prism-only and never sent to Schoology), with draft_feedback.row_levels and draft_feedback.scale_level (scale_level_source: teacher | rubric_average); current finals/comments/display-status, any existing AI suggestions, and the teacher\'s in-progress unpublished draft (draft_feedback: their staged proficiency picks, removed topics, comment, and display-to-student toggle), to grade against. Each student\'s `exception` is Schoology\'s grade flag on the task: 0 none, 1 Exempt, 2 Incomplete, 3 Missing, 5 Absent, 6 Late. Exempt and Missing are final: grading is complete for that student, and suggestions written for them are not staged on the teacher\'s card, so skip them. Late, Incomplete and Absent are markers: grade the work as usual; publishing the grade clears the flag in Schoology. Address each student in feedback by their roster `preferred_first_name` (the teacher-honored display name); `first_name`/`last_name` are the legal name, for matching submissions. Each student\'s `submission_timeline` is the full submission picture, as on the /assessment/ card: due (+ extension: school days and the date it moved to), submission { state (submitted | in_progress | not_started | not_submitted | excused (= Schoology\'s Exempt flag) | untracked = paper work | not_assigned = sits the other test copy | unknown = no signal synced, never treat as overdue or not submitted), firstSubmittedAt / latestSubmittedAt (ISO), late (judged against any extension; null = unknown), schoolDaysLate (school days after the deadline it came in; say this to the teacher, never "day N", which reads as a timetable cycle day), day (the same as a clock day = schoolDaysLate + 1), lateMinutes (late on the due date itself), schoologyLate (Schoology\'s own submission-timing flag, which ignores Prism extensions), flagged (the teacher\'s Late flag, Schoology exception 6: set by hand, removes the grade, says nothing about when the work came in, and never changes `late`) }, overdue { schoolDaysOverdue, day, overLimit } for work past its due date with nothing submitted, resubmission { askedOn, until, arrivedOn, afterDeadline } and referral { on, day }. Day numbers are the triage clock: SCHOOL days, the due date (or extended date) = day 1, the teacher\'s referral limit (default 8) the last allowed day. Each student\'s `submission_comments` is their Schoology submission comment thread, oldest first: [{ id, author_uid, author_role (student | teacher | other), created (ISO), text, is_automatic (only Schoology\'s own "Revision N submitted" line), student_text (what the student typed in the comment box, or null), attachments [{ filename, filemime, filesize }] (files on that comment; is_automatic is false when a student attached one) }]; students often answer the task\'s written questions there, or attach a file, so read every student_text, and treat every student attachment, as part of the submission (evidence for the rubric). Prism lists the files but does not return their content; download them with the Schoology API (the same comments call with ?with_attachments=1 gives download_path). Threads of submitted students are read from Schoology by the sync above; `submission_comments_source` { refreshed, failed, cached_only, note } states whether that happened (cached_only: true = as last read, with the reason in `note`), and `submission_comments_read_at` (ISO, null = never read) when each was read. ' +
        'Each student\'s `submission_files` is what they uploaded to the Schoology dropbox, every revision, newest first: [{ filename, filemime, extension, filesize (bytes), revision_id, submitted_at (ISO, the revision), late (Schoology\'s flag for that revision), draft, latest (true on the newest revision\'s files: the work to grade unless the teacher says otherwise) }]. Prism lists the files but does not return their content; download them with the Schoology API (`/v1/sections/{section}/submissions/{assignment}/{uid}?with_attachments=1` gives each file\'s download_path, which needs the OAuth signature). Every student the sync saw upload is read from Schoology by the sync above; `submission_files_source` { refreshed, failed, cached_only, note } states whether that happened, and `submission_files_read_at` (ISO, null = never read, so an empty list then means unknown, not none) when each was read. On a OneDrive or Google Drive task `submission_files` is empty (the work is the student\'s own copy there). ' +
        'The current levels and grade comments are read by the sync above; `mastery_source` { refreshed, synced_at (ISO, when they were last read), cached_only, note } states whether that happened, so a level the teacher set in Schoology today is included. ' + POWERSCHOOL_ALERTS_NOTE,
      inputSchema: {
        course_id: z.union([z.number(), z.string()]).describe('Local Prism course id'),
        assignment_id: z.union([z.number(), z.string()]).describe('Schoology or local assignment id'),
        use_stored_data: z.boolean().optional().describe('Skip the Schoology sync and answer from the data Prism holds, with a stale_data warning. Only when the teacher chose it, after SESSION_LAPSED or a SYNC_FAILED they do not want to retry. Default false.'),
      },
    },
    async ({ course_id, assignment_id, use_stored_data }, extra) => text(() => getAssignmentContextTool(
      getDb(), { course_id, assignment_id, use_stored_data }, { syncOptions: { onProgress: progressNotifier(extra) } },
    ))
  );

  server.registerTool(
    'write_student_suggestions',
    {
      description:
        'Write AI grading suggestions (narrative + per-topic levels + reviewer flags) for a whole class in one batched call. For an assignment with a `score_scale` (Completion, General Academic Scale (Unaligned), Approaches to Learning) and no `rubric`, send `scale_level` instead of rubric_scores, e.g. after checking a third-party platform, "Completed" plus an `evidence` note saying what you checked. When get_assignment_context also returns a `rubric` (feedback rows), send each row\'s level in `rubric_scores` keyed by the row\'s `criterion`; Prism stages the rubric average as the overall level, so send `scale_level` only when your judgment differs from that average or a row is Insufficient Evidence. Upserts one draft suggestion per student for teacher review in Prism (the teacher accepts and publishes); never writes to Schoology. Pass the `context_id` of the get_assignment_context answer you graded from: Prism records that answer\'s data time on each suggestion, so the teacher is warned only when you graded from old data (a `context_id` of another assignment is refused for every student; an unknown one falls back to the oldest read of the task in the last 3 hours, and the result\'s top-level `note` says so).',
      inputSchema: {
        course_id: z.union([z.number(), z.string()]).describe('Local Prism course id'),
        assignment_id: z.union([z.number(), z.string()]).describe('Schoology or local assignment id'),
        context_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]).nullish().describe('The context_id of the get_assignment_context answer you graded from'),
        students: z
          .array(
            z.object({
              student: z.union([z.number(), z.string()]).describe('schoology_uid or local student id'),
              narrative_feedback: z.string().optional(),
              rubric_scores: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('{ topic external_id|title, or a feedback row\'s criterion: proficiency level code or name }: levels only; Prism owns the points conversion'),
              reviewer_flags: z.string().nullable().optional().describe('Teacher-facing detail, one paragraph per flag'),
              reviewer_flags_brief: z.array(z.string()).optional().describe('One short line per reviewer flag (~12 words each), shown at a glance above strengths/suggestions; the full reviewer_flags text sits behind "Show detailed flags". Without it Prism shows the first sentence of each flag paragraph.'),
              strengths: z.array(z.string()).optional(),
              suggestions: z.array(z.string()).optional(),
              scale_level: z.string().optional().describe('Score-scale assignments only: a level code or label from get_assignment_context score_scale, e.g. "Completed". With feedback rows, only when it differs from the rubric average or a row is IE'),
              evidence: z.string().optional().describe('Teacher-facing note on what backs scale_level, e.g. "Codecademy: lesson 4 complete 26/09"'),
            })
          )
          .describe('Whole-class batch, one entry per student'),
      },
    },
    async ({ assignment_id, students, context_id }) => ({
      content: [{ type: 'text', text: JSON.stringify(writeStudentSuggestions(getDb(), { assignmentId: assignment_id, students, contextId: context_id == null ? undefined : Number(context_id) })) }],
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
    'list_quiz_groups',
    {
      description: 'List the quiz groups in a course: each is one or more Schoology tests Prism treats as one quiz, with its member tests, the linked result task (if any), parity status and when results were last loaded.',
      inputSchema: { course: z.union([z.number(), z.string()]).describe('Local course id, or a course name or code fragment') },
    },
    async ({ course }) => text(() => listQuizGroupsTool(getDb(), { course }))
  );

  server.registerTool(
    'load_quiz_results',
    {
      description: "Read the group's attempts from Schoology through the saved browser session. Sends nothing to Schoology. Stores the attempts and responses in Prism, replacing any earlier load, and records when they were loaded. An attempt deleted in Schoology (its results row now reads not attempted) is removed from Prism. Takes about a minute for a class, and runs in Prism's sync queue, so it waits its turn behind a running sync and never reads beside one. Returns { summary: { attempts (number), notTaken (number), failed: [{uid, reason}], unknownUids: [uid], mismatches: [text], multipleAttempts: [uid], removed (number: stored attempts dropped because Schoology no longer has them), marksPosted (number: accepted FRQ marks that Schoology now shows, so recorded as posted) } }. Fails with NO_SESSION (the teacher must reconnect Schoology in Prism's Settings), UNREACHABLE (Schoology could not be reached, which says nothing about the session: try again) BUSY (this quiz is loading, or Prism is posting its marks to Schoology) or PENDING (still loading after about 50 seconds: the error carries the sync run id; call load_quiz_results again to join the same run).",
      inputSchema: { group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups') },
    },
    async ({ group_id }) => text(() => loadQuizResultsTool(getDb(), { group_id }))
  );

  server.registerTool(
    'set_question_tags',
    {
      description: "Set free-text tags on a quiz group's questions by question number, for example College Board codes from the test's Codes.csv: { \"1\": [\"CRD-2.G\"], \"2\": [\"AAP-1.A\", \"AAP-1.B\"] }. Replaces each listed question's tags. " +
        "texts gives each tag's full wording for the course (for AP CSP, the learning objective or essential knowledge text from the CED), which the teacher sees when hovering over the tag: { \"CRD-2.G\": \"Describe the purpose of a code segment or program.\" }. An empty text removes it. Either argument may be given alone. " +
        "Returns { updated, unknownPositions, textsSaved (only when texts was given) }.",
      inputSchema: {
        group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups'),
        tags: z.record(z.string(), z.array(z.string())).optional().describe('{ question number: [tag, ...] }'),
        texts: z.record(z.string(), z.string()).optional().describe('{ tag: full text }, stored for the group\'s course'),
      },
    },
    async ({ group_id, tags, texts }) => text(() => setQuestionTagsTool(getDb(), { group_id, tags, texts }))
  );

  server.registerTool(
    'get_tag_results',
    {
      description: "One question tag across every quiz group in a course, from Prism's stored copy (no Schoology request), counted over MCQs only, as the Questions tab counts tags (blanks count as wrong). " +
        'Returns { tag, text (its stored full wording, or null), overall: { correct, total, percent }, ' +
        'tests: [{ group_id, title, date, takers, correct, total, percent, questions: [{ position, correct, total, percent }] }] in date order, ' +
        'students: [{ student_id, name, correct, total, percent, tests: { group_id: { correct, total } } }] lowest percent first, ' +
        'courseTags: [every MCQ tag in the course, most questions first] }. Use it to follow one learning objective over several tests, or to find who has not met it.',
      inputSchema: {
        course: z.union([z.number(), z.string()]).describe('Local course id, or a course name or code fragment'),
        tag: z.string().describe('The tag exactly as set with set_question_tags, for example "CRD-2.G"'),
      },
    },
    async ({ course, tag }) => text(() => getTagResultsTool(getDb(), { course, tag }))
  );

  server.registerTool(
    'get_frq_responses',
    {
      description: "Read a quiz group's free-response answers from Prism's stored copy (no Schoology request). For each FRQ: the stem and the Schoology rubric (rows, level names, points, descriptions). For each student: the MCQ score, the attempt URL, and per FRQ the answer as plain text with line breaks kept, Schoology's current mark (level per row, comment), and any Prism mark (state suggested/accepted/edited, the suggestion, the teacher's final mark, write-back pending/posted/failed). Load the results first (load_quiz_results) if they are old.",
      inputSchema: {
        group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups'),
        question: z.number().optional().describe('One FRQ by question number; omit for every FRQ'),
      },
    },
    async ({ group_id, question }) => text(() => getFrqResponsesTool(getDb(), { group_id, question }))
  );

  server.registerTool(
    'write_frq_suggestions',
    {
      description: 'Write suggested FRQ marks for teacher review in Prism (never sent to Schoology). Per student: cells as { rubric row title or id: level name } (for example { "Content Knowledge": "Exhibiting" }), or level alone for a one-row rubric, or points for an FRQ without a rubric; and a student-facing comment. Levels are names or codes (ED, EX, D, EM), never numbers: Prism converts them to points. A new suggestion replaces the earlier one and never changes a mark the teacher accepted or edited; if it differs, the teacher sees it as a revised suggestion. Returns { written, results: [{ student, status: written|error, message }] }.',
      inputSchema: {
        group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups'),
        question: z.number().describe('FRQ question number'),
        students: z.array(z.object({
          student: z.union([z.number(), z.string()]).describe('schoology_uid or local student id'),
          cells: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('{ rubric row title or id: level name }'),
          level: z.string().optional().describe('Level name, for a one-row rubric'),
          points: z.number().optional().describe('Points, for an FRQ without a rubric'),
          comment: z.string().describe('Student-facing feedback on this answer'),
        })),
      },
    },
    async ({ group_id, question, students }) => text(() => writeFrqSuggestionsTool(getDb(), { group_id, question, students }))
  );

  server.registerTool(
    'list_frq_writebacks',
    {
      description: "FRQ marks the teacher accepted or edited that Schoology does not show yet (write-back pending or failed): student, question number, the attempt URL to open, the level and points per rubric row, and the comment to enter. After entering one in Schoology, record it with mark_frq_writeback; the next load_quiz_results also detects it. While Prism's quiz write-back is on, the teacher publishes these with Publish all to Schoology on the Free response tab; use this list for a mark it reports as \"Post this one by hand\", or when the teacher asks.",
      inputSchema: { group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups') },
    },
    async ({ group_id }) => text(() => listFrqWritebacksTool(getDb(), { group_id }))
  );

  server.registerTool(
    'mark_frq_writeback',
    {
      description: 'Record that an accepted FRQ mark was entered in Schoology (status posted), or that entering it failed (status failed, with error). Only for a mark listed by list_frq_writebacks. Refused for a mark that is not waiting to post or failed.',
      inputSchema: {
        group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups'),
        student: z.union([z.number(), z.string()]).describe('schoology_uid or local student id'),
        question: z.number().describe('FRQ question number'),
        status: z.enum(['posted', 'failed']),
        error: z.string().optional().describe('What went wrong, for status failed'),
      },
    },
    async ({ group_id, student, question, status, error }) => text(() => markFrqWritebackTool(getDb(), { group_id, student, question, status, error }))
  );

  server.registerTool(
    'get_quiz_results',
    {
      description: "A quiz group's results per student from Prism's stored copy (no Schoology request), for suggesting the overall result on the linked result task: the MCQ score (correct, total, percent), percent correct per tag, each FRQ's confirmed level (the teacher's Prism mark, else Schoology's own mark) or why it is not confirmed (to review, not marked), ready, any existing overall suggestion (levels, impression, stale), the result task's measurement topics, the comment template, and the students who have not taken it. Reading it records the results' load time (`loaded_at`), so write_quiz_overall_suggestions stamps the suggestion with the age of the results you graded from. Apply the course's cut-off guide to these numbers, then call write_quiz_overall_suggestions.",
      inputSchema: { group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups') },
    },
    async ({ group_id }) => text(() => getQuizResultsTool(getDb(), { group_id }))
  );

  server.registerTool(
    'write_quiz_overall_suggestions',
    {
      description: 'Write the overall result of a quiz as suggestions on its linked result task, for teacher review in Prism (never sent to Schoology). Per student: rubric_scores as { topic external_id or title: level name or code } (levels only; Prism owns the points) and a short student-facing impression (British spelling, one to three sentences). Prism builds the comment from the group template, so the MCQ score and FRQ levels always match its data: do not repeat the numbers in the impression. Refused for a student whose FRQs are not all confirmed (accept them on the Free response tab first) or who has no attempt. Returns { written, results: [{ student, status: written|error, message }] }.',
      inputSchema: {
        group_id: z.union([z.number(), z.string()]).describe('Quiz group id from list_quiz_groups'),
        students: z.array(z.object({
          student: z.union([z.number(), z.string()]).describe('schoology_uid or local student id'),
          rubric_scores: z.record(z.string(), z.union([z.string(), z.number()])).describe('{ topic external_id|title: proficiency level code or name }'),
          impression: z.string().describe('Student-facing overall impression; Prism adds the numbers and the line about the attempt'),
          reviewer_flags: z.string().nullable().optional().describe('Teacher-facing detail, one paragraph per flag'),
          reviewer_flags_brief: z.array(z.string()).optional().describe('One short line per reviewer flag'),
        })),
      },
    },
    async ({ group_id, students }) => text(() => writeQuizOverallSuggestionsTool(getDb(), { group_id, students }))
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
      description: "Attach a library rubric (by name) to an assignment. On an aligned assignment its criteria are auto-matched to the measurement topics; returns { attached_to, rubric, unmatched_criteria }: finish any unmatched criteria in Prism's Map-criteria tab. On an unaligned assignment graded on a score scale (e.g. General Academic Scale (Unaligned)), every criterion becomes a feedback row: rows are marked in Prism and never sent to Schoology, and only the overall scale level is published. Returns { attached_to, rubric, mode: 'feedback_rows', score_scale, rows, hidden_row_levels } (hidden_row_levels counts stored row levels whose names are not rows of the new rubric).",
      inputSchema: {
        rubric_name: z.string().describe('Rubric name (as shown by list_rubrics)'),
        assignment_id: z.union([z.number(), z.string()]).describe('Schoology or local assignment id'),
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
        "Late-work referral watch, feedback owed, make-up tests and Schoology flags waiting on the teacher, exactly as Prism's dashboard shows them. " +
        'Every row has `day`, a clock position in SCHOOL days counting the due date = day 1 (test date / extended date = day 1 likewise). ' +
        'The dashboard no longer shows day numbers (they read as timetable cycle days): it shows the distance, day − 1, e.g. day 9 = "8 school days late", ' +
        'and its limits as "refer at 8 school days late" / "feedback overdue at 10 school days waiting". Say it that way to the teacher, never "day N". ' +
        'quote `day` to the teacher, not the raw counts (daysLate / oldestWaitDays / daysSince = day − 1, kept for compatibility). ' +
        'lateWork: summative work that takes Schoology submissions, not submitted (or submitted after the limit; submittedDay = the day it came in), ' +
        'tone green/amber/red: late work is allowed through day {referralLimitDays} (settings, default 8) and referred after day {referralLimitDays} ' +
        '(red, e.g. day 9); amber = the last warnLeadDays allowed days. feedbackOwed: per assessment, how many submissions are ungraded (only Schoology\'s Exempt (1) and Missing (3) flags count as handled; work flagged Late (6), Incomplete (2) or Absent (5) still owes feedback until graded) and `day` of the oldest ' +
        'wait (day 1 = the start of the wait: the due date, or a late student\'s submission date), overdue (red) after day {feedbackLimitDays} (paper/no-dropbox work counts the whole roster as handed in on the due date; a Schoology test ' +
        'whose attempts were read counts only the takers). makeUps: students who missed a Schoology test or quiz ' +
        '(any alignment; no attempt, no score, not exempt) and must sit it (or their * copy) ASAP: `day` with the test day = day 1, ' +
        'tone green on the test day, amber from day makeUpAmberDay, red from day makeUpRedDay (the makeUpAmberDay/makeUpRedDay settings); clears itself once an attempt ' +
        'syncs. makeUpsUnchecked: past tests whose attempts could not be read (unknown, NOT missed: suggest a re-sync). ' +
        'makeUpsIgnored: past tests the teacher ignores for make-ups (set_makeup_tracking). ' +
        'Rows carry courseName + blockNumber (sections of one course share a name) and extension ({ id, lessons (= school days), until, note } or null; dueDate stays the original). Includes the limits (settings), calendar source (approx = weekday fallback) and lastSyncAt: ' +
        'say when data may be stale. Use for "who is close to referral?", "what should I grade first?" or "who still has to sit the test?". ' +
        'resubmissions: per student × assessment, state "waiting" (asked to resubmit; day 1 = the ask day; limit = lessons (school days) + 1, red after `until`; source schoology_unsubmit = the teacher unsubmitted OneDrive work) or "arrived" (a resubmission newer than the last feedback; day 1 = the resubmission date, overdue after day {feedbackLimitDays}; afterDeadline = came in after the ask deadline). Shown for any alignment (include_formative does not apply). ' +
        'flags: Schoology flags waiting on the teacher, one row per student and task, because on this account a flag leaves the task out of the grade until the teacher acts (#174). ' +
        'kind "flag": Late (6), Incomplete (2) and Absent (5) always, Missing (3) only when the student submitted after the flag (submittedAfter); Exempt (1) never appears. ' +
        'kind "saved_grade": the flag was cleared and the grade Prism saved is not restored yet. `day` counts school days from the flag date (flagSeenOn = day 1; for saved_grade the day the grade was saved); ' +
        'tone follows semesterEnd, the end of the semester that contains the task\'s due date: amber over its last 10 school days, red over the last 5 and after it (an ended semester stays red; null = no term known, green). ' +
        '`advice` is the one line to give the teacher. Flagged work also keeps its lateWork, makeUps and feedbackOwed rows. counts.flagsOverdue = red flags rows. ' +
        "lateWork, makeUps and resubmissions rows also carry studentEmail (the student's school email, null when Prism has none), e.g. for building an email list. " +
        'unfinishedGrading: unfinished grading work with no clock, per assessment (any alignment): drafts = students with grades or a comment entered in Prism but not yet published to Schoology (a live draft; one Schoology changed under is left out), feedbackHidden = students with a teacher comment in Schoology they cannot see (Display to student off), unreadComments = students who typed or attached something in the submission comment thread since the teacher last opened it in Prism; students[] names each with its reasons (draft, feedback_hidden, unread_comment). Tasks with a draft come first, oldest draft (oldestDraftOn) first. Use for "what have I left unfinished?".',
      inputSchema: {
        course: z.union([z.number(), z.string()]).optional().describe('Course id (list_courses) or a name/code fragment; omit for all current courses'),
        student: z.union([z.number(), z.string()]).optional().describe('Student id or name fragment to filter lateWork, makeUps, resubmissions, flags and unfinishedGrading'),
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
        "Each item's `status` is one of submitted, not_started, in_progress (OneDrive work in progress), excused (Schoology's Exempt flag, code 1, the only flag that means the student is not doing the task; the other flags are 2 Incomplete, 3 Missing, 5 Absent and 6 Late: each removes the grade or counts it as zero, but Prism treats the work as still owed, and Absent in particular is a marker that changes nothing in Prism's tracking. For grading, only Exempt and Missing count as handled (feedback given, grading complete); Late, Incomplete and Absent are markers the teacher grades straight through: the work stays in feedback owed until it is graded, and publishing a grade clears the flag), " +
        'not_tracked (paper / gradebook-only work with no submission channel, never owing) or unknown (no submission signal synced yet, ' +
        'e.g. OneDrive work or a test whose attempts were not read: NEVER treated as not submitted, since Prism must not accuse a student on incomplete data). ' +
        '`owing` is true only for not_started / in_progress AND not yet scored: that is the "still outstanding" set. Each item\'s `timeline` is the full submission picture (same shape as get_assignment_context submission_timeline: when it was submitted, late against any extension and on which clock day, or the clock day it is overdue on). Day numbers are the triage clock: SCHOOL days, the due date (or extended date) = day 1, the teacher\'s referral limit (default 8) the last allowed day. summative = aligned to measurement ' +
        'topics (summative_only keeps only that work). past_due_only keeps only work whose due date has passed (due today is not yet past due). ' +
        "`emails` is a ready-to-paste Outlook To/Bcc list ('a@x; b@x') for the students in the result who have an email. counts.unknown (with " +
        'unknownHint) tells you when a re-sync would answer more confidently. status "not_submitted" (default) lists only students who owe something, ' +
        'the whole-school view; status "all" lists every item (submitted or not) but needs a course, assignment_id or student, since it can be large. ' +
        'For a school-wide "who still owes work?" question, pass summative_only and past_due_only together (this matches the dashboard\'s late-work ' +
        'list); an unfiltered whole-school call also returns formative and not-yet-due work, which can be hundreds of items. Leave past_due_only off, ' +
        'or use status "all", only when you already named a course, assignment or student. ' +
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
      description: 'Triage history, newest first: { referrals: late-work pairs the teacher marked referred (to the academic office), with notes and the clock at the time (`day`, due date = day 1; daysLate = day − 1); extensions: per-student deadline extensions ({ id, lessons (= school days), until, note }) }.',
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
      description: "Record the teacher's decision on a late-work row at the referral limit: 'referred' (referred to the academic office) or 'waived' (work handed in late that the teacher decides not to refer, e.g. a pre-arranged absence; only for kind submitted_late, else NOT_SUBMITTED). ONLY call when the teacher explicitly says so. Use student_id/assignment_id from get_triage lateWork; rejects pairs not currently on the list, and rows not yet at the referral limit (tone red: 8+ school days late by default) with NOT_AT_LIMIT. To give a student more time use extend_deadline; a true exemption from the task is Schoology's Exempt flag (the Absent flag is only a marker: it changes nothing in Prism, so an absent student is still owed, late and listed like any other).",
      inputSchema: {
        student_id: z.number().describe('lateWork[].studentId'),
        assignment_id: z.number().describe('lateWork[].assignmentId'),
        action: z.enum(['referred', 'waived']),
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
      description: "Give one student more time on a summative assignment: give N more SCHOOL days (the parameter is named lessons). They count from the due date, or from TODAY once the due date has passed (so extending overdue work gives N school days from now). ONLY call when the teacher explicitly asks. The student is off the late-work list until the extended date (`until`) passes, then counts late from it. Allowed any time (before or after the due date), for summative work or a Schoology test/quiz in a current course that targets the student. Also for make-up tests (a makeUps row): the make-up clock then counts from the extended date (= day 1), e.g. sitting the make-up on Thursday. Extending the same pair again replaces lessons/note. Returns the stored extension. With resubmission_id: moves that request's deadline to N school days after the ask, or after today once the ask's deadline has passed. " +
        "If the teacher wants the student told (normally yes), call preview_status_line FIRST: kind 'extend_resubmission' with resubmission_id + lessons, or kind 'extension' (ordinary work) / 'make_up' (a Schoology test) with student_id/assignment_id/lessons; it works out the due date; do not compute or draft the line yourself. Show the teacher the returned line and resulting comment, then pass the (possibly teacher-edited) line as comment_line here; it replaces Prism's previous status line in the student's Schoology comment (visible to the student and parents). Omit comment_line for a Prism-only change (as before).",
      inputSchema: {
        student_id: z.number().optional().describe('Student id (lateWork[]/makeUps[].studentId or list_students)'),
        assignment_id: z.number().optional().describe('Assignment id (lateWork[]/makeUps[].assignmentId or list_assignments)'),
        lessons: z.number().int().min(1).max(60).describe('Extension in SCHOOL DAYS, 1-60 (the parameter is named lessons for historical reasons; it is not class meetings)'),
        note: z.string().optional().describe('Optional reason, e.g. "sick for a week"'),
        resubmission_id: z.number().optional().describe('Extend an open resubmission request (get_triage resubmissions[].id) instead of an assignment deadline; then only lessons is used'),
        comment_line: z.string().optional().describe('Exact status line to publish to the student\'s Schoology comment, get it from preview_status_line. Omit for a Prism-only change (as before).'),
      },
    },
    async (args) => text(() => extendDeadlineTool(getDb(), args, { devCopy }))
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
    async (args) => text(() => undoExtensionTool(getDb(), args, { devCopy }))
  );

  server.registerTool(
    'request_resubmission',
    {
      description: "Ask a student to resubmit one assessment, with a deadline in SCHOOL DAYS (parameter `lessons`; default = the teacher's setting, 3). ONLY when the teacher explicitly asks. Works on graded, comment-only or ungraded work. The pair then shows in get_triage resubmissions as 'waiting' (day 1 = the ask day, red after the deadline `until`) until a resubmission arrives ('arrived'), then clears when the visible feedback changes (a new score, rubric level or visible comment). Rejects a second open request (ALREADY_OPEN). " +
        "If the teacher wants the student told (normally yes), call preview_status_line FIRST with kind 'ask' (same student_id/assignment_id/lessons/note); it works out the due date; do not compute or draft the line yourself. Show the teacher the returned line and resulting comment, then pass the (possibly teacher-edited) line as comment_line here; it is published to the student's Schoology comment (visible to the student and parents), replacing Prism's previous status line. Omit comment_line for a Prism-only request: nothing is written to Schoology. " +
        "OneDrive (LTI) work the student has submitted is also UNSUBMITTED in Schoology by default (`unsubmit`, default true for submitted LTI work, false otherwise): this changes the student's submission in Schoology so they can edit their OneDrive work and submit again; the grade and comment stay. Tell the teacher before you call, and pass unsubmit: false if they don't want it. Prism never re-submits work (Undo of the ask leaves it unsubmitted). Passing unsubmit: true for work that isn't submitted LTI work is rejected (NOT_ELIGIBLE) before anything is written. The result's `unsubmit` reports the outcome: { ok: true } or { ok: false, error, url }; the ask is still recorded; give the teacher the url (the Schoology assignment page with its own Unsubmit button). A 'Schoology connection expired' error means the teacher must reconnect in Prism's Settings.",
      inputSchema: {
        student_id: z.number().describe('Student id (list_students / get_triage rows)'),
        assignment_id: z.number().describe('Assignment id (list_assignments / get_triage rows)'),
        lessons: z.number().int().min(1).max(60).optional().describe('Deadline in SCHOOL DAYS from today (named lessons for historical reasons)'),
        note: z.string().optional().describe('What to fix, e.g. "add the evaluation section"'),
        comment_line: z.string().optional().describe('Exact status line to publish to the student\'s Schoology comment, get it from preview_status_line'),
        unsubmit: z.boolean().optional().describe("Unsubmit the student's OneDrive (LTI) submission in Schoology so they can edit it (changes their submission; never re-submits). Default: true when the work is LTI and submitted, else false"),
      },
    },
    async (args) => text(() => requestResubmissionTool(getDb(), args, { devCopy }))
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
    async (args) => text(() => gradeStandsTool(getDb(), args, { devCopy }))
  );

  server.registerTool(
    'preview_status_line',
    {
      description:
        "Compute and preview the status line for request_resubmission / extend_deadline / grade_stands, BEFORE calling any of them with comment_line: the agent cannot reliably work out the school-day due date a line embeds, so this renders it server-side using the same calendar rule the real action uses, instead of you drafting the line. " +
        "`kind` picks the rule and matches the tool you are about to call: 'ask': addSchoolDays(today, lessons ?? the teacher's default), for request_resubmission (needs student_id, assignment_id; lessons/note optional). " +
        "'extend_resubmission': addSchoolDays(the later of the open request's ask date and today, lessons), for extend_deadline with resubmission_id (needs resubmission_id, lessons; note optional). " +
        "'grade_stands': the open request's own deadline (no calendar math), for grade_stands (needs resubmission_id only). " +
        "'extension': addSchoolDays(the later of the assignment's due date and today, lessons), for extend_deadline on ordinary summative work (needs student_id, assignment_id, lessons; note optional). " +
        "'make_up': same rule as extension, for a Schoology test/quiz (needs student_id, assignment_id, lessons; note optional). " +
        "Templates (date as `Ddd DD/MM`, e.g. `Thu 09/10`; `{note}` and its leading space omitted when there is no note; plain ASCII, no special characters; an edited comment_line is held to the same rule: curly quotes, dashes, … and odd spaces become plain ASCII, and any other non-ASCII character is refused with BAD_LINE): ask: `Resubmission requested - due {Ddd DD/MM}. {note}`; extend_resubmission: `Resubmission requested - now due {Ddd DD/MM}. {note}`; grade_stands: `Resubmission deadline ({Ddd DD/MM}) passed - your grade stands.`; extension: `Extension - now due {Ddd DD/MM} ({n} school days). {note}`; make_up: `Make-up - sit by {Ddd DD/MM}. {note}`. " +
        "Does a fresh Schoology read only, nothing is written. Returns { line, until, currentComment, visible, storedLine, resultingComment, hiddenWarning, normalisedLine, lineProblem }: `line` is Prism's rendered suggestion and `until` the computed deadline; resultingComment is exactly what the comment would become; hiddenWarning is true when the current comment is hidden from the student but holds the teacher's own text (so publishing would make it visible). normalisedLine is the candidate line exactly as it would be published (typographic characters made plain ASCII); lineProblem is 'BAD_LINE' (with lineProblemMessage) when publishing would refuse it, e.g. a non-ASCII character or a line break, else null: fix the line before publishing. " +
        "To check a teacher's edit instead of Prism's wording, pass that text as `line` in the input: resultingComment then previews it, while the response's `line` still returns Prism's original suggestion for comparison. Show the teacher the line and resultingComment before passing comment_line to the publishing tool.",
      inputSchema: {
        student_id: z.number().optional().describe('Student id: required for kind ask, extension, make_up'),
        assignment_id: z.number().optional().describe('Assignment id: required for kind ask, extension, make_up'),
        kind: z.enum(['ask', 'extend_resubmission', 'grade_stands', 'extension', 'make_up']).describe('Which action/template to render: matches the publishing tool you are about to call'),
        lessons: z.number().int().min(1).max(60).optional().describe('School days (named lessons for historical reasons): required for extend_resubmission/extension/make_up, optional for ask (defaults to the teacher setting), unused for grade_stands'),
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
    'find_student',
    {
      description: "Find a student across every course Prism holds, archived (past) years included, by legal name, preferred name, email, email number or schoology_uid. Every word of a name must match, so 'Molly Wong' finds legal 'Mei Lin Wong' whose preferred name is Molly. Each candidate has legal and preferred names, grad_year, email and their courses (school_year, term, block) so two students with the same name can be told apart. Read-only. Then call get_student_history with the candidate's id.",
      inputSchema: {
        query: z.union([z.string(), z.number()]).describe('Name (legal or preferred, any order), email, 6-digit email number, schoology_uid or Prism student id'),
        include_archived: z.boolean().optional().describe('Search archived courses too. Default true.'),
        limit: z.number().optional().describe('Max candidates (default 20)'),
      },
    },
    async (args) => text(() => findStudentTool(getDb(), args))
  );

  server.registerTool(
    'get_support_summary',
    {
      description: "A student's PowerSchool Student Support Summary, read live from PowerSchool (about 1 to 3 s; kept 10 minutes): rows [{ category, description, url? }] verbatim, e.g. Academic Support, SEL/Behavioral Support, Case Manager, Accommodation Plan, TLI, Intervention Plan, ILP, Support Plan URL, Support Notes. The extra time, when there is one, is in Support Notes in PowerSchool's words: quote it, never compute or infer from it. Only for a student whose powerschool_alerts include support_summary. For the teacher only: never put it in student-facing text (feedback, comments) or on a roster. Read-only.",
      inputSchema: {
        student: z.union([z.string(), z.number()]).describe('Prism student id (from find_student or list_students), schoology_uid, email, or a name that matches exactly one student'),
      },
    },
    async (args) => text(() => getSupportSummaryTool(getDb(), args))
  );

  server.registerTool(
    'get_student_history',
    {
      description: "Everything Prism holds on one student across every course and year they took with the teacher (archived included), e.g. for a reference letter: per course (oldest first) the end-of-course proficiency per measurement topic, and per assessed assignment its title, due date, overall level, levels per measurement topic and the teacher's grade comment VERBATIM (quote it as written, never correct it). Only the teacher's published finals; AI suggestions are never included; `labels` mark anything unusual (unpublished assignment, comment hidden from the student). A formative with feedback rows (a rubric on an unaligned task) also lists `rubric_rows` [{ criterion, level }], the teacher's published row levels (full detail only). By default only summative work: `omitted` counts formative and completion-scale work left out (and how many of those have comments); ask for them with include_formative / include_completion. Large histories page: follow page.next_offset, or use detail: 'compact' (title, date, level, comment only). Dates are ISO; show them to the teacher as DD/MM/YYYY. Read-only.",
      inputSchema: {
        student: z.union([z.string(), z.number()]).describe('Prism student id (from find_student), schoology_uid, email, or a name that matches exactly one student'),
        course: z.union([z.string(), z.number()]).optional().describe('Only this course: a Prism course id or part of the course name'),
        school_year: z.string().optional().describe("Only this school year, e.g. '2024-25'"),
        include_formative: z.boolean().optional().describe('Include formative work. Default false.'),
        include_completion: z.boolean().optional().describe('Include completion-scale work (Completed / Incomplete). Default false.'),
        include_teacher_drafts: z.boolean().optional().describe("Include the teacher's own unpublished drafts, labelled teacher_draft_unpublished. Default false."),
        detail: z.enum(['full', 'compact']).optional().describe("'compact' = title, date, kind, level and comment per assessment. Default 'full'."),
        limit: z.number().optional().describe('Assessments per page, max 200 (default 50)'),
        offset: z.number().optional().describe('Page start (page.next_offset from the previous call)'),
      },
    },
    async (args) => text(() => getStudentHistoryTool(getDb(), args))
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
              `\`write_student_suggestions\` (whole class, one call, with the \`context_id\` of the context you graded from) and \`write_assessment_analysis\`, then **stop and ` +
              `hand back to the teacher to review in Prism**.\n\n` +
              `How Prism shows your suggestions:\n` +
              `- **Flags:** the teacher reads flags at a glance. Whenever you write \`reviewer_flags\` (one paragraph ` +
              `per flag), also send \`reviewer_flags_brief\`: one short line per flag (about 12 words), in the same ` +
              `order. The paragraphs sit behind "Show detailed flags".\n` +
              `- **Scale assignments:** if \`get_assignment_context\` returns a \`score_scale\` (Completion, General ` +
              `Academic Scale (Unaligned), Approaches to Learning) and no \`rubric\`, grade with \`scale_level\` (a level from ` +
              `\`score_scale.levels\`) plus an \`evidence\` note saying what you checked, instead of \`rubric_scores\`. If it ` +
              `also returns a \`rubric\` (feedback rows), send each row's level in \`rubric_scores\` keyed by \`criterion\`; ` +
              `Prism stages the rubric average as the overall level, so add \`scale_level\` only when your judgment differs ` +
              `from that average or a row is Insufficient Evidence.\n` +
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
