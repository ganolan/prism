# Triage: resubmissions — design

**Date:** 2026-10-03 · **Status:** approved in brainstorming, awaiting spec review
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
- `isResubmitted(grade)` (`server/lib/resubmission.js`, unchanged): a grade exists (score or exception)
  and `latest_revision_at > submitted_at`.

### States (one per student × assessment, derived at read time in `getTriage`)

| State | When | Clock (day 1 =) | Limit / tone | Actions |
|---|---|---|---|---|
| **Waiting** | An `open` request, and not Arrived. | the request's local date | `lessons` (deadline = `addSchoolDays(requested date, lessons)`); amber over the last `warnLeadDays`, red after | **Extend**, **Close** |
| **Arrived** | `isResubmitted(grade)` and `latest_revision_at` > every `review` row's `revision_at` for the pair | the resubmission's local date | `feedbackLimitDays` (as Feedback owed) | **Reviewed** |

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

- **Ask** (card, PrisMCP): needs a graded row (score or exception) for a targeted, enrolled student in a
  current course; lessons 1–`MAX_EXTENSION_LESSONS`; one `open` request per pair (`ALREADY_OPEN`).
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
- Ask on an ungraded row → `NOT_ELIGIBLE` ("nothing to resubmit yet").
- Student drops / course archived → rows disappear with the course/enrolment (same as other lists);
  records stay in history.
- Ask made after a resubmission already arrived → the row shows Arrived; Reviewed/regrade clears that
  arrival but does **not** satisfy the ask (its revision predates `requested_at`), so the row returns to
  Waiting — the teacher asked for another round.
- Ask on work that is never graded after the resubmission → stays Waiting/red until Closed (Arrived needs a
  grade time to compare against — hence asks require a graded row).
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

## Out of scope (now)

- Phase 2 writes until the probe passes.
- Fixing native `first_submitted_at` (follow-up issue).
- Detecting multiple resubmission *rounds* beyond "latest revision vs grade time".
- Notifying students from Prism by any channel other than Phase 2's two options.
