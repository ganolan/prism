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
  phone TEXT,
  relationship TEXT,
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
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS enrolments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  schoology_enrolment_id TEXT,
  UNIQUE(student_id, course_id)
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

CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER REFERENCES assignments(id),
  flag_type TEXT NOT NULL DEFAULT 'custom',
  flag_reason TEXT,
  resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
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
  failed_assignment_ids TEXT
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
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inbox_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  feedback_id INTEGER REFERENCES feedback(id),
  processed_at TEXT DEFAULT (datetime('now'))
);

-- Assessment-level reviewer analysis (PrisMCP Project A). One row per assignment.
-- analysis_json holds { noticings: [{title, body}], moderation_note?: string }.
-- Populated by Project B / inbox ingestion (out of scope here); read-only in the UI.
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

CREATE TABLE IF NOT EXISTS reporting_categories (
  id TEXT PRIMARY KEY,           -- Schoology UUID
  course_id INTEGER REFERENCES courses(id),
  external_id TEXT,              -- e.g. "ART.5"
  title TEXT,
  weight INTEGER,
  synced_at TEXT
);

CREATE TABLE IF NOT EXISTS measurement_topics (
  id TEXT PRIMARY KEY,           -- Schoology UUID
  category_id TEXT REFERENCES reporting_categories(id),
  course_id INTEGER REFERENCES courses(id),
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
CREATE TABLE IF NOT EXISTS mastery_rollups (
  student_uid TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  course_id INTEGER REFERENCES courses(id),
  is_category INTEGER NOT NULL DEFAULT 0,
  grade_percentage REAL,
  grade_scaled_rounded REAL,
  override_value REAL,
  synced_at TEXT,
  PRIMARY KEY (student_uid, objective_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_enrolments_student ON enrolments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrolments_course ON enrolments(course_id);
CREATE INDEX IF NOT EXISTS idx_grades_student ON grades(student_id);
CREATE INDEX IF NOT EXISTS idx_grades_assignment ON grades(assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignments_course ON assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_flags_student ON flags(student_id);
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
