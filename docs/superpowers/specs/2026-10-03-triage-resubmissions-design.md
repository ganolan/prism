# Triage: resubmissions — design

**Date:** 2026-10-03 · **Status:** approved (spec review 2026-10-03, with the feedback-given amendment)
**Builds on:** `2026-10-01-triage-late-work-and-feedback-owed-design.md` (triage),
`2026-05-17-resubmission-tracking-design.md` (#49). **Related issues:** #49, #53, #125.

## Problem

"Ask to resubmit" (#49 Part A) is a bare per-assessment toggle (`flags.flag_type = 'resubmit_requested'`):
no deadline, nothing chases it, and it is invisible outside the assessment page — prod holds only 2,
both from June. Meanwhile triage cannot see resubmissions at all:

- **Feedback owed** counts a student only while the work is not `complete`, so a resubmission after
  grading is never owed again.
- **Late work** ignores resubmit requests.
- **LTI (OneDrive) resubmissions are invisible**: sync writes the grader's `submissionDate` into both
  `submitted_at` and `latest_revision_at` (#125), so `isResubmitted()` can never fire for current LTI
  work (see Verification results 1–2).

The teacher's real workflow: ask a student to resubmit; for LTI work, click **Unsubmit** in Schoology
(the student cannot resubmit LTI work after the deadline otherwise); the student resubmits; regrade.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| What counts as an arrival | **Any** resubmission (latest revision newer than the grade), requested or not. |
| Chasing a request | "Ask to resubmit" takes a **deadline in lessons** (school days), like Extend. Day 1 = the request day. Default **3** (Settings → Triage). Extend can move it. |
| No-show | The row goes **red and stays** until the teacher **Closes** it (optional note; the original grade stands). No Refer, no auto-lapse. |
| Placement | **A 4th rail list, "Resubmissions"**, per student, holding both states (waiting, arrived). Feedback owed stays first-submission only. |
| LTI scope | **LTI and native alike** — the probe proved LTI detection works once the sync stops overwriting the grade time. |
| Arrived clears when | **A new grade time after the resubmission** (Prism save immediately, Schoology regrade at next sync) **or "Reviewed"** (grade stands). |
| Schoology unsubmit without a Prism ask | **Auto-added as waiting** (tag "unsubmitted in Schoology"), deadline = default lessons from the sync that first saw it. |
| Arrival after a red deadline | Still **Arrived** (tagged "after deadline") — not late work. |
| Row link (all per-student lists) | **The student's card on the assessment page** (`?student=`), not the student profile, not a modal. |
| Storage | **A new `resubmissions` table** (option A), not extra columns on `flags`. |
| Schoology side (unsubmit + telling the student) | **Phase 2**, designed here, **built only after a write probe** on a real student (teacher's go-ahead per write). |

## Rules (exact semantics)

### Grade time vs resubmission time

- **Grade time** = `grades.submitted_at` = the REST grade `timestamp` (moves when a grade/comment is
  saved, in Prism or Schoology).
- **Resubmission time** = `grades.latest_revision_at` = native: newest non-draft revision `created`;
  LTI: the grader's `submitted-documents` `submissionDate` (minute resolution).
- **Feedback given** = a score, an exception, **or a non-empty comment**. Any of these teacher writes sets
  the REST timestamp; a submission alone never does (Verification 6).
- `isResubmitted(grade)` (`server/lib/resubmission.js`): feedback given and `latest_revision_at >
  submitted_at`. **Changed:** the guard widens from score/exception to include a comment-only row (also
  fixes the gradebook "↩ Resubmitted" badge for comment-only feedback).
- **Request baseline** = the later of the grade time and `requested_at`. For a pair with an open
  request, an arrival is `latest_revision_at` > the request baseline — so a request works on ungraded or
  comment-only work too.

### States (one per student × assessment, derived at read time in `getTriage`)

| State | When | Clock (day 1 =) | Limit / tone | Actions |
|---|---|---|---|---|
| **Waiting** | An `open` request, and not Arrived. | the request's local date | `lessons` (deadline = `addSchoolDays(requested date, lessons)`); amber over the last `warnLeadDays`, red after | **Extend**, **Close** |
| **Arrived** | (open request: `latest_revision_at` > the request baseline, and > grade time) or (no open request: `isResubmitted(grade)`), and `latest_revision_at` > every `review` row's `revision_at` for the pair | the resubmission's local date | `feedbackLimitDays` (as Feedback owed) | **Reviewed** |

- **Fulfilled** (hidden): an `open` request where `latest_revision_at > requested_at` and grade time ≥
  `latest_revision_at` — the student resubmitted after the ask and was regraded since.
- Arrived dominates Waiting. Arrived after the request's deadline → tag `after deadline`.
- **Scope:** explicit requests always show (any alignment — the teacher chose to chase it). Unrequested
  arrivals follow Feedback owed: summative always, formative only with "Show formative". Current
  courses only (same `currentCourses` rule as the other lists); excused rows never show.

### Settling

`settleResubmissions(db, { assignmentId? })` marks Fulfilled requests `status = 'done'`, `closed_at =
now`, so history and PrisMCP show the outcome. Runs at the end of each sync and after a Prism grade save
for that assessment. `getTriage` never writes; it hides Fulfilled rows whether or not settle has run.

### Auto-add from a Schoology unsubmit (sync, LTI step)

For each student written by the LTI document pass: `lti_submission_state = 'in_progress'` AND a grade
(score not null, `exception = 0`) AND `first_submitted_at > 0` (Prism saw an earlier submission) AND no
`open` request → insert an `open` request, `source = 'schoology_unsubmit'`, `requested_at` = the sync
time, `lessons` = the default. The `first_submitted_at` guard excludes students graded 0 without ever
submitting (observed in the archive: "AIML Lesson 4 — 0, in progress").

Known limit: an unsubmit + resubmit between two syncs never shows the in-progress state — harmless, the
resubmission itself is still caught by the timestamps (Arrived).

### Actions

- **Ask** (card, PrisMCP): any targeted, enrolled student in a current course (graded, comment-only, or
  ungraded — the request baseline covers all three); lessons 1–`MAX_EXTENSION_LESSONS`; one `open` request per pair (`ALREADY_OPEN`).
- **Extend**: sets `lessons` on the open request (same "by N lessons from the original date" meaning as
  extensions), stamps `updated_at`.
- **Close**: `status = 'closed'`, `closed_at`, `close_note`.
- **Reviewed**: inserts `kind = 'review'`, `revision_at = latest_revision_at`, `status = 'done'`; also
  marks an `open` request for the pair `done` **if** that revision is newer than `requested_at` (the
  resubmission answered the ask). A later resubmission (newer `latest_revision_at`) shows again.
- **Undo** (history): deletes the row (a mistaken ask or review), like referral/extension undo.

## Architecture

### Data (schema.sql **and** `MIGRATIONS` in `server/db/index.js`)

```sql
CREATE TABLE IF NOT EXISTS resubmissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  kind TEXT NOT NULL CHECK (kind IN ('request', 'review')),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'done')),
  requested_at TEXT,            -- request: when asked / first seen unsubmitted (UTC datetime)
  lessons INTEGER,              -- request: deadline in school days from the requested date
  note TEXT,
  source TEXT NOT NULL DEFAULT 'app',   -- 'app' | 'mcp' | 'schoology_unsubmit'
  revision_at INTEGER,          -- review: the latest_revision_at it covered (epoch s)
  closed_at TEXT,
  close_note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resubmissions_one_open
  ON resubmissions(student_id, assignment_id) WHERE kind = 'request' AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_resubmissions_course ON resubmissions(course_id);
```

**Migration:** each `flags` row with `flag_type = 'resubmit_requested'` and `resolved = 0` becomes an
`open` request (`requested_at = created_at`, `lessons` = 3, `source = 'app'`), then the flag row is
deleted. Idempotent (runs only while such flags exist). `settings` gains `triage.resubmitLessonsDefault`
(default 3) in `TRIAGE_KEYS`.

### Sync fix (LTI timestamps)

`upsertLtiStateWithTime` (`server/services/sync.js`) stops writing `submitted_at`: the REST grade upsert
earlier in the same sync owns it. `submissionDate` goes to `latest_revision_at` and (earliest kept)
`first_submitted_at`. Readers that used `submitted_at` as an LTI *submission* time switch to
`latest_revision_at` — `get_assignment_context`'s `submitted_at` (and the stale comment at
`assessmentContext.js` ~267). The client already ignores `submitted_at` for LTI (`gradeLabel.js`).

### Server units

- `server/services/triage.js`: `getTriage` adds `resubmissions[]` (row: `id`, `state`, `studentId`,
  `studentUid`, `studentName`, course fields, `assignmentId`, `schoologyAssignmentId`, `title`, `day`,
  `tone`, `approx`, `lessons`, `until`, `revisionAt`, `source`, `afterDeadline`, `note`) and
  `counts.resubmissionsOverdue` and `resubmissionHistoryCount` (closed/done records in scope, for the
  panel footer); `historyCount` stays Late work's. New: `requestResubmission`,
  `extendResubmission`, `closeResubmission`, `markResubmissionReviewed`, `listResubmissions`,
  `undoResubmission`, `settleResubmissions`. Errors: `TriageError` `NOT_FOUND`, `NOT_ELIGIBLE`,
  `ALREADY_OPEN`, `BAD_LESSONS`.
- `server/routes/triage.js`: `GET/POST /api/triage/resubmissions`, `PUT /api/triage/resubmissions/:id`
  (`{ lessons }` or `{ close: true, note }`), `POST /api/triage/resubmissions/review`,
  `DELETE /api/triage/resubmissions/:id`.
- `server/routes/flags.js`: `POST` with `resubmit_requested` → `requestResubmission` (default lessons);
  `DELETE` of such an id is gone (callers move to the triage route). No new `resubmit_requested` flag rows.
- Readers moved from `flags` to `resubmissions` (open request = "requested"): `routes/courses.js`
  (gradebook tint), `routes/mastery.js` (`resubmit_flag`), `services/assessmentContext.js`
  (`flags.resubmit_requested` + new `resubmission` field), the student page.
- `settleResubmissions` called from the sync's end and from the grade-save route (`routes/mastery.js`).

### Client units

- `components/triage/ResubmissionsPanel.jsx` (new): rail order Make-ups → Late work → **Resubmissions**
  → Feedback owed; **hidden when empty**. Header badge "N overdue"; sub-line `asked = day 1 · regrade
  by day {feedbackLimitDays}`. Rows: Arrived first (longest wait), then Waiting (most overdue). Row:
  `UrgencyRing`, name → deep link, tag (`⟳ waiting` / `↩ arrived` / `unsubmitted in Schoology` /
  `after deadline`), `CourseLine`, title. Actions: Waiting → "N left" (or **Close** primary when red) +
  **Extend** (`ExtendEditor`); Close opens an inline optional note. Arrived → **Reviewed**. Footer
  "Closed / reviewed (N) ›" → `ReferralHistory` in resubmission mode (asked / closed / reviewed /
  regraded, Undo). Uses `panelParts` (5 rows, "All N").
- `TriageSection.jsx`: renders the panel, handlers via the new API calls.
- **Deep link** (Late work, Make-ups, Resubmissions rows): `/course/:id/assessment/:aid?student=<prism
  id>`. `AssessmentSummaryPage` reads `student`, clears any filter that hides that student, scrolls the
  card into view, and pulses an accent ring (~2 s). Feedback owed rows keep the assessment link.
- **Assessment card** (`StudentRubricCard`): "Ask to resubmit" opens an inline editor (`NumberStepper`
  lessons, default from settings; note; Ask). Open request → pill **"⟳ Resubmit by {date}"** → Extend /
  Close / Undo. Arrived → existing "↩ Resubmitted" ring/pill plus **Reviewed**.
- Settings → Triage: "Resubmission deadline (lessons)".
- `docs/design-language.md`: the panel, tags, and the deep-link highlight.

### PrisMCP tools (`mcp/server.js` + `mcp/handlers.js`)

`request_resubmission` (student, assignment, lessons?, note?), `close_resubmission` (id, note?),
`mark_resubmission_reviewed` (student, assignment), `list_resubmissions` (course?, student?, since?,
state?). `extend_deadline` gains optional `resubmission_id`. `get_triage` returns `resubmissions`;
`get_assignment_context` gains per-student `resubmission` (state, deadline, source).

## Phase 2 — Schoology side (designed; build gated on the write probe)

The ask editor gains two options, each with a Settings default, each a separate write made **after** the
Prism record is saved; a failed write shows a warning on the row and is never silently rolled back.

1. **☑ Unsubmit in Schoology** (LTI only): `POST /iapi2/assignments/{aid}/submission-action/{uid}` body
   `{isSubmit:false}`, browser session — the call the grader's own Unsubmit button makes (assignment
   React bundle `submitDocument(aid, false, studentDocument.id)`). The student-side variant adds
   `?skipNotify=true`; the teacher-side one does not, which suggests it notifies.
2. **☑ Add a line to their comment**: prepend `⟳ Resubmission requested — due {date} ({n} lessons):
   {note}` via the existing echo-every-field bulk grade write with `comment_status: 1`. Prism removes
   the marked line on regrade, Reviewed, Close, or Undo. The write moves the grade time to the ask time,
   which is before any resubmission, so detection is unaffected.

Rejected: **Schoology exceptions** (e.g. Incomplete) — setting any exception deletes the existing score
(#40). Submission comments (no LTI equivalent) and private messages (outside the assessment) are not
used.

**Write probe (real student, low-stakes formative item, teacher's go-ahead per write)** records, per
option: the call succeeds (CSRF/headers, status); the grade survives; unsubmit returns edit access to
the student's OneDrive copy (teacher checks with the student); whether the student is notified (their
`/users/{uid}/notifications`, or ask); removing the comment line restores the original comment exactly.
Each option ships only if its own probe passes. Results go to `.claude/schoology-api-reference.md`.

## Error handling / edge cases

- Re-ask while one is open → `ALREADY_OPEN` (UI shows the existing pill instead).
- Student drops / course archived → rows disappear with the course/enrolment (same as other lists);
  records stay in history.
- Ask made after a resubmission already arrived → the ask means "another round": the pair is **Waiting
  at once** (the request baseline is the ask, so the earlier arrival no longer shows); only a revision
  after the ask arrives.
- Unrequested arrival on work with no feedback at all (no score/exception/comment) → not a resubmission,
  just a first submission (Feedback owed covers it).
- Calendar missing → `approx` as in the other lists.
- Native `first_submitted_at` can be revision 2's date when the first sync saw only the latest revision
  (Verification 4). Not fixed here — follow-up issue.

## Testing

- **Server (Vitest, in-memory fixtures as `triage.test.js`):** state derivation (waiting, arrived,
  fulfilled; review covers one revision, a newer one reappears); day/tone on the calendar; formative
  rules; auto-add guard (graded + earlier submission → added; graded 0, never submitted → not);
  settle; flag migration; LTI upsert keeps `submitted_at`; flags-route mapping; routes; MCP handlers.
- **Client (RTL):** `ResubmissionsPanel` (ordering, actions, hidden when empty, Close note); card ask
  editor + pill; deep link scroll/highlight incl. clearing a hiding filter; Settings field.
- **Live parity probe** `scripts/parity-lti-resubmission.js`: sync a `/tmp` copy of prod after the fix
  and confirm the archived 9/9 set and current LTI rows match the probe's prediction.
- **Visual:** phone-width screenshots of the rail and card (rendered to PNG, viewed via Read).

## Verification results (2026-10-03 probe, read-only)

Scripts: `scripts/probe-lti-resubmission.js` (`ARCHIVED=1` for last year), `scripts/probe-native-revisions.js`,
`scripts/probe-lti-resubmission-fields.js`, `scripts/probe-resubmission-network.js`,
`scripts/probe-lti-grader-chunks.js`.

1. **LTI timestamps split correctly.** On last year's graded LTI work, the grader `submissionDate` is the
   **latest** submission while the REST grade `timestamp` stays at the grading time: 9 graded LTI cells
   show `submissionDate` after the grade (e.g. HeroBot Notebook 2 graded 14/05 and 18/05, resubmitted
   21/05; Web App Client Handover graded 22/05 13:16, resubmitted 14:42, 17:11, 23/05 07:31).
2. **Prism already detects them where the timestamps were not overwritten.** Archived rows kept
   `submitted_at` = REST grade time, and `isResubmitted` flags exactly those 9 (9/9). Current courses:
   all 92 LTI submitted rows have `submitted_at = latest_revision_at` — the #125 overwrite.
3. **Unsubmit is visible.** 6 archived students are graded but back in `in-progress-documents` (unsubmitted
   after grading, never resubmitted). Grades survive an unsubmit.
4. **Schoology's reminders count is "submitted more than once", not "since graded".** Native CPT 1: 2
   students "New resubmission" — both revision 2 on 23/09, graded 29/09 → correctly not owed. Their
   `first_submitted_at` = revision 2's date (the bulk read only returns the latest revision).
5. **No resubmission field on the LTI grader**: `submitted-documents` entries have one date and
   `submissionStatus` 0/1; `statusFilter` is only `graded | ungraded | late | ontime`.
6. **Comment-only feedback sets the grade timestamp; a submission alone never does** (prod snapshot):
   17/17 native comment-only rows have a REST timestamp (16 after the latest revision); 155/155 ungraded,
   uncommented native submissions have none; ungraded LTI cells have none (probe output). The one
   comment-only row with a later revision (an archived journal reflection: comment 29/03, submitted
   08/04) is a real arrival the old score/exception guard missed.

## Out of scope (now)

- Phase 2 writes until the probe passes.
- Fixing native `first_submitted_at` (follow-up issue).
- Detecting multiple resubmission *rounds* beyond "latest revision vs grade time".
- Notifying students from Prism by any channel other than Phase 2's two options.

## Implementation notes (Task 11, 2026-10-03)

**Live parity probe** (`scripts/parity-lti-resubmission.js`), run read-only against a dev-clone DB
(`sqlite3 -readonly ~/prism/data/students.db ".backup /tmp/prism-dev.db"`, dev server on port 3002,
`PRISM_SESSION_DIR` pointed at a copy of the saved Schoology session).

Before the sync (DB freshly migrated — schema ready, no synced resubmission rows yet, grade data
still pre-fix from prod):

```
archived LTI resubmitted-since-feedback: 9 (probe: 9)
  ACSS: Project - Single Page Web App (S)
  ACSS Project - Developer Profile - Design (S)
  ROB: Safety Poster (F)
  ROB: HeroBot Notebook 2 - Observations and Maintenance (S)
  ROB: HeroBot Notebook 2 - Observations and Maintenance (S)
  ROB: HeroBot Notebook 4 - Rebuild, Test and Optimize (S)
  ACSS Project - Web App Client Handover & Roadmap (S)
  ACSS Project - Web App Client Handover & Roadmap (S)
  ACSS Project - Web App Client Handover & Roadmap (S)
current LTI submitted: 92; submitted_at == latest_revision_at: 92
triage resubmissions by state: {}
```

Dev sync triggered via `POST /api/sync` (`{"syncBlocks":false}`), Schoology only — completed cleanly:
`status: completed`, `error_count: 0`, `warning_count: 0`, 2380 records, 10 sections, elapsed ~90s.

After the sync (code's fixed LTI upsert — `submitted_at` keeps the REST grade time, `submissionDate`
only feeds `latest_revision_at`/`first_submitted_at`):

```
archived LTI resubmitted-since-feedback: 9 (probe: 9)
  ACSS: Project - Single Page Web App (S)
  ACSS Project - Developer Profile - Design (S)
  ROB: Safety Poster (F)
  ROB: HeroBot Notebook 2 - Observations and Maintenance (S)
  ROB: HeroBot Notebook 2 - Observations and Maintenance (S)
  ROB: HeroBot Notebook 4 - Rebuild, Test and Optimize (S)
  ACSS Project - Web App Client Handover & Roadmap (S)
  ACSS Project - Web App Client Handover & Roadmap (S)
  ACSS Project - Web App Client Handover & Roadmap (S)
current LTI submitted: 92; submitted_at == latest_revision_at: 1
triage resubmissions by state: {}
```

Archived rows are untouched by a current-only sync, so the 9/9 holds both times (sanity check, not a
new result). The current-course number is the live-fire result: **92/92 → 1/92** equal-timestamp rows.
The one survivor (`AIML - Lesson 1 - AI Image Generators (F)`) was checked directly: `score: null,
exception: 0, grade_comment: null` — no REST grade at all, exactly the "nothing has graded it yet, so
there's nothing to diverge from" case the fix predicts, not a residual bug.

`triage resubmissions by state: {}` both times: this snapshot's current courses have no open asks and
no Schoology-unsubmit auto-adds yet (the `resubmissions` table only gets rows from an explicit ask or a
detected teacher Unsubmit during a sync — neither happened here), so an empty grouping is expected, not
a failure. The Dashboard's `/api/triage` confirmed the same: `resubmissions: []`, 13 late-work rows, 6
feedback-owed rows, 0 make-ups — the Resubmissions panel legitimately rendered hidden in the visual
check below.

**Visual check.** Dev UI on the Vite port (`http://localhost:5173` — note: Vite bound `[::1]`, not
`127.0.0.1`, this run), via `scripts/screenshot-triage-resubmissions.mjs` (390×844 and 1280×900) plus
`node scripts/check-mobile-layout.mjs http://localhost:5173` (all shell PASS). Dashboard screenshots
show the Resubmissions panel correctly absent (0 rows, matches the API above). The assessment-page
screenshot used a late-work row's deep link (student redacted — no resubmission rows existed to link
from this snapshot) and confirms the deep link scrolls straight to
that student's card, with the `ResubmitControl` "Ask to resubmit" pill visible in the card header next
to "Flag for review". PNGs (not committed): `/tmp/triage-resub-dashboard-{phone,desktop}.png`,
`/tmp/triage-resub-assessment-{phone,desktop}.png`.

**Suites:** `npx vitest run server mcp` and `cd client && npm test && npm run build` — see Task 11
report for exact counts.

## Amendment B — documented feedback (approved 2026-10-03, supersedes conflicting text above)

**Principle (teacher, 2026-10-03):** every submission gets documented feedback the student can see. A
resubmission is never silently dismissed; it ends in either a changed grade / new visible comment, or a
written "deadline passed — grade stands". Comment fields also hold teacher-only notes (hidden comments,
or Prism drafts), so **only visible feedback counts**.

### What changes

| Before (above) | Now |
|---|---|
| **Reviewed** (grade stands, silent) | **Removed** — UI, routes, PrisMCP. Nothing leaves Arrived without visible feedback. |
| **Close** (any time, optional note) | **Grade stands** — only once the Waiting deadline has passed (red). Shown at a glance as *missed deadline · grade stands* (button, row, history). Writes a comment line. |
| Arrived clears on a newer grade time | Arrived clears when the **visible feedback changed** since the resubmission arrived (snapshot model below). |
| Prism-only asks/extensions | Ask, Extend (resubmission, late work, make-up), Grade stands and Undo **prepend a status line to the student's Schoology comment**, after a confirm. |
| Phase 2 comment line | Now in Phase 1 (it is the comment write Prism already does). LTI unsubmit + notification check stay Phase 2. |

### Status lines

- One Prism status line per student × assessment, always first in the comment, replaced by each new one:
  - Ask: `⟳ Resubmission requested — due {Ddd DD/MM}. {note}`
  - Extend (resubmission): `⟳ Resubmission requested — now due {Ddd DD/MM}. {note}`
  - Grade stands: `⟳ Resubmission deadline ({Ddd DD/MM}) passed — your grade stands.`
  - Late-work extension: `⟳ Extension — now due {Ddd DD/MM} ({n} lessons). {note}`
  - Make-up extension: `⟳ Make-up — sit by {Ddd DD/MM}. {note}`
  - Regrade of an arrival (card chip, optional): `⟳ Resubmission received {DD/MM} — regraded.`
- **Exact-match, not pattern-match.** Prism stores the exact line it published (after the teacher's edits)
  in `status_lines`. Replacing removes that exact stored text from the start of the comment if still there
  verbatim, then prepends the new line. A line hand-edited in Schoology no longer matches → treated as the
  teacher's own text (the confirm preview shows the whole resulting comment).
- **Confirm modal (significance):** header *Publish to {Name}'s Schoology comment*; sub *visible to the
  student (and parents) as soon as you publish*; a consequence line specific to the action (e.g. *Ends the
  resubmission request: missed deadline, grade stands.*); the full resulting comment with the new line
  highlighted and the line editable; a hidden-comment warning when Display is off (*publishing shows your
  current hidden comment to the student — edit or remove it below*); a verb-specific primary button
  (*Publish & close request*). Publishing always sets Display on (`comment_status: 1`).
- **Write order:** validate the Prism action → publish to Schoology (fresh read, echo grade/exception) →
  record in Prism. A failed publish changes nothing in Prism and shows the error.
- **Undo** (history) of an ask / extension / grade stands offers to remove the stored line (same modal,
  default on). Auto-added `schoology_unsubmit` requests write no line until the teacher acts.

### Visible-feedback snapshots (replaces the timestamp comparison for "answered")

- **Fingerprint** per student × assessment = `{ score, exception, rubric levels (mastery_scores, sorted),
  comment }` where `comment` = the comment text with the stored status line removed, **only if
  Display-to-student is on** (hidden comment → `''`).
- `feedback_snapshots` (Prism-owned): last seen `fingerprint` + `revision_at`, and the current arrival
  (`arrival_revision_at`, `arrival_baseline`). Captured at the end of each sync and after every Prism
  grade/comment save. When `latest_revision_at` is newer than the snapshot's `revision_at`, the arrival is
  recorded with **baseline = the previous snapshot's fingerprint** (the feedback before the resubmission).
- **Feedback given** (the baseline counts as prior feedback) = baseline has a score, an exception, rubric
  levels, or a non-empty visible comment.
- **States:**
  - **Arrived (unrequested):** an arrival whose baseline had feedback, and the current fingerprint equals
    the baseline.
  - **Waiting:** an open request with no arrival after `requested_at`.
  - **Arrived (requested):** an open request and an arrival after `requested_at` with current fingerprint
    = baseline.
  - **Acknowledged / fulfilled:** the current fingerprint differs from the arrival baseline → off the list;
    settle marks a request `done`.
- Hidden notes, unchanged re-saves and Prism status lines don't change the fingerprint → still Arrived.
  Visible feedback given in Schoology between two syncs is caught (baseline = previous sync's snapshot).
- **First deploy:** a pair the old timestamp rule calls resubmitted gets an arrival with baseline = its
  current fingerprint (Arrived until feedback changes); every other pair gets a plain snapshot.
- The ↩/⚠ "resubmitted" badge on gradebook / card / student page uses the same Arrived rule.
- The LTI timestamp fix stays (it is how a new revision is noticed).

## Implementation notes (Amendment B, 2026-10-03)

**Pre-existing prod fixes made while building this.** Two gaps existed in the live comment-write path
(`write-comment` and `send-all`) before Amendment B touched it, both now closed everywhere a status line
can be published:

- A failed fresh Schoology read (the read that must precede any comment PUT, to echo the current
  grade/exception) used to fall through to other error handling; it now always aborts with
  `SCHOOLOGY_READ_FAILED` (502) before any write — nothing is ever written blind. The same guard applies
  when the fresh read succeeds but returns no record for the pair while Prism's local `grades` row holds
  a score or a non-zero exception (a sync gap, not "no grade yet") — also 502, no PUT.
- A Schoology write that was actually rejected (non-2xx, or a 207 batch entry whose own status wasn't
  2xx) used to still be reported to the caller and mirrored into Prism as "saved". Both `write-comment`
  and `send-all` now gate the whole local mirror + success response on the PUT having actually succeeded;
  a rejected write returns 502 and changes nothing in Prism.

**Known limitations (deferred; flagged to the user, not blocking):**

1. **A standalone mastery pull between a resubmission and the next Schoology sync can produce a false
   Arrived.** `captureFeedbackSnapshots` runs after every mastery pull as well as every full sync. If a
   teacher (or a rubric re-import) changes rubric levels in Schoology *after* a resubmission arrived but
   *before* the next full sync notices the new revision, that pull's capture takes the current fingerprint
   as the arrival's baseline — so the resubmission can read as already-answered (or, in the visible
   direction covered here, the student's new work can look answered by feedback that actually predates
   it) when nothing about the resubmission itself has been looked at yet. The approximation is accepted
   because the two captures are expected to stay close together in practice; if it bites, the teacher just
   re-answers.
2. **A post-resubmission save that exactly restores pre-resubmission feedback reads as answered.** If the
   teacher saved feedback before the resubmission arrived, then — after it arrives — makes a Prism save
   that happens to reproduce that exact prior fingerprint (score, exception, rubric levels, visible
   comment all identical), `feedbackAnswered` sees no difference from the baseline and the pair clears as
   if genuinely re-graded. Same visible-feedback-only approximation as above, same accepted direction (a
   false "answered" rather than a false "still waiting").
3. **The per-pair publish lock is per-process.** `lockPair` (status-line publish/remove, and write-comment
   with a status line) excludes concurrent requests only within one Node process. PrisMCP runs as its own
   stdio process; it and the web server do not exclude each other. Two concurrent publishes to the same
   pair from PrisMCP and the dashboard at once could race. Not built out further pending a real need for
   cross-process coordination.
4. **The `⟳`/`—` glyphs and Schoology's 207 per-entry batch-write round-trip are verified offline only**
   (unit tests, fixture-based). Nothing in this amendment has been exercised against a real Schoology
   write. The first real publish should be on a low-stakes item, with the resulting comment checked by eye
   in Schoology (encoding, line placement, and that the 207 entry-level status was read correctly).
5. **`send-all` writes rubric scores before the comment PUT.** If the comment PUT then fails, the batch
   returns 502 (per the prod fix above — no local mirror, no status-line record), but the rubric scores it
   already wrote earlier in the same batch are left sitting in Schoology. Not rolled back; a retry re-sends
   the same scores (idempotent) and the comment.

**Task 8 verification (this task, 2026-10-03):**

- **Live parity probe** (`scripts/parity-lti-resubmission.js`, extended): after the existing LTI-timestamp
  checks, it now also runs `captureFeedbackSnapshots` against an **in-memory copy** of the dev-clone DB
  (`db.serialize()` → `new Database(buffer)`, so the probe stays read-only against `DB_PATH`) and reports
  the before/after `feedback_snapshots` row count and the resulting Arrived count. One implementation
  wrinkle: a WAL-mode source (prod and every dev clone always is) serializes with its header "file format
  write/read version" bytes left at `2`, which the in-memory `memdb` VFS rejects with `SQLITE_CANTOPEN` on
  first `prepare()` even though the serialized page images are already WAL-reconciled and fully valid —
  patching those two header bytes to `1` on the **in-memory copy only** (never the source file) fixes it.
  Run against a /tmp dev-clone copy seeded with one red Waiting request, one in-time Waiting request, and
  one unrequested Arrived pair (plus whatever real historical data the clone already had): the full-scope
  capture produced 4592 `feedback_snapshots` rows (up from the 9 already present) with 12 new first-deploy
  arrivals (old-timestamp-rule resubmissions picked up by the "first deploy" rule above) plus the 1 seeded
  arrival = 13 Arrived total; a follow-up read of `DB_PATH` confirmed its `feedback_snapshots` count was
  unchanged (still 9) — the probe never wrote to the source.
- **Visual check**, dev server on port 3002 against a `/tmp` copy of the dev-clone DB (never prod), via a
  new `scripts/screenshot-amendb-statusline.mjs`: phone (390) and desktop (1280) screenshots of the
  Resubmissions panel (showing all three seeded states — Arrived, red Waiting past its deadline, green
  Waiting still in time) and of the `StatusLineModal` opened from the red row's "Grade stands" button
  (full publish preview: header, consequence line, editable status line, highlighted resulting comment).
  The script never calls Publish — it screenshots the open modal, then presses Cancel; `status_lines` and
  the seeded `resubmissions` rows were confirmed unchanged afterwards. PNGs saved under `/tmp/amendb-*.png`
  (not committed — the repo is public and the seed used real student names from the dev-clone data).
