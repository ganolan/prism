# Triage: late-work referral watch + feedback owed — design

**Date:** 2026-10-01 · **Status:** approved in brainstorming, awaiting spec review

## Problem

Two questions cannot be answered at a glance in Prism today:

1. **Which students are approaching an academic-office referral?** HKIS assessment policy: a student
   whose summative work arrives 8 or more school days (one 8-day cycle) after the due date must be
   referred to the academic office.
2. **Which assessments should I grade first?** Students should get feedback within ~2 weeks; the
   teacher loses track of how long each assessment has been waiting.

Both limits must be adjustable and nothing may be HKIS-hardcoded, so Prism can be released to other
teachers/schools.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Referral unit | **School days** (in-session days), not class meetings. Default limit **8**. |
| Feedback unit | **School days**. Default limit **10** (≈ 2 weeks). |
| Referral scope | **Summative only** (aligned to measurement topics). |
| Feedback scope | **Summative by default**; a "Show formative" toggle (default off). |
| Amber warning | Starts **3 school days before** each limit (setting). |
| At the limit | Teacher can **Mark referred** (optional note) once a row is red. Any row — or any targeted student before the due date — can be **extended by N lessons** (school days, the limit's unit; optional note). Both date-stamped, undoable. True exemptions use Schoology's **Excused** flag, which triage already skips. (Amended 2026-10-02: Extend replaced Exempt.) |
| Stickiness | Submitting *before* the limit clears a student. Once the limit is crossed, the student stays on the list (tagged e.g. "submitted day 10") until marked referred (an extension moves its clock — see Extensions). |
| Placement | **Dashboard** shows both lists across all current courses (option A); each **course page** shows the same lists filtered to that course, and the Assessments tab gains wait bars (option C). No separate Triage page. |
| Calendar source | **PowerSchool** `section_info` calendar, stored locally; validated against the 26-27 Master Plan. Weekday fallback, labelled "approx". Calendar-file import is a later, pluggable source — not built now. |
| Settings | New **Settings** page; values stored **server-side** (SQLite), so laptop, phone, prod and PrisMCP all agree. |
| PrisMCP | Read tools **and** `record_referral` / `extend_deadline` / `set_makeup_tracking` / undo. |
| Make-up tests (added 2026-10-02) | A student who missed a Schoology test/quiz must sit it (or their `*` copy) ASAP — its own short clock and panel, not late work. Green on the test day, amber from **1**, red from **3** school days (settings). **Every** Schoology test/quiz, any alignment (the user's quizzes are unaligned; the mastery grade sits on a separate gradebook-only "… - Result" item). Per-test **Ignore** switch for noise (e.g. formative quizzes). |

## Rules (exact semantics)

### School-day counting

`schoolDaysBetween(fromDate, toDate)` = number of in-session dates `d` with `fromDate < d ≤ toDate`
(dates are local Hong Kong calendar dates, `YYYY-MM-DD`).

- Due Friday, still missing Monday → **1** day late.
- Due date on a non-school day → counting starts at the next school day (falls out of the formula).
- Dates outside the stored calendar (e.g. before the year's data, or no calendar at all) fall back
  to **Mon–Fri weekdays**, and the result carries `approx: true`. The UI shows "approx" beside any
  number computed with the fallback.

### Late work (referral watch)

A (student, assignment) pair is **outstanding** when all hold:

- assignment is Summative (`aligned`), published, has a due date, and the due date has passed;
- the student is an active enrolment and the assignment targets them (`assignment_assignees` when
  `num_assignees > 0`, else the whole roster — see Verification results 3);
- no submission (`normalizedSubmissionState` ≠ `submitted`; LTI `in_progress` counts as not
  submitted), **and** no score, **and** `exception` is not Excused (1). Schoology's Missing (3)
  counts as outstanding.

`daysLate = schoolDaysBetween(due, today)` for outstanding pairs.

A pair is **on the list** when either:

- it is outstanding and `daysLate ≥ 1`; or
- it **crossed the limit**: it was submitted, but `schoolDaysBetween(due, firstSubmittedAt) ≥ referralLimit`
  — tagged "submitted day N";

…and it has **no referral record**. With an **extension**, `due` above is the student's effective due date (see Extensions).

Tone: green below `limit − warnLead`, amber from `limit − warnLead`, red (with the **Mark referred**
action) from `limit`. Every row also offers **Extend**.

### Extensions (amended 2026-10-02 — replaces Exempt)

An extension gives one student `N` more **lessons** (= school days, 1–60) on one summative assignment.
`effDue = addSchoolDays(due, N)` — the N-th school day after the due date, so
`schoolDaysBetween(due, effDue) = N` (same weekday fallback / `approx` rule). For that student only:

- outstanding: `daysLate = schoolDaysBetween(effDue, today)` — hidden until `effDue` has passed, then
  counted late from it;
- crossed the limit: `schoolDaysBetween(effDue, firstSubmittedAt) ≥ referralLimit`;
- feedback owed: unchanged (`waitDays` from `max(due, firstSubmittedAt)`).

Rows carry `extension: { id, lessons, until: effDue, note } | null`; `dueDate` stays the original. An
extension can be granted any time (before or after the due date, any tone) for a summative assignment
in a current course that targets the student (or, since 2026-10-02, any Schoology test/quiz — a
make-up); one per (student, assignment) — re-extending replaces `lessons`/`note`/`source` and stamps
`updated_at`. A pair can be extended and later referred (its `days_late` counts from `effDue`).

### Make-up tests (added 2026-10-02)

A missed Schoology test is **not** late work and not on the referral clock: the student must sit the
same test (or the extra-time `*` copy they were individually assigned) ASAP after everyone else, or
the test may be invalidated for them. The signal is the gradebook's attempt flag
(`grader_grade_data`, Verification results 11), stored as `grades.submission_type = 'assessment'`.

A (student, test) pair is a **make-up** when all hold:

- the assignment is a Schoology test/quiz (`is_test = 1`), published, in a current course, **any
  alignment or grading category**, and not ignored (`makeup_ignored = 0`);
- its attempts were read successfully (`test_fetch_status = 'ok'`) — a failed or never-run read is
  **unknown**, never "missed";
- the test is over: the full local `due_date` `'YYYY-MM-DD HH:MM:SS'` ≤ the local now (a same-day
  test counts once it has ended);
- the student is targeted (assignees rule) and active, not Excused (1), has **no attempt**
  (`submission_type ≠ 'assessment'`) and **no score** (a hand-entered or mastery score = sat on
  paper; Missing (3) with score 0.0 still counts as no score).

`daysSince = schoolDaysBetween(due, today)` (0 on the test day). An extension moves the date the same
way as for late work (`effDue = addSchoolDays(due, N)`) — how a teacher records "sitting it
Thursday"; the row stays visible (green, `daysSince` 0) until then. Tone: green if
`daysSince < makeUpAmberDays`, amber if `< makeUpRedDays`, else red.

Rows: `studentId, studentUid, studentName, courseId, courseName, blockNumber, assignmentId,
schoologyAssignmentId, title, dueDate, daysSince, tone, approx, extension`, sorted by `daysSince`
desc. The payload adds `counts.makeUpsOverdue` (red), `makeUpsUnchecked` (past-due, not-ignored tests
whose read is not `'ok'` → "Couldn't check N tests — re-sync.") and `makeUpsIgnored` (past-due
ignored tests → "N quizzes ignored"). A row clears itself once an attempt syncs.

**Ignore** (`assignments.makeup_ignored`, Prism-owned, default tracked): the teacher can ignore one
test/quiz for **all** students (make-up row "Ignore this quiz" with an inline confirm, the
Assessments-tab chip "Make-ups: tracked / ignored", or PrisMCP `set_makeup_tracking`). Only a
Schoology test in a current course (else `NOT_ELIGIBLE`).

Feedback owed on a test whose attempts were read counts **only the takers** as handed in (the
`accepts_submissions = 0` whole-roster rule still applies to other paper work and to unread tests).

### Feedback owed

For each assignment in scope (Summative; plus Formative when toggled), a student's work is **owed
feedback** when it is submitted (or scored on paper but not complete) and `gradingStateOf(...)` is not
`complete` — i.e. `ungraded` **or** `partial` (a half-scored rubric stays on the list).

`waitDays = schoolDaysBetween(max(due, firstSubmittedAt), today)`, so a late submission starts its own
clock and doesn't redden the row unfairly.

Each assessment row shows: owed count of submitted total, **oldest** `waitDays`, tone by the same
green/amber/red rule against `feedbackLimit`. Rows sort by oldest wait, descending. Assessments with
nothing owed are omitted from the panel (and show no wait on the Assessments tab).

## Architecture

```
PowerSchool section_info ──(existing PS sync)──▶ school_days table
                                                      │
Schoology sync ─▶ assignments / grades / mastery_*    │      settings table   referrals table
                         │                            │            │                │
                         └──────────────┬─────────────┴────────────┴────────────────┘
                                        ▼
                     server/services/triage.js  (pure: db + options → lists)
                         ▲                         ▲
            server/routes/triage.js         mcp/handlers.js
                 (/api/triage …)          (get_triage, list_referrals,
                         ▲                 school_calendar, record_referral)
            Dashboard + CoursePage panels
```

The triage service is the **single source of truth**: the web API and PrisMCP call the same
functions, so the agent sees exactly the numbers on the dashboard.

### Data (schema.sql **and** the `MIGRATIONS` array in `server/db/index.js`)

- **`school_days`** — `date TEXT PRIMARY KEY, in_session INTEGER, cycle_letter TEXT, source TEXT,
  synced_at TEXT`. Filled from `section_info[0].calenderDays` (PowerSchool's spelling; also accept
  `calendarDays`) during the existing PS attendance/block sync (`server/services/psAttendanceSync.js`),
  which already fetches `section_info` per section. Whole-year replace per sync; `source = 'powerschool'`.
- **`settings`** — `key TEXT PRIMARY KEY, value TEXT, updated_at TEXT`. Keys + defaults:
  - `triage.referralLimitDays` = 8
  - `triage.feedbackLimitDays` = 10
  - `triage.warnLeadDays` = 3
  - `triage.showFormativeDefault` = false
  Defaults live in code; a missing row means default. Values clamped server-side
  (limits 1–60, lead 0–59).
- **`referrals`** — `id, student_id, assignment_id, course_id, action ('referred'; the CHECK still
  admits legacy 'exempt', which the app no longer writes), note TEXT, days_late INTEGER, source
  ('app'|'mcp'), created_at`. `UNIQUE(student_id, assignment_id)`. Undo = delete the row.
- **`extensions`** (new table) — `id, student_id, assignment_id, course_id,
  lessons INTEGER NOT NULL, note TEXT, source ('app'|'mcp'), created_at, updated_at`. `UNIQUE(student_id,
  assignment_id)` (upsert; re-extending overwrites `lessons`/`note`/`source` and stamps `updated_at`;
  history order and `since` use `COALESCE(updated_at, created_at)`). Undo = delete the row.
  `updated_at` is also in `MIGRATIONS` (dev databases already had the table).
- **Make-up tests** (columns on `assignments`, schema.sql **and** `MIGRATIONS`): `is_test INTEGER`
  (1 when the Schoology REST `type === 'assessment'`, written every sync — not `assignment_type`,
  which `masterySync` overwrites); `test_fetch_status TEXT` (`'ok'` | `'failed'` | NULL, modelled on
  `lti_fetch_status`: a test the sync never reaches keeps its previous value); `makeup_ignored INTEGER
  NOT NULL DEFAULT 0` (Prism-owned; the sync's upsert never writes it). Settings keys
  `triage.makeUpAmberDays` = 1 (0–30) and `triage.makeUpRedDays` = 3 (1–30); amber is clamped to red.
- **First-submission time** — `grades.first_submitted_at INTEGER` = earliest submission time
  observed (running minimum; see Verification results 1).

### Server units

- **`server/lib/schoolDays.js`** — pure. `makeCalendar(rows)` → `{ between(from, to) → { days, approx },
  addSchoolDays(from, n) → { date, approx } (the n-th school day after from; extensions), isSchoolDay(date),
  info(date), covers(date) }`; `todayLocal()`, `nowLocal()` (`'YYYY-MM-DD HH:MM:SS'`, compares with
  Schoology `due_date`), `epochToLocalDate()`. No DB access; trivially unit-testable.
- **`server/services/triage.js`** — `getTriage(db, { courseId?, studentId?, includeFormative?, today, now? })`
  → `{ lateWork, feedbackOwed, makeUps, makeUpsUnchecked, makeUpsIgnored, counts, settings, calendar,
  lastSyncAt, historyCount }`; `listReferrals` / `recordReferral` / `undoReferral`; `listExtensions` /
  `recordExtension` / `undoExtension`; `setMakeUpIgnored(db, assignmentId, ignored)`. `today` / `now`
  are injected (tests, and the HK-date rule).
- **`server/services/settings.js`** — `getTriageSettings(db)`, `updateTriageSettings(db, patch)` with clamping.
- **Sync** (`server/services/sync.js`) — one `grader_grade_data` read per section for the tests in the
  sync window (`opts.fetchTestAttempts`, browser session via `graderSubmissions.createSubmissionFetcher`
  → `graderTestAttempts.js`, parsed by `server/lib/parseTestAttempts.js`), retried once.
- **Routes:** `GET /api/triage?courseId=&includeFormative=`, `GET /api/triage/referrals`,
  `POST /api/triage/referrals`, `DELETE /api/triage/referrals/:id`, `GET /api/triage/extensions`,
  `POST /api/triage/extensions` (`{ studentId, assignmentId, lessons, note? }`),
  `DELETE /api/triage/extensions/:id`, `PUT /api/triage/makeup-ignore/:assignmentId`
  (`{ ignored: boolean }`), `GET/PUT /api/settings`.

### Client units

- **`LateWorkPanel`** and **`FeedbackOwedPanel`** (`client/src/components/triage/`) — props: data +
  `courseId?`. On the dashboard they show a course chip per row; on a course page the chip is omitted.
  Rows: name, task, progress meter, day count, action (**Mark referred** on red rows, or "N left"; **Extend** on
  every row — a `NumberStepper` 1–60, default 3, + note), and an "ext +N → DD/MM/YYYY" tag when extended.
  Feedback rows link to the existing `AssessmentSummaryPage`.
- **`MakeUpPanel`** — "Make-up tests", full-width **above** the two panels (the most urgent list):
  red-count badge, subtitle "Missed Schoology tests and quizzes · school days since the test · sit by
  day {red}", rows (course chip, student, test, meter against `makeUpRedDays`, day count, extension tag,
  **Extend**, **Ignore this quiz** with an inline confirm), "No missed tests.", the unchecked note and
  "N quizzes ignored". The Extend editor is shared (`ExtendEditor`) and pre-fills a re-extend.
- **Dashboard** — panels above the course cards (two columns on desktop); course cards gain chips
  ("N make-ups" — red when any is red, "1 at limit", "7 to grade · 8d"); header shows "School day N of
  M · Cycle day X" when known.
- **CoursePage** — the panels at the top; Assessments tab rows gain "x/y ungraded" + wait meter, and
  each Schoology test/quiz a click-to-flip "Make-ups: tracked / ignored" chip.
- **Referred / extended history** — "Referred / extended (N) ›" (`historyCount` = referrals + extensions)
  opens a simple list of both, newest first, with undo.
- **SettingsPage** (`/settings`, sidebar under Tools) — the four values plus the make-up amber/red
  days via the existing
  `NumberStepper`, plus calendar status ("PowerSchool · 164 school days · synced 01/10/2026"), or
  "Weekday approximation — run a PowerSchool sync" when empty.
- Colours via existing tokens only (`--success`, `--warning`, `--danger`, `--badge-*`); no hex.
  Phone: panels stack, rules inside the single `PHONE LAYOUT` block in `app.css`.
- Append the new pattern (urgency meter + tone rule) to `docs/design-language.md`.

### PrisMCP tools (`mcp/server.js` + `mcp/handlers.js`)

| Tool | Kind | Input | Returns |
|---|---|---|---|
| `get_triage` | read | `course?` (id or name), `student?`, `include_formative?` | the `getTriage` payload (incl. `makeUps`, `makeUpsUnchecked`, `makeUpsIgnored`), settings, calendar source/approx and `lastSyncAt` so the agent can flag stale data; `student` filters `lateWork` and `makeUps` and recounts their red counts |
| `list_referrals` | read | `course?`, `student?`, `since?` | `{ referrals, extensions }` history with dates and notes |
| `school_calendar` | read | `from`, `to?` | school days between dates, `isSchoolDay`, cycle letter, approx flag |
| `record_referral` | write | `student`, `assignment`, `action` (`referred`), `note?` | the stored record (`source: 'mcp'`); rejects a pair not currently on the late-work list, or not yet red |
| `extend_deadline` | write | `student_id`, `assignment_id`, `lessons` (1–60), `note?` | the stored extension with `until` (also moves a make-up's clock — "sitting it Thursday") |
| `set_makeup_tracking` | write | `assignment_id`, `tracked` (boolean) | `{ assignmentId, title, ignored }`; only a Schoology test in a current course |
| `undo_extension` | write | `id` | confirmation |
| `undo_referral` | write | `id` | confirmation |

Writes go through the existing `dbGuard` (absolute `DB_PATH`, prod database). Tools only act on an
explicit request; descriptions say so.

## Error handling / edge cases

- **No calendar yet** → weekday fallback, `approx: true` everywhere, Settings shows how to fix.
- **Calendar covers only the current year** (PowerSchool limitation) → archived courses are excluded
  from triage entirely (triage is for current courses only).
- **Stale Schoology data** → the dashboard and `get_triage` expose `lastSyncAt`; panels show it in
  their header.
- **Dropped students** (`status: "5"` enrolments, #128) are excluded via active enrolment.
- **Assignment due date moved** → numbers recompute on the next read; an existing referral record is
  kept (it records `days_late` at the time).
- **Invalid settings** → clamped server-side; the client stepper uses the same bounds.

## Testing

- `server/lib/schoolDays.test.js` — weekends, holidays, due date on a non-school day, same-day,
  partial calendar coverage, full fallback (`approx`).
- `server/services/triage.test.js` (fixture DB) — outstanding vs submitted vs excused vs scored;
  stickiness (submitted after the limit stays until referred); extensions/undo; partial grading
  counts as owed; formative toggle; late submission's own clock; course/student filters; settings
  changes move the thresholds.
- `server/services/settings.test.js` — defaults, clamping, round-trip.
- `mcp/handlers.test.js` — each new tool, incl. `record_referral` rejection of an off-list pair.
- Client (Vitest + RTL) — panels render tones/actions; Mark referred/Extend call the API; Settings
  page round-trip.
- **`scripts/parity-school-calendar.js`** — live check: the stored PowerSchool calendar vs the
  26-27 Master Plan's Daily Planning View (`F` column numeric = school day; 164 days). Reports every
  date that differs, and that PS A/B letters alternate the way Master Plan odd/even days do. The path
  to the workbook is a CLI argument (nothing school-specific in the app).

## Verification results (2026-10-01, while planning) — these amend the sections above

1. **First submission time — not stored.** `grades.submitted_at` is the grade timestamp,
   `latest_revision_at` the newest non-draft revision, and the bulk native-dropbox endpoint only
   returns each student's latest revision. So add **`grades.first_submitted_at`** = the *earliest
   submission time Prism has observed* (kept as a running minimum across syncs, written by the native,
   retry and LTI paths), backfilled once from `latest_revision_at`. Consequence: a student who
   resubmitted *before* this column existed may show a later "submitted day N" than reality —
   an extension (or Schoology's Excused flag) covers it.
2. **`calenderDays` shape — unverified beyond `inSession` + `cycleDay.letter`.** `school_days` also
   stores each entry verbatim (`raw` JSON) so later fields need no re-probe; the first real sync
   records a sample in `.claude/powerschool-api-reference.md`. The calendar is merged across all
   synced sections (a date is in session if any section says so). The dashboard shows PowerSchool's
   cycle **letter** (A/B), not the Master Plan's 1–8 number, unless `raw` turns out to carry it.
3. **No `grades` row ≠ not assigned.** A student who never engaged has **no** `grades` row, so
   "outstanding" is computed from the **active roster × the assignment's targets**
   (`assignment_assignees` when `num_assignees > 0`, else everyone), not from `grades` rows.
4. **Missing (3) is a grade-entry event.** For non-LTI work `grades.submitted_at > 0` also follows a
   teacher's grade entry, so a "Missing" exception would read as submitted. Triage treats
   exception 3 as *not submitted* unless a real submission signal (`submission_type` /
   `lti_submission_state`) exists.
5. **Referrals key on local ids** (`student_id`, `assignment_id`), like `flags`.
6. **Assessments tab** shows the ungraded count + wait only for assignments that still owe feedback
   (no separate "All graded" label).
7. **Parity run** against the Master Plan is the last gate before the panels are trusted.
8. **Only work that accepts submissions can be outstanding** (final review, 2026-10-02). Paper /
   in-class / gradebook-only summatives — including Schoology tests/quizzes — carry no submission
   signal, so every student looked outstanding until graded (a whole class went red). New column
   **`assignments.accepts_submissions`** = Schoology `allow_dropbox == 1` (native dropbox *and*
   OneDrive/GDrive LTI), written on every sync. Late work only for `1`; for `NULL` (not synced since
   the column was added) only when some targeted student has a real submission signal; never for
   `0`. For `0`, Feedback owed counts every targeted non-excused student as handed in **on the due
   date** (wait from due), so the paper-grading backlog still shows. Cost: a student who skipped a
   Schoology test isn't flagged late.
9. **"Mark referred" only at the limit.** `recordReferral` accepts `referred` only for a row whose
   tone is red (else `NOT_AT_LIMIT`, HTTP 409). (`exempt` was allowed at any tone until 2026-10-02,
   when **Extend** replaced it — see Extensions.) A submitted pair Schoology itself marks on time (`grades.late = 0`, e.g. a
   per-student extension) is never "submitted day N".
10. **NULL-fallback tracking is roster-wide** (2026-10-02). While `accepts_submissions` is `NULL`, the
    "someone has submitted" fallback is decided over the assignment's **whole targeted roster before**
    any `studentId` filter. Previously a one-student view (`recordReferral`, `get_triage` with a
    student) evaluated it over that student alone, so a row the dashboard showed was rejected with
    `NOT_ON_LIST`. Covered by a service test (one student submitted, another outstanding at the
    limit → `recordReferral` for the outstanding student succeeds).

11. **Did the student take the test? — `grader_grade_data`** (read-only spike, 2026-10-02;
    `.claude/schoology-api-reference.md` "Tests and quizzes > Did the student take the test?").
    `GET /iapi/grades/grader_grade_data/{sectionId}/all?uids={csv}&grade_item_nids={csv}` (browser
    session) returns one cell per (uid, test): `submission: "assessment"` = took it; `has_assessment:
    true` with no submission = assigned, not taken; `not_assigned: true` = on the other copy. It
    matched the results page 15/15 with no false positives. The public REST API is blind to attempts
    (`allow_dropbox` 0, no revisions), and a public grade's timestamp is the grade-write time, not the
    attempt. Consequences built in: one read per section per sync; a payload without a `grades` object,
    or a test with no cells at all, is recorded `'failed'` (unknown), never "missed". Not yet seen live:
    a non-taker whose classmates sat the test, an unsubmitted attempt, multiple attempts, a non-taker
    with a hand-entered score, an excused cell.

## Out of scope (now)

- Calendar import from a file (Master Plan / CSV) — the `schoolDays` interface allows adding it.
- Notifications/e-mail; automatic referral to the academic office; class-meeting ("lesson") counting.
