-- Prism: Student Dashboard Schema (Phase 1)

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schoology_uid TEXT UNIQUE,
  powerschool_id TEXT UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  preferred_name_teacher TEXT,
  email TEXT,
  parent_email TEXT,
  parent_phone TEXT,
  picture_url TEXT,
  grad_year INTEGER,
  school_uid TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  schoology_uid TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,                         -- the teacher's extra phone, typed in Prism ("Extra phone")
  relationship TEXT,
  extra_email TEXT,                   -- the teacher's extra email, typed in Prism (#173)
  UNIQUE(student_id, schoology_uid)
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schoology_section_id TEXT UNIQUE NOT NULL,
  course_name TEXT NOT NULL,
  section_name TEXT,
  course_code TEXT,
  section_school_code TEXT,
  grading_period TEXT,
  archived INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT,
  finalized_at TEXT,                  -- #70: archived: finalized with a session (mastery attempted; null = not yet)
  submissions_read_at TEXT,           -- archived: submissions read in full (null = never)
  mastery_synced_at TEXT,             -- #52: last full mastery read from Schoology (ISO; null = never)
  course_synced_at TEXT,              -- #58: last sync that read EVERYTHING of this course (ISO; null = never)
  sync_attempted_at TEXT,             -- last sync of this course, complete or not (background-sync window)
  first_sync TEXT,                    -- #171: 'pending' = discovered, its first section read not finished;
                                      -- 'failed' = that read failed; NULL = read (and every row from before #171)
  first_sync_error TEXT               -- #171: why the first read failed (with first_sync = 'failed')
);

CREATE TABLE IF NOT EXISTS enrolments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  schoology_enrolment_id TEXT,
  -- Raw Schoology enrollment `status` ('1' = active, '5' = dropped; see #128).
  -- Stored verbatim so an unfamiliar code stays diagnosable.
  status TEXT,
  -- ISO timestamp of the sync that first saw this enrolment as inactive.
  -- NULL = currently enrolled. Soft delete: the row (and the student's grades,
  -- notes and feedback) survives a drop.
  dropped_at TEXT,
  -- #178: the Schoology section the student is in. A course of linked sections (linked_sections)
  -- holds several; each section's read marks drops among its own students only. NULL (rows from
  -- before #178) = the course's own section.
  schoology_section_id TEXT,
  UNIQUE(student_id, course_id)
);

-- #178: linked sections. Schoology links sections that share one set of tasks (the same task ids)
-- and keep their own students and grades, e.g. AI & ML 4(A-B) and 6(A-B) in 2023-24. Prism holds a
-- linked set as one course: the parent section is courses.schoology_section_id, and each child is a
-- row here. Every read of the course reads each of its sections (server/services/courseSections.js).
CREATE TABLE IF NOT EXISTS linked_sections (
  schoology_section_id TEXT PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  section_name TEXT
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  schoology_assignment_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  due_date TEXT,
  max_points REAL,
  assignment_type TEXT DEFAULT 'assignment',
  grading_category_id TEXT,
  grading_scale_id TEXT,
  folder_id TEXT,
  count_in_grade INTEGER DEFAULT 1,
  published INTEGER DEFAULT 1,
  display_weight INTEGER DEFAULT 0,
  num_assignees INTEGER,
  web_url TEXT,
  -- #76: outcome of the last lti_submission document fetch ('ok' | 'failed';
  -- NULL = non-lti / never attempted). Drives the gradebook "re-sync" warning.
  lti_fetch_status TEXT,
  -- Triage: 1 = the task takes submissions in Schoology (allow_dropbox — native
  -- dropbox AND OneDrive/GDrive LTI), 0 = paper/in-class/gradebook-only (incl.
  -- Schoology tests/quizzes), NULL = not synced since the column was added.
  -- Only work that accepts submissions can make a student "outstanding".
  accepts_submissions INTEGER,
  -- Make-up tests: 1 = a Schoology test/quiz (REST type 'assessment'), 0 = not.
  -- Written by every sync. Not derived from assignment_type (masterySync overwrites it).
  is_test INTEGER,
  -- Make-up tests: outcome of the last grader_grade_data attempt read for this
  -- test ('ok' | 'failed'; NULL = not a test / never attempted). Modelled on
  -- lti_fetch_status: a test the sync never reaches keeps its previous value, so
  -- a failed or session-less read is UNKNOWN, never "missed".
  test_fetch_status TEXT,
  -- Make-up tests: 1 = the teacher ignores this test/quiz for make-ups (all
  -- students; e.g. a formative quiz). Prism-owned — the sync never writes it.
  makeup_ignored INTEGER NOT NULL DEFAULT 0,
  -- Set by sync when the assignment drops out of Schoology's section list
  -- (deleted there). Soft removal: the row and anything attached to it stay,
  -- but every listing hides it. Cleared if it ever reappears.
  removed_at TEXT,
  -- #52: last mastery scores + grade comments read for this assignment alone
  -- (syncMasteryForAssignment; ISO; null = never).
  mastery_synced_at TEXT,
  -- #108: last time this task's submissions were read in full (dropbox revisions,
  -- OneDrive/LTI documents or test attempts), by a sync or a page (ISO; null = never).
  submissions_read_at TEXT,
  -- #58: last sync that read this task's data in full (a sync's section read or Sync Assignment).
  task_synced_at TEXT,
  -- #131: last grading sync that completed cleanly (comment threads and files read too); PrisMCP's
  -- 5 minute skip counts only this, not task_synced_at.
  grading_synced_at TEXT,
  -- last sync of this task, complete or not (background-sync window).
  task_sync_attempted_at TEXT,
  -- #131 (superseded by context_serves, #170; no longer read or written): what
  -- get_assignment_context last handed a grading session.
  context_data_as_of TEXT,
  context_served_at TEXT,
  synced_at TEXT
);

-- Individually-assigned targeting. A row here means the assignment is
-- targeted at the given schoology user. When no rows exist for an
-- assignment (and num_assignees is NULL or 0), the assignment is open
-- to all students in the section. See #54.
CREATE TABLE IF NOT EXISTS assignment_assignees (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  schoology_uid TEXT NOT NULL,
  PRIMARY KEY (assignment_id, schoology_uid)
);

CREATE TABLE IF NOT EXISTS grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  enrolment_id TEXT,
  score REAL,
  max_score REAL,
  grade_comment TEXT,
  comment_status INTEGER,
  exception INTEGER DEFAULT 0,
  late INTEGER DEFAULT 0,
  draft INTEGER DEFAULT 0,
  -- #62: submission existence + type from the internal gradebook
  -- (grader_header_data). NULL = no positive submission signal / outside the
  -- returned grading period; "drop" = file dropbox (OneDrive/GDrive/upload);
  -- "assessment" = Schoology assessment. For NON-lti work non-NULL ⇒ "Submitted";
  -- for lti_submission work the authoritative state is grades.lti_submission_state
  -- (migration-added) — submission_type is only a corroborating GHD fallback.
  submission_type TEXT,
  -- Triage: earliest submission time Prism has observed (epoch secs, 0 = none).
  -- A running minimum across syncs — the bulk revisions API only returns the
  -- latest revision, so this is the best available "first submitted" signal.
  first_submitted_at INTEGER DEFAULT 0,
  -- Make-up tests: this pair's cell in the last good grader_grade_data read —
  -- 'took' | 'none' (assigned, no attempt) | 'not_assigned' (on the other copy);
  -- NULL = no cell seen (unknown — never listed as missed).
  test_attempt TEXT,
  -- #174: when Prism first saw the pair's current flag (epoch secs; NULL = no flag). Kept by the
  -- grades_flag_seen_* triggers (server/db/index.js MIGRATIONS, after submitted_at exists): a new or
  -- changed flag takes the record's Schoology timestamp when the same write moved it, else now.
  flag_seen_at INTEGER,
  synced_at TEXT,
  UNIQUE(student_id, assignment_id)
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  course_id INTEGER REFERENCES courses(id),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL,
  records_synced INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_log_id INTEGER REFERENCES sync_log(id),
  started_at TEXT NOT NULL,
  duration_ms INTEGER,
  submission_calls INTEGER DEFAULT 0,
  rate_limit_hits INTEGER DEFAULT 0,
  transient_failures INTEGER DEFAULT 0,
  retries_attempted INTEGER DEFAULT 0,
  retries_succeeded INTEGER DEFAULT 0,
  retries_failed INTEGER DEFAULT 0,
  concurrency INTEGER,
  rate_per_sec INTEGER,
  abandoned INTEGER DEFAULT 0,
  sections_skipped INTEGER DEFAULT 0,
  failed_assignment_ids TEXT,
  -- #143: wall time of each phase of the unified sync (server/services/
  -- syncOrchestrator.js), and of the whole run. NULL = the phase did not run.
  -- mastery_ms is the sum over every mastery course in the run.
  schoology_ms INTEGER,
  blocks_ms INTEGER,
  alerts_ms INTEGER,                  -- PowerSchool alerts phase (#117)
  mastery_ms INTEGER,
  comments_ms INTEGER,
  quizzes_ms INTEGER,
  total_ms INTEGER
);

-- One row per POST /api/sync (the unified sync dialog). Persists what each sync
-- reported so a client whose stream dropped (iOS screen lock) can re-attach by
-- polling sync_run_events, and so Settings → Recent syncs can show past runs.
-- status: 'running' | 'completed' | 'completed_with_errors' | 'failed' |
-- 'interrupted' (left 'running' by a crash/restart/deploy; set at server start).
-- error_count / warning_count are kept live as events arrive (see
-- server/services/syncRuns.js classifyEvent). Pruned to the newest 30 full syncs and the newest 30 task and quiz runs.
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  options_json TEXT,
  summary_json TEXT,
  error_count INTEGER DEFAULT 0,
  warning_count INTEGER DEFAULT 0
);

-- Every progress event a sync run streamed, in order (seq starts at 1 per run).
CREATE TABLE IF NOT EXISTS sync_run_events (
  run_id INTEGER NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  status TEXT NOT NULL DEFAULT 'draft',
  score REAL,
  flag_for_review INTEGER DEFAULT 0,
  flag_reason TEXT,
  feedback_json TEXT NOT NULL,
  teacher_notes TEXT,
  revision_history TEXT DEFAULT '[]',
  source_file TEXT,
  suggestion_state TEXT,
  -- The data time of the context the grading session was given (the context_serves row its
  -- context_id names, else the oldest serve in 3 hours, else task_synced_at at write time): how
  -- old the data a suggestion was made from was ('never': the task had never been synced; null:
  -- a row from before this was recorded, not judged). See #131.
  data_as_of TEXT,
  -- When the grading session got its data (that serve's served_at, else the write time;
  -- ISO). Not the write time itself: a grader reads once and writes at the end. updated_at also
  -- moves on teacher edits, so staleness compares data_as_of with this. Set only by
  -- upsertStudentSuggestion.
  suggested_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Assessment-level reviewer analysis (PrisMCP Project A). One row per assignment.
-- analysis_json holds { noticings: [{title, body}], moderation_note?: string }.
-- Written by PrisMCP (write_assessment_analysis); read-only in the UI.
CREATE TABLE IF NOT EXISTS assessment_analysis (
  assignment_id INTEGER PRIMARY KEY REFERENCES assignments(id),
  analysis_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Folders (unit/topic structure)
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  schoology_folder_id TEXT NOT NULL,
  title TEXT NOT NULL,
  color TEXT,
  parent_id TEXT DEFAULT '0',
  display_weight INTEGER DEFAULT 0,
  synced_at TEXT,
  UNIQUE(course_id, schoology_folder_id)
);

-- Completion tracking
CREATE TABLE IF NOT EXISTS completion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  total_rules INTEGER DEFAULT 0,
  completed_rules INTEGER DEFAULT 0,
  percent_complete REAL DEFAULT 0,
  synced_at TEXT,
  UNIQUE(student_id, course_id)
);

-- Grading categories (formative/summative)
CREATE TABLE IF NOT EXISTS grading_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  schoology_category_id TEXT NOT NULL,
  title TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE(course_id, schoology_category_id)
);

-- Grading scales (fetched from Schoology per-section, but stored globally
-- since scale IDs are district-wide). levels_json is a JSON array of
-- { name, value } sorted ascending by value, e.g.
-- [{"name":"IE","value":0},{"name":"EM","value":12.5},...]. NULL or empty
-- array means "numeric scale" — display as score / max_points.
CREATE TABLE IF NOT EXISTS grading_scales (
  schoology_scale_id TEXT PRIMARY KEY,
  title TEXT,
  levels_json TEXT,
  synced_at TEXT
);

-- Mastery / Standards-Based Grading tables

-- Reporting categories and measurement topics are DISTRICT-GLOBAL objectives:
-- the same Schoology UUID is shared across every section aligned to it (e.g.
-- "HS ART: PRODUCE" appears identically in MAD, MGD, Robotics, …). They are
-- therefore stored once per UUID. The `course_id`/`category_id` columns record
-- an arbitrary owning course (whichever section first synced the objective) and
-- are NON-AUTHORITATIVE — NEVER filter a mastery read by reporting_categories
-- .course_id or measurement_topics.course_id. The per-course relationship is
-- carried by mastery_scores / mastery_alignments (keyed via assignment, which
-- is per-course) and mastery_rollups (keyed with course_id, below). Reads reach
-- these tables through those joins, never by their own course_id. See #127.
CREATE TABLE IF NOT EXISTS reporting_categories (
  id TEXT PRIMARY KEY,           -- Schoology UUID (district-global; shared across sections)
  course_id INTEGER REFERENCES courses(id),  -- non-authoritative owning course; do not filter by it
  external_id TEXT,              -- e.g. "ART.5"
  title TEXT,
  weight INTEGER,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS measurement_topics (
  id TEXT PRIMARY KEY,           -- Schoology UUID (district-global; shared across sections)
  category_id TEXT REFERENCES reporting_categories(id),
  course_id INTEGER REFERENCES courses(id),  -- non-authoritative owning course; do not filter by it
  external_id TEXT,              -- e.g. "ART.5.1"
  title TEXT,
  weight INTEGER,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS mastery_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_uid TEXT NOT NULL,
  assignment_schoology_id TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES measurement_topics(id),
  points INTEGER,                -- 0/25/50/75/100
  grade TEXT,                    -- "ED"/"EX"/"D"/"EM"/"IE"
  synced_at TEXT,
  UNIQUE(student_uid, assignment_schoology_id, topic_id)
);

-- Authoritative objective↔assignment alignments from Schoology's
-- /district_mastery/api/alignments/search endpoint. A row here means the
-- topic is aligned to the assignment even when no student has a score yet
-- (so the UI can render "Pending" cells correctly).
CREATE TABLE IF NOT EXISTS mastery_alignments (
  assignment_schoology_id TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES measurement_topics(id),
  course_id INTEGER REFERENCES courses(id),
  synced_at TEXT,
  PRIMARY KEY (assignment_schoology_id, topic_id)
);

-- Schoology's own per-(student, objective) rollup as displayed in the mastery
-- gradebook UI. objective_id refers to a topic UUID when is_category=0 and a
-- reporting category UUID when is_category=1. grade_scaled_rounded is one of
-- 87.50/62.50/37.50/12.50/0.00 (ED/EX/D/EM/IE).
--
-- course_id is PART OF THE PRIMARY KEY (#127). Schoology computes a separate
-- rollup per section, and objective UUIDs are district-global (shared across a
-- teacher's courses), so a student enrolled in several of the teacher's courses
-- has a DISTINCT rollup per course for the same objective. Keying without
-- course_id collapsed them to one row — whichever course synced last won, and
-- the proficiency columns went blank on that student's other course pages.
-- course_id is NOT NULL: a rollup with no course is meaningless.
CREATE TABLE IF NOT EXISTS mastery_rollups (
  student_uid TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  is_category INTEGER NOT NULL DEFAULT 0,
  grade_percentage REAL,
  grade_scaled_rounded REAL,
  override_value REAL,
  synced_at TEXT,
  PRIMARY KEY (student_uid, objective_id, course_id)
);

-- Linked quizzes (docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md).
-- A quiz group: one or more unaligned Schoology tests in one course, treated as one
-- quiz, optionally linked to one aligned summative (the result task).
CREATE TABLE IF NOT EXISTS quiz_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  title TEXT NOT NULL,
  result_assignment_id INTEGER UNIQUE REFERENCES assignments(id),
  -- The overall comment's template (spec §13); NULL means the default built from the question kinds.
  comment_template TEXT,
  -- 'ok' | 'mismatch' (a load found options, key or rubric differing between copies)
  parity_status TEXT NOT NULL DEFAULT 'ok',
  parity_detail_json TEXT,
  loaded_at TEXT,
  load_summary_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quiz_group_members (
  group_id INTEGER NOT NULL REFERENCES quiz_groups(id) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL UNIQUE REFERENCES assignments(id),
  PRIMARY KEY (group_id, assignment_id)
);

-- One logical question per group. kind: 'mcq' | 'frq' | 'other'.
-- options_json: [{letter, html, is_key}] (filled by a load). schoology_rubric_json: the
-- FRQ's Schoology rubric, parsed (parseQuizRubric). tags_json: ["CRD-2.G", ...].
CREATE TABLE IF NOT EXISTS quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES quiz_groups(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  stem_html TEXT,
  options_json TEXT,
  max_points REAL,
  schoology_rubric_json TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (group_id, position)
);

-- Each member test's own Schoology question id for a logical question (copies get new ids).
CREATE TABLE IF NOT EXISTS quiz_question_copies (
  question_id INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  schoology_question_id TEXT NOT NULL,
  PRIMARY KEY (assignment_id, schoology_question_id)
);

-- The counted attempt per student per member test (latest when there are several).
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES quiz_groups(id) ON DELETE CASCADE,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  schoology_attempt_id TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  score REAL,
  max_score REAL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL,
  UNIQUE (assignment_id, student_id)
);

CREATE TABLE IF NOT EXISTS quiz_responses (
  attempt_id INTEGER NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  chosen_letter TEXT,
  is_correct INTEGER,
  points REAL,
  max_points REAL,
  answer_html TEXT,
  schoology_rubric_cells_json TEXT,
  schoology_comment TEXT,
  PRIMARY KEY (attempt_id, question_id)
);

-- The full text of a question tag in one course (for AP CSP, a College Board code's CED
-- wording), shown when the teacher hovers over the tag. Set through set_question_tags.
CREATE TABLE IF NOT EXISTS quiz_tag_texts (
  course_id INTEGER NOT NULL REFERENCES courses(id),
  tag TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (course_id, tag)
);

-- Phase 2: a Prism mark on one free-response answer (spec §12). The suggestion layer
-- (suggested_*, history, revised flag) and the teacher's mark (final_*) are separate, so a
-- new suggestion never replaces the teacher's work. Cells: { "<rowId>": points }, or
-- { "points": n } without a rubric. state: 'suggested' | 'accepted' | 'edited'.
-- writeback_status: NULL (no teacher mark) | 'pending' | 'posted' | 'failed'.
-- Deleting the attempt (removed in Schoology, or replaced by a newer one) deletes its marks.
CREATE TABLE IF NOT EXISTS frq_marks (
  attempt_id INTEGER NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES quiz_questions(id) ON DELETE CASCADE,
  suggested_cells_json TEXT,
  suggested_comment TEXT,
  suggestion_history_json TEXT NOT NULL DEFAULT '[]',
  suggestion_revised INTEGER NOT NULL DEFAULT 0,
  final_cells_json TEXT,
  final_comment TEXT,
  state TEXT NOT NULL DEFAULT 'suggested',
  writeback_status TEXT,
  writeback_at TEXT,
  writeback_error TEXT,
  posted_cells_json TEXT,
  posted_comment TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (attempt_id, question_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_enrolments_student ON enrolments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrolments_course ON enrolments(course_id);
CREATE INDEX IF NOT EXISTS idx_grades_student ON grades(student_id);
CREATE INDEX IF NOT EXISTS idx_grades_assignment ON grades(assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_notes_student ON notes(student_id);
CREATE INDEX IF NOT EXISTS idx_parents_student ON parents(student_id);
CREATE INDEX IF NOT EXISTS idx_feedback_student ON feedback(student_id);
CREATE INDEX IF NOT EXISTS idx_feedback_assignment ON feedback(assignment_id);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_mastery_scores_student ON mastery_scores(student_uid);
CREATE INDEX IF NOT EXISTS idx_mastery_scores_assignment ON mastery_scores(assignment_schoology_id);
CREATE INDEX IF NOT EXISTS idx_mastery_scores_topic ON mastery_scores(topic_id);
CREATE INDEX IF NOT EXISTS idx_measurement_topics_category ON measurement_topics(category_id);
CREATE INDEX IF NOT EXISTS idx_reporting_categories_course ON reporting_categories(course_id);
CREATE INDEX IF NOT EXISTS idx_mastery_rollups_student ON mastery_rollups(student_uid);
CREATE INDEX IF NOT EXISTS idx_mastery_rollups_course ON mastery_rollups(course_id);
CREATE INDEX IF NOT EXISTS idx_mastery_alignments_course ON mastery_alignments(course_id);
CREATE INDEX IF NOT EXISTS idx_mastery_alignments_topic ON mastery_alignments(topic_id);
CREATE INDEX IF NOT EXISTS idx_folders_course ON folders(course_id);
CREATE INDEX IF NOT EXISTS idx_completion_student ON completion(student_id);
CREATE INDEX IF NOT EXISTS idx_completion_course ON completion(course_id);
CREATE INDEX IF NOT EXISTS idx_grading_categories_course ON grading_categories(course_id);
CREATE INDEX IF NOT EXISTS idx_assignment_assignees_uid ON assignment_assignees(schoology_uid);

-- Rubric descriptors (SBG): portable content (rubrics → criteria → descriptors)
-- plus local binding (attachment → criterion↔topic map). See
-- docs/superpowers/specs/2026-06-08-rubric-descriptors-design.md.
CREATE TABLE IF NOT EXISTS rubrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT,                    -- 'csv' | 'mcp' | 'manual'
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rubric_criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rubric_id INTEGER NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,      -- canonical, intentional row order (1..N)
  criterion_name TEXT,            -- friendly label, e.g. "UI/UX"
  standard_title TEXT,            -- measurement-topic title as written
  reporting_category TEXT         -- as written, e.g. "Produce"
);

CREATE TABLE IF NOT EXISTS rubric_descriptors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  criterion_id INTEGER NOT NULL REFERENCES rubric_criteria(id) ON DELETE CASCADE,
  level TEXT NOT NULL,            -- 'ED' | 'EX' | 'D' | 'EM' | 'IE'
  descriptor_text TEXT,
  UNIQUE(criterion_id, level)
);

CREATE TABLE IF NOT EXISTS rubric_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rubric_id INTEGER NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
  assignment_schoology_id TEXT NOT NULL,
  course_id INTEGER REFERENCES courses(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(assignment_schoology_id)   -- one rubric per assignment
);

CREATE TABLE IF NOT EXISTS rubric_attachment_topics (
  attachment_id INTEGER NOT NULL REFERENCES rubric_attachments(id) ON DELETE CASCADE,
  criterion_id INTEGER NOT NULL REFERENCES rubric_criteria(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES measurement_topics(id),
  UNIQUE(attachment_id, criterion_id)
);

-- Feedback rows (2026-10-13): the teacher's published row levels for a rubric
-- attached to an UNALIGNED (score-scale) task. Prism-only: never synced, never
-- sent to Schoology. Keyed by criterion name, because write_rubric "update"
-- re-inserts criteria with new ids.
CREATE TABLE IF NOT EXISTS rubric_row_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_schoology_id TEXT NOT NULL,
  student_uid TEXT NOT NULL,
  criterion_name TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('ED','EX','D','EM','IE')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (assignment_schoology_id, student_uid, criterion_name)
);
CREATE INDEX IF NOT EXISTS idx_rubric_row_levels_student ON rubric_row_levels(student_uid);

CREATE INDEX IF NOT EXISTS idx_rubric_criteria_rubric ON rubric_criteria(rubric_id);
CREATE INDEX IF NOT EXISTS idx_rubric_attach_assignment ON rubric_attachments(assignment_schoology_id);
CREATE INDEX IF NOT EXISTS idx_rubric_attach_topics_topic ON rubric_attachment_topics(topic_id);

-- Draft teacher feedback for the /assessment/ page (unpublished proficiency
-- picks, comment text, display-to-student toggle). One row per (assignment,
-- student); the draft object is stored verbatim as JSON. Replaces the former
-- per-browser localStorage draft so the MCP can read in-progress grading. See
-- docs/superpowers/specs/2026-06-12-assessment-drafts-db-migration-design.md.
CREATE TABLE IF NOT EXISTS assessment_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  enrolment_id TEXT,
  draft_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_assessment_drafts_assignment ON assessment_drafts(assignment_id);

-- Triage school-day calendar, from PowerSchool section_info `calenderDays`
-- (PowerSchool's spelling). One row per date in the current school year,
-- merged across synced sections; in_session drives school-day counting.
-- `raw` keeps the calenderDays entry verbatim so later fields need no re-probe.
CREATE TABLE IF NOT EXISTS school_days (
  date TEXT PRIMARY KEY,                -- 'YYYY-MM-DD'
  in_session INTEGER NOT NULL DEFAULT 0,
  cycle_letter TEXT,                    -- cycleDay.letter ('A'/'B')
  raw TEXT,
  source TEXT NOT NULL DEFAULT 'powerschool',
  synced_at TEXT
);

-- The dates each class actually meets (its lessons), from PowerSchool: a school
-- day whose bell schedule includes the section's period. Replaced per course on
-- every block sync. Drives the "lesson" hints next to school-day deadlines; all
-- clocks still count school_days.
CREATE TABLE IF NOT EXISTS class_meetings (
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                   -- 'YYYY-MM-DD'
  synced_at TEXT,
  PRIMARY KEY (course_id, date)
);

-- App settings (key/value, JSON-encoded values). Server-side so every device,
-- prod and PrisMCP agree. Keys are namespaced, e.g. 'triage.referralLimitDays';
-- a missing row means the code default.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Triage: the teacher's handling of a late-work pair that reached the referral
-- limit — 'referred' (sent to the academic office). A row removes the pair from
-- the late-work list; undo = delete. days_late is the school-day count (between; shown as day = days_late + 1) when the
-- action was taken. ('exempt' is legacy: the app no longer writes it — per-student
-- extensions live in `extensions`, true exemptions use Schoology's Exempt flag.)
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  action TEXT NOT NULL CHECK (action IN ('referred', 'exempt')),
  note TEXT,
  days_late INTEGER,
  source TEXT NOT NULL DEFAULT 'app',   -- 'app' | 'mcp'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, assignment_id)
);

-- Triage: a per-student deadline extension of N lessons (= school days, the
-- referral limit's unit). The student's effective due date is the N-th school
-- day after the assignment's due date; they stay off the late-work list until
-- it passes, then count late from it (a make-up test's clock also counts from
-- it — "sitting it Thursday"). One per pair — re-extending replaces
-- lessons/note/source and sets updated_at. Undo = delete. A pair can be extended
-- and later referred.
CREATE TABLE IF NOT EXISTS extensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  lessons INTEGER NOT NULL,
  -- The extended deadline (YYYY-MM-DD): N school days from the later of the due date
  -- and the day it was granted (2026-10-08: an overdue extension gives time from now).
  -- NULL on rows from before then: computed as due date + N.
  until TEXT,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'app',   -- 'app' | 'mcp'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,                      -- set when re-extended (history/since use COALESCE(updated_at, created_at))
  UNIQUE(student_id, assignment_id)
);

-- Triage resubmissions (2026-10-03 spec). One row per round: a 'request' (asked to
-- resubmit, with a deadline in lessons). 'review' rows ("Reviewed") were removed in
-- Amendment B; the CHECK still allows the kind so existing DBs need no migration.
-- At most one open request per pair.
CREATE TABLE IF NOT EXISTS resubmissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  kind TEXT NOT NULL CHECK (kind IN ('request', 'review')),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'done')),
  requested_at TEXT,                    -- request: asked / first seen unsubmitted (UTC 'YYYY-MM-DD HH:MM:SS')
  lessons INTEGER,                      -- request: deadline = requested date + N school days
  until TEXT,                   -- request: the deadline (YYYY-MM-DD); NULL on old rows = requested date + lessons
  note TEXT,
  source TEXT NOT NULL DEFAULT 'app',   -- 'app' | 'mcp' | 'schoology_unsubmit'
  revision_at INTEGER,                  -- legacy review rows: the latest_revision_at it covered (epoch s)
  closed_at TEXT,
  close_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  -- Phase 2 (LTI unsubmit on Ask): why Prism's unsubmit of the student's OneDrive
  -- work failed after the ask was recorded; NULL = none asked / it worked. Cleared
  -- once a sync sees the work in progress (or resubmitted), or a later unsubmit works.
  unsubmit_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resubmissions_one_open
  ON resubmissions(student_id, assignment_id) WHERE kind = 'request' AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_resubmissions_course ON resubmissions(course_id);

-- Triage resubmissions (Amendment B): the exact status line text Prism last
-- published in a grade comment for this pair, so the next action can find and
-- replace it verbatim (composeComment) and the fingerprint can tell teacher
-- text apart from Prism's own line. One row per pair — a new action overwrites
-- it in place.
CREATE TABLE IF NOT EXISTS status_lines (
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  line TEXT NOT NULL,                 -- the exact text Prism published (after the teacher's edits)
  kind TEXT NOT NULL,                 -- 'ask' | 'extend_resubmission' | 'grade_stands' | 'extension' | 'make_up' | 'received' | 'flag'
  written_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_type TEXT,                   -- 'resubmission' | 'extension': the record whose action published it
  source_id INTEGER,                  -- that record's id (undo removes the line only for its own record)
  PRIMARY KEY (student_id, assignment_id)
);

-- Triage resubmissions (Amendment B): the last-seen visible-feedback fingerprint
-- per pair, so a sync can tell "teacher wrote new feedback" apart from "nothing
-- changed" without re-deriving history. arrival_revision_at/arrival_baseline
-- capture the resubmission currently being answered (0/NULL = none in flight).
CREATE TABLE IF NOT EXISTS feedback_snapshots (
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  fingerprint TEXT NOT NULL,          -- last seen visible feedback (feedbackFingerprint.js)
  revision_at INTEGER NOT NULL DEFAULT 0,      -- last seen grades.latest_revision_at
  arrival_revision_at INTEGER NOT NULL DEFAULT 0,  -- the resubmission being answered (0 = none)
  arrival_baseline TEXT,              -- visible feedback just before that resubmission
  synced_fingerprint TEXT,            -- fingerprint as of the last sync / mastery pull
  fingerprint_at INTEGER NOT NULL DEFAULT 0,  -- epoch s of a Prism save that set `fingerprint` (0 = set by a sync)
  arrival_write_at INTEGER NOT NULL DEFAULT 0, -- unused since round 4 (no longer written; arrival_parts replaced it)
  arrival_parts INTEGER NOT NULL DEFAULT 0,    -- bits (server/lib/resubmission.js PART_*): parts of visible feedback Prism saves after the arrival changed
  save_log TEXT,                      -- JSON [[epoch s, fingerprint before, fingerprint after], …] of Prism saves since the last judged revision / revision-read sync (newest 20)
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (student_id, assignment_id)
);

-- Submission comment threads (a student's dropbox comments on Schoology), read
-- lazily per (assignment, student) and cached here. A refresh replaces the
-- pair's rows. author_role is fixed at read time: 'student' (the student's own
-- uid) | 'teacher' (Prism's teacher or a section admin) | 'other'. body is the
-- comment as Schoology returns it; server/lib/submissionComments.js derives
-- the plain text, automatic "Revision N submitted" lines and student text.
CREATE TABLE IF NOT EXISTS submission_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schoology_comment_id TEXT UNIQUE NOT NULL,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  author_uid TEXT NOT NULL,
  author_role TEXT NOT NULL,
  author_name TEXT,
  is_mine INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL DEFAULT 0, -- epoch seconds
  attachments TEXT                  -- JSON [{fid, filename, title, filesize, filemime, extension, md5, download_path}] or NULL
);
CREATE INDEX IF NOT EXISTS idx_submission_comments_pair ON submission_comments(assignment_id, student_id);

-- When each pair's thread was last read (a row with no comments = read, empty).
CREATE TABLE IF NOT EXISTS submission_comment_reads (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  read_at INTEGER NOT NULL,           -- epoch seconds of the last successful read
  error TEXT,                         -- the last failed read's error, cleared by a good one
  PRIMARY KEY (assignment_id, student_id)
);

-- Native dropbox submission files (#107): every revision of one student's
-- submission with its files, read on demand from
-- GET /v1/sections/{sid}/submissions/{aid}/{uid}?with_attachments=1 and cached
-- here. A refresh replaces the pair's rows. No sync writes these.
CREATE TABLE IF NOT EXISTS submission_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  revision_id TEXT NOT NULL,          -- Schoology revision_id (1, 2, ... per student)
  created INTEGER NOT NULL DEFAULT 0, -- epoch seconds
  late INTEGER NOT NULL DEFAULT 0,
  draft INTEGER NOT NULL DEFAULT 0,
  num_items INTEGER,
  files TEXT,                         -- JSON [{id, filename, title, filesize, filemime, extension, md5, download_path}] or NULL
  UNIQUE (assignment_id, student_id, revision_id)
);

-- When each pair's revisions were last read (a row with no revisions = read, none).
CREATE TABLE IF NOT EXISTS submission_revision_reads (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  read_at INTEGER NOT NULL,           -- epoch seconds of the last successful read
  error TEXT,                         -- the last failed read's error, cleared by a good one
  PRIMARY KEY (assignment_id, student_id)

);

-- PowerSchool student alerts (#117): the alerts PowerSchool's custom-alerts
-- plugin shows beside a student's name, kept as Prism keys (server/lib/psAlerts.js
-- ALERT_DEFS) behind the powerschool_alerts feature. A sync replaces a student's
-- rows only when it read that student; anyone it could not read keeps their
-- last-known rows. ps_alert_id is the PowerSchool alert type id.
CREATE TABLE IF NOT EXISTS student_ps_alerts (
  student_id INTEGER NOT NULL REFERENCES students(id),
  alert_key TEXT NOT NULL,
  ps_alert_id TEXT,
  PRIMARY KEY (student_id, alert_key)
);

-- Per-student PowerSchool reads: when the alerts were last read, and the raw
-- guardian-contact fields that decide each parent's contact status (#66; null = not set
-- in PowerSchool). The status is calculated when read, never stored.
CREATE TABLE IF NOT EXISTS student_powerschool (
  student_id INTEGER PRIMARY KEY REFERENCES students(id),
  alerts_synced_at TEXT,              -- ISO time of the last successful read
  dnc_g1 TEXT,                        -- X_DNC_G1: do not contact guardian 1
  dnc_g2 TEXT,                        -- X_DNC_G2: do not contact guardian 2
  g1_deceased TEXT,                   -- X_G1DECEASED
  g2_deceased TEXT,                   -- X_G2DECEASED
  correspondence TEXT,                -- X_HOMEEMAIL, raw: which guardian(s) PowerSchool sends correspondence to
  guardians_synced_at TEXT            -- ISO time the guardian slots below were last read
);

-- PowerSchool's two guardian slots per student (#66), from the Emergency Contact List:
-- the name as PowerSchool shows it (`Last, First`), the slot's first email address and
-- its phone as written (#173). A sync replaces a student's rows only when it read the
-- list for them; a failed read keeps the last-known rows. A slot with no name, email or
-- phone has no row.
CREATE TABLE IF NOT EXISTS student_ps_guardians (
  student_id INTEGER NOT NULL REFERENCES students(id),
  slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
  name TEXT,
  email TEXT,
  phone TEXT,
  PRIMARY KEY (student_id, slot)
);

-- The newest comment the teacher has seen in each pair's thread (Schoology's own
-- created time, epoch seconds), set when the thread is opened in Prism. A student
-- comment (typed text or a file) created after it is unread. No row = never opened.
CREATE TABLE IF NOT EXISTS submission_comment_seen (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  seen_created INTEGER NOT NULL DEFAULT 0,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (assignment_id, student_id)
);

-- #170: every grading read PrisMCP's get_assignment_context handed out. The answer's context_id is
-- this row's id; write_student_suggestions takes it back, so a suggestion records the data time
-- and serve time of the read it was graded from. data_as_of is 'never' for a task not yet synced.
-- Rows older than 30 days are pruned (server/services/contextServes.js). No foreign key: a
-- deleted task leaves rows that the prune clears.
CREATE TABLE IF NOT EXISTS context_serves (
  -- AUTOINCREMENT: a pruned id is never handed out again, so an old context_id cannot name a newer serve.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  data_as_of TEXT NOT NULL,
  served_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_serves_assignment ON context_serves(assignment_id, served_at);
CREATE INDEX IF NOT EXISTS idx_context_serves_served_at ON context_serves(served_at);

-- #40: the grade a Schoology flag removes, kept until it is restored or replaced. Saved from the fresh
-- pre-write read before the flag is written (the write goes ahead only once this row is stored), so
-- clearing the flag can restore it as the card's draft (server/services/gradeFlags.js). One row per
-- pair. saved_json: { score, max_points, comment, comment_status, topics: { topicId: level },
-- rows: { criterion: level }, scale_level }. flag: the code set over it. restored_at: when the copy
-- went into the draft (NULL = still waiting).
CREATE TABLE IF NOT EXISTS excused_grades (
  student_id INTEGER NOT NULL,
  assignment_id INTEGER NOT NULL,
  flag INTEGER NOT NULL,
  saved_json TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  restored_at TEXT,
  PRIMARY KEY (student_id, assignment_id)
);
