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
  grading_period TEXT,
  archived INTEGER DEFAULT 0,
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
  synced_at TEXT
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
