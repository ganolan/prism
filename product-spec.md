# Prism — Product Spec

## Overview

A local-first web application for teachers to view, manage, and enrich student data from Schoology and PowerSchool. Syncs bidirectionally with Schoology via API. Designed for a single teacher initially, with plans to share with colleagues via feature flags and eventual Tauri desktop packaging.

**Primary user:** Graham (teacher, HKIS — AP CSP and AI & Machine Learning courses)
**Secondary users:** Teaching colleagues at HKIS (future, with grading features hidden)

## Tech Stack

- **Frontend:** React + Vite
- **Backend:** Express.js
- **Database:** SQLite (single file, local only)
- **Schoology integration:** Two-legged OAuth, PLAINTEXT signature, base URL `https://schoology.hkis.edu.hk/v1`
- **Future packaging:** Tauri (desktop app for colleague distribution)

## Architectural Rules

These exist to keep the Tauri migration path open and the codebase clean:

- No localStorage or sessionStorage for application state — all state lives in SQLite
- React frontend communicates with Express backend exclusively via HTTP endpoints
- All API calls use relative URLs (`/api/students` not `http://localhost:3000/api/students`)
- File paths (database, inbox folder, config) are configurable via environment variables
- Schoology API credentials stored in `.env` file, never committed to repo
- Feature flags in `config.yaml` control which UI elements and routes are active

## Data Sources

### Schoology API (primary, bidirectional)
- Rosters, course sections, enrollments
- Assignments and grade items
- Numeric grades
- Submission comments (confirmed available via API)
- Grade comments (availability TBD — must be tested)
- Submissions and attachments

### PowerSchool CSV Import (secondary, manual)
- Graham has an existing script that cleans and formats PowerSchool data dumps
- Student demographic data, parent/guardian contacts, class enrolments
- Imported via file upload in the dashboard UI

### Grading Engine Inbox (companion tool integration)
- The dashboard has an `inbox/` folder within its own directory
- JSON feedback files dropped here are imported on app launch or via file watcher
- The dashboard defines the accepted JSON schema; it does not know or care what produces the files
- Alternative input methods: manual entry in UI, file upload via UI

### Accepted Inbox JSON Schema

```json
{
  "submission_id": "string",
  "student_id": "string",
  "assignment_id": "string",
  "graded_at": "ISO 8601 datetime",
  "score": "number",
  "overall_grade": "string (optional letter grade)",
  "flag_for_review": "boolean",
  "flag_reason": "string (if flagged)",
  "status": "draft",
  "strengths": ["string array"],
  "suggestions": ["string array"],
  "narrative_feedback": "string",
  "rubric_scores": {
    "criterion_name": "number"
  }
}
```

---

## Phased Build Plan

### Phase 1 — MVP: Data In, Data Displayed

**Goal:** Get student data flowing into the app and displayed usefully. Prove the Schoology sync works.

**Schoology sync service:**
- Authenticate with two-legged OAuth
- Pull teacher's course sections and enrolments
- Pull assignment list per section
- Pull grades per assignment (including comment field if available)
- Pull submission comments
- Store everything in SQLite
- Handle pagination (Schoology returns ~100 items per page)

**PowerSchool import:**
- Upload cleaned CSV via the UI
- Parse and upsert student records into SQLite
- Merge with Schoology data by matching on student ID or name

**Database schema (initial):**

```
students
├── id (primary key)
├── schoology_id
├── powerschool_id
├── first_name
├── last_name
├── preferred_name (nullable, teacher-editable)
├── email
├── parent_email (nullable)
├── parent_phone (nullable)
├── created_at
└── updated_at

courses
├── id
├── schoology_section_id
├── course_name
├── section_name
├── grading_period
├── archived (boolean, default false)
└── synced_at

enrolments
├── id
├── student_id (FK)
├── course_id (FK)
└── schoology_enrolment_id

assignments
├── id
├── course_id (FK)
├── schoology_assignment_id
├── title
├── due_date
├── max_points
├── assignment_type (assignment, discussion, assessment)
└── synced_at

grades
├── id
├── student_id (FK)
├── assignment_id (FK)
├── score
├── max_score
├── grade_comment (from Schoology if available)
├── schoology_grade_id
└── synced_at

notes
├── id
├── student_id (FK)
├── course_id (FK, nullable — note can be general)
├── content (text)
├── created_at
└── updated_at

flags
├── id
├── student_id (FK)
├── assignment_id (FK, nullable)
├── flag_type (review_needed, late_submission, performance_change, custom)
├── flag_reason
├── resolved (boolean)
├── created_at
└── resolved_at
```

**UI — Phase 1:**
- Class dashboard: select a course, see all students with their current grades in a table
- Student profile page: name, preferred name (editable), email, parent contact, all grades across courses, notes and flags
- Quick search: search students by name across all courses
- Basic filter: filter by course, sort by name or grade
- Sync button: manually trigger Schoology sync
- PowerSchool CSV upload page

**What this phase validates:**
- Schoology API integration works reliably
- Data model is correct
- The app is genuinely useful for daily teaching

---

### Phase 2 — Enrichment: Notes, Flags, and Class Tools

**Goal:** Make the app more useful than Schoology's own interface.

**Notes and flags:**
- Add free-text notes to any student (general or course-specific)
- Manually flag students with a reason (e.g. "needs support with loops", "frequently late")
- Flag resolution workflow — mark flags as resolved with a note

**Preferred names:**
- Editable preferred name field on student profile
- Displayed everywhere in the UI instead of legal name
- Legal name shown in smaller text or on hover

**Class tools:**
- Email list generator: select a course (or specific students), copy list of student emails and/or parent emails to clipboard in a format ready to paste into Outlook
- Random name picker: select a course, pick one or more random students, with animation
- Group generator: select a course, specify number of groups, generate random groups. Optional: balance by grade performance if data is available
- Class checklist generator: create a checklist (e.g. "submitted permission slip") for a class, track completion per student, export as CSV

**Archive feature:**
- Archive past courses so they don't clutter the main view
- Archived courses still searchable and viewable but hidden from default dashboard

---

### Phase 3 — Analytics

**Goal:** Surface patterns and insights that are invisible in Schoology.

**Grade analytics per class:**
- Box-and-whisker plots showing grade distribution per assignment
- Class average trend over time
- Formative vs summative comparison (requires tagging assignments by type)

**Individual student analytics:**
- Grade trend across assignments within a course
- Cross-course performance comparison
- Highlight significant changes (configurable threshold, e.g. >15% drop between consecutive assignments)

**Automated flags:**
- Late or missing submissions (data from Schoology sync)
- Significant performance change between assignments
- Students with grades below a configurable threshold

**Statistical considerations (per Miles Berry article):**
- Show standard deviation alongside averages so teachers understand spread
- Don't present small score changes as meaningful — account for natural variance
- Box-and-whisker is the primary chart type for class-level distribution
- Pre/post comparisons only meaningful when assessments are comparable
- Individual outliers always require professional contextual interpretation, not just numbers

**Charting library:** Recharts (React-native, sufficient for these chart types)

---

### Phase 4 — Feedback Review Interface

**Goal:** Enable the approve/edit/revise workflow for AI-generated or externally-produced feedback.

**Inbox ingestion:**
- On app launch (or via button), check `inbox/` folder for new JSON files
- Validate against accepted schema
- Import valid files into the `feedback` table with status `draft`
- Move processed files to `inbox/processed/`
- Log errors for invalid files

**Feedback table (extends schema):**

```
feedback
├── id
├── submission_id
├── student_id (FK)
├── assignment_id (FK)
├── status (draft | approved | teacher_modified | revision_requested | revised)
├── score
├── flag_for_review (boolean)
├── flag_reason
├── feedback_json (full structured feedback as JSON text)
├── teacher_notes (teacher's notes for revision, not student-facing)
├── revision_history (JSON array of previous versions)
├── created_at
└── updated_at
```

**Feedback review UI:**
- Filter by status: drafts, flagged, revised, approved
- Inline editing of score and narrative feedback
- Separate "teacher notes" field for revision instructions (not student-facing)
- Approve button (status → approved)
- Request revision button with notes field (status → revision_requested)
- Diff view for revised feedback — show what changed between versions
- Batch approve for unflagged items

**Manual feedback entry:**
- Enter feedback directly through the UI for any student/assignment
- Same fields as the JSON schema
- Status starts as `approved` since it's teacher-written

**File upload:**
- Upload a JSON file through the UI as an alternative to the inbox folder
- Same validation and ingestion as inbox

---

### Phase 5 — Schoology Write-Back

**Goal:** Push approved grades and feedback from the dashboard back to Schoology.

**Push workflow:**
- "Push to Schoology" button on approved feedback items
- Posts numeric grade via Grades API endpoint
- Posts narrative feedback as submission comment via Submissions API endpoint
- Marks feedback record as `pushed_to_schoology` with timestamp
- If grade comments are available via API (determined in testing), push there too

**Batch push:**
- Push all approved feedback for an assignment in one action
- Progress indicator showing how many records pushed
- Error handling for individual failures (don't stop batch on one error)

**Safety:**
- Confirmation dialog before pushing: "Push 24 grades and comments for Lab 3 to Schoology?"
- Never overwrite a Schoology grade that's newer than the dashboard's record (check timestamps)

---

### Phase 6 — Export and Reports

**Goal:** Generate useful exports that replace clunky PowerSchool/Schoology reporting.

**Export formats:**
- CSV export of any filtered view (grades, student list, feedback)
- Formatted PDF class report (grade distribution, student summary)
- Formatted PDF individual student report (all grades, feedback, notes, flags)

**Specific exports:**
- Gradebook export formatted for Schoology CSV import (for cases where API push isn't suitable)
- Student contact list export (names, emails, parent emails)
- Feedback export per assignment (all student feedback for one assignment as a single document)

---

### Phase 7 — Feature Flags and Colleague Distribution

**Goal:** Share the app with colleagues who don't need the grading engine integration.

**Feature flag system:**

```yaml
# config.yaml
features:
  schoology_sync: true
  manual_notes: true
  student_flags: true
  class_tools: true
  analytics: true
  feedback_inbox: false      # hidden for colleagues
  feedback_review: false     # hidden for colleagues
  revision_workflow: false   # hidden for colleagues
  schoology_writeback: false # hidden for colleagues
```

**Colleague onboarding:**
- Setup wizard on first launch: enter Schoology URL and API credentials
- Validate credentials by fetching user profile
- Auto-sync courses on first setup

**Distribution:**
- Wrap in Tauri for `.dmg` distribution
- Single install, no terminal, no `npm install`
- App data stored in standard OS application data directory

---

## Deferred / Future Ideas

These are not specced for any phase but noted for future consideration:

- **AI import assistant:** Natural language queries against the database ("show me all students whose grade dropped more than 10% between unit 2 and 3"). Requires Claude API or Claude Code interaction.
- **Natural language data queries:** Similar to above, conversational interface over student data.
- **Error reporter to GitHub issues:** Automatic issue creation for import errors. Build after the app has been in use long enough to know what breaks.
- **Birthday/milestone reminders:** Only if birthday data is available from PowerSchool import. Don't build manual entry for this.
- **Email generation (not sending):** Generate personalised email text for a class that teacher pastes into Outlook. Not automated sending.
- **Qualitative comment analysis:** Analyse patterns in feedback text across a class. Interesting but requires AI integration.

---

## Non-Functional Requirements

**Data privacy:**
- All student data stays local. No cloud database, no external API calls except to HKIS Schoology.
- SQLite database file lives on the teacher's machine only.
- Backup: simple script that copies the `.db` file to a timestamped backup.

**Performance:**
- Target: ~60 students across 2-4 courses. SQLite handles this trivially.
- Schoology sync should complete within 30 seconds for a full refresh.

**Security:**
- API credentials in `.env` file, never in code or config files.
- `.env` in `.gitignore` from project creation.
- No authentication on the local Express server (single user, localhost only).
- If Tauri-packaged, credentials stored in OS keychain.

---

## Project Structure

```
student-dashboard/
├── .env                    # API credentials (gitignored)
├── .gitignore
├── config.yaml             # feature flags and app settings
├── package.json
├── CLAUDE.md               # project context for Claude Code
├── inbox/                  # JSON feedback files land here
│   └── processed/          # successfully imported files moved here
├── client/                 # React + Vite
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── hooks/
│   │   │   └── useFeatureFlags.js
│   │   ├── services/       # API client functions
│   │   └── App.jsx
│   └── vite.config.js
├── server/
│   ├── index.js            # Express entry point
│   ├── routes/
│   │   ├── students.js
│   │   ├── courses.js
│   │   ├── grades.js
│   │   ├── feedback.js
│   │   ├── tools.js        # class tools endpoints
│   │   └── schoology.js    # sync endpoints
│   ├── services/
│   │   ├── schoology.js    # Schoology API client wrapper
│   │   └── inbox.js        # inbox folder watcher/importer
│   ├── db/
│   │   ├── schema.sql      # database creation script
│   │   ├── students.db     # SQLite database (gitignored)
│   │   └── migrations/     # schema changes over time
│   └── middleware/
│       └── featureGate.js  # blocks gated routes based on config
├── scripts/
│   ├── backup-db.sh        # timestamped database backup
│   └── seed-dummy-data.js  # generate dummy data for testing
└── data/
    └── imports/            # PowerSchool CSVs dropped here
```
