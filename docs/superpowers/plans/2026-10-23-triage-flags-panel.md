# Triage Flags Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Flags" Triage panel that lists every Schoology flag keeping a task out of a student's grade, with advice, a school-day count, semester-end urgency and an in-row flags control (#174).

**Architecture:** A database trigger stamps `grades.flag_seen_at` whenever any writer gives a pair a new flag. The PowerSchool block sync stores each course's term range, which gives semester ends. A new `server/services/flagRows.js` builds the rows, `getTriage` returns them as `flags`, PrisMCP filters them by student, and a new `FlagsPanel.jsx` renders them with a compact `FlagsMenu`.

**Tech Stack:** Node ESM, Express, better-sqlite3, React + React Testing Library, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-triage-flags-panel-design.md`

## Global Constraints

- Columns added to an existing table go in `server/db/schema.sql` **and** the `MIGRATIONS` array in `server/db/index.js`.
- All day counts are school days via `loadCalendar(db)` / `cal.between(from, to)`; the start date is day 1 (`day = days + 1`).
- Flag codes: 1 Exempt, 2 Incomplete, 3 Missing, 5 Absent, 6 Late (`server/lib/flags.js`).
- Advice copy, verbatim:
  - Late (6): `Grade the work, or mark it Missing if it is too late to count.`
  - Incomplete (2): `Set a date to finish, then grade it.`
  - Absent (5): `Arrange a make-up, or mark it Exempt if the absence is excused.`
  - Missing (3), submitted after the flag: `Clear the flag and grade the work.`
  - Saved grade not restored: `Restore the saved grade, or publish a new one.`
- Tag copy for a Late/Incomplete/Absent row with a later submission: `Submitted after the flag`.
- UI copy: no em dashes (a guard test enforces it). Colors only through CSS custom properties; phone rules only in the `PHONE LAYOUT` block of `client/src/app.css`. Dates render DD/MM/YYYY (`formatDate`).
- Flagged pairs that also appear in Make-ups, Late work or Feedback owed keep those rows unchanged (Graham, 23 October 2026).
- No new Schoology write path: the row control is the existing `FlagsMenu`.

## Decisions made in this plan (record in the spec's "builder's call" spirit)

- **Spike resolved without a new probe.** `.claude/powerschool-api-reference.md` (verified 2026-10-06) records that a section's `calenderDays` span its whole term: full-year sections 165 school days, semester sections 76 or 89, identical within a term. So each course's first and last school day in its `section_info` calendar is its term range, and a semester end is the end of the shortest stored range that contains a date. No Settings fallback is built: with no stored range, `semesterEnd` is `null` and the row stays green.
- **`flag_seen_at` is INTEGER epoch seconds**, like `submitted_at` and `first_submitted_at` (the spec said TEXT ISO). The backfill is not marked `approx`: Schoology restamps a record on every write, so its stored timestamp is the flag's write time unless a later write moved it.

## Review Focus

1. **A flag changed from one code to another** (Late, then Missing): the flag date restarts at the change, and the row's advice follows the new code.
2. **A re-read of an unchanged flag** (every sync) leaves `flag_seen_at` untouched, so the day count never resets.
3. **A row from an ended semester** stays red into the next semester; it never turns green on the new semester's first day.
4. **A task not assigned to a student** (`assignment_assignees`) or a dropped student gives no row, as in the other panels.
5. **A formative task** gives a row only when `includeFormative` is on, matching the other panels.

---

### Task 1: Flag date (`grades.flag_seen_at`)

**Files:**
- Modify: `server/db/schema.sql` (grades table; triggers after it)
- Modify: `server/db/index.js` (`MIGRATIONS`)
- Test: `server/db/flagSeen.test.js` (new)

**Interfaces:**
- Produces: column `grades.flag_seen_at INTEGER` (epoch seconds; NULL when no flag). Triggers `grades_flag_seen_insert` and `grades_flag_seen_update`.

- [ ] **Step 1: Write the failing tests** (in-memory DB as `server/services/triage.test.js` does: `vi.hoisted(() => { process.env.DB_PATH = ':memory:'; })`, then `getDb()`)

```js
test('insert with a flag stamps submitted_at when given, else now', ...)
  // INSERT exception 6, submitted_at 1760000000 → flag_seen_at === 1760000000
  // INSERT exception 2, no submitted_at → flag_seen_at within 5 s of Date.now()/1000
  // INSERT exception 0 → flag_seen_at === null
test('re-writing the same flag keeps the date', ...)
  // exception 6 seen at T; UPDATE with exception 6, submitted_at T+500 → still T
test('a different flag restarts the date', ...)
  // exception 6 at T; UPDATE exception 3, submitted_at T+900 → T+900
  // UPDATE exception 5 with submitted_at unchanged → about now
test('clearing the flag clears the date', ...)
  // UPDATE exception 0 → null
test('an upsert through writeGrades stamps the record timestamp', ...)
  // writeGrades(db, { courseId, grades: [{ enrollment_id, assignment_id, exception: 6, timestamp: 1760000000 }], now })
  // → flag_seen_at === 1760000000
test('the migration backfills flagged rows from submitted_at', ...)
  // set flag_seen_at NULL on an exception 6 row with submitted_at S, re-run the backfill statement → S;
  // with submitted_at 0 → about now; Exempt rows are backfilled too; exception 0 rows stay NULL
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run server/db/flagSeen.test.js`
Expected: FAIL (`no such column: flag_seen_at`).

- [ ] **Step 3: Implement**

Add `flag_seen_at INTEGER` to the grades table in `schema.sql` with a comment (when Prism first saw the current flag; #174). Add to `MIGRATIONS`, in this order: `ALTER TABLE grades ADD COLUMN flag_seen_at INTEGER`, the two triggers (`CREATE TRIGGER IF NOT EXISTS`), then the backfill `UPDATE`. Put the same two triggers in `schema.sql` after the grades table. Use `CAST(strftime('%s','now') AS INTEGER)` for "now" (no `unixepoch()`). Trigger logic:

```sql
-- AFTER INSERT ON grades WHEN NEW.exception IS NOT NULL AND NEW.exception != 0
UPDATE grades SET flag_seen_at = COALESCE(NULLIF(NEW.submitted_at, 0), <now>) WHERE id = NEW.id;
-- AFTER UPDATE OF exception ON grades WHEN COALESCE(NEW.exception,0) != COALESCE(OLD.exception,0)
UPDATE grades SET flag_seen_at = CASE
  WHEN COALESCE(NEW.exception,0) = 0 THEN NULL
  WHEN NEW.submitted_at IS NOT OLD.submitted_at AND COALESCE(NEW.submitted_at,0) > 0 THEN NEW.submitted_at
  ELSE <now> END
WHERE id = NEW.id;
```

Backfill: `UPDATE grades SET flag_seen_at = COALESCE(NULLIF(submitted_at, 0), <now>) WHERE COALESCE(exception,0) != 0 AND flag_seen_at IS NULL`. Confirm `submitted_at` exists in `MIGRATIONS` before these lines (it is migration-added); place the new lines after it.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run server/db/flagSeen.test.js server/services/taskGrades.test.js server/services/gradeFlags.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(flags): record when Prism first sees each flag (#174)`

---

### Task 2: Term ranges and semester ends

**Files:**
- Modify: `server/lib/psCalendar.js` (add `termRange`)
- Modify: `server/services/psAttendanceSync.js:270-276` (store the range)
- Modify: `server/db/schema.sql`, `server/db/index.js` (`courses.term_start`, `courses.term_end`)
- Create: `server/lib/semesters.js`
- Test: `server/lib/psCalendar.test.js`, `server/services/psAttendanceSync.test.js`, `server/lib/semesters.test.js` (new)

**Interfaces:**
- Produces: `termRange(sectionInfo) -> { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } | null` (first and last date whose `extractCalendarDays` entry has `inSession` true).
- Produces: columns `courses.term_start TEXT`, `courses.term_end TEXT`.
- Produces: `loadTermRanges(db) -> Array<{ start, end }>` (distinct non-null ranges from every course row, archived included).
- Produces: `semesterEndFor(date, ranges) -> 'YYYY-MM-DD' | null` (the earliest `end` among ranges with `start <= date <= end`; null when none).

- [ ] **Step 1: Write the failing tests**

```js
// psCalendar.test.js
test('termRange is the first and last school day of the calendar', ...)
  // calenderDays: 2026-08-19 holiday (inSession true, cycleDay null), 2026-08-20 A, 2027-01-08 B, 2027-01-09 inSession false
  // → { start: '2026-08-20', end: '2027-01-08' }; empty calendar → null
// semesters.test.js
test('a date in a semester course range takes the semester end', ...)
  // ranges [{2026-08-20..2027-06-10}, {2026-08-20..2027-01-08}, {2027-01-19..2027-06-10}]
  // semesterEndFor('2026-10-23') → '2027-01-08'; ('2027-03-01') → '2027-06-10'
test('only the full-year range known → the year end', ...)
test('no range contains the date → null', ...)
test('loadTermRanges returns distinct ranges, archived courses included', ...)
// psAttendanceSync.test.js (extend the existing fake section_info fixture)
test('a block sync stores the course term range from section_info', ...)
  // after syncPsAttendance, courses.term_start / term_end equal the fixture's first / last school day
test('a section_info failure leaves the stored range', ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run server/lib/psCalendar.test.js server/lib/semesters.test.js server/services/psAttendanceSync.test.js`
Expected: FAIL (`termRange` / `semesterEndFor` not exported; columns missing).

- [ ] **Step 3: Implement** `termRange`, the two columns (schema + `MIGRATIONS`), the store in `psAttendanceSync.js` inside the `if (first)` block (`UPDATE courses SET term_start = ?, term_end = ? WHERE id = ?` when `termRange(first)` is non-null; targeted syncs store it too, since it is per course), and `server/lib/semesters.js`.

- [ ] **Step 4: Run to verify they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit** `feat(triage): store each course's PowerSchool term range for semester ends (#174)`

---

### Task 3: Flag rows in `getTriage`

**Files:**
- Create: `server/services/flagRows.js`
- Modify: `server/services/triage.js` (`assignmentFacts` grade query adds `g.flag_seen_at, g.latest_revision_at`; `getTriage` calls `flagRows` per course, sorts, returns `flags`, `counts.flagsOverdue`, and includes `flags` in `approx`)
- Test: `server/services/flagRows.test.js` (new; copy the fixture helpers from `triage.test.js`: `seedCalendar`, `student`, `assignment`, `grade`)

**Interfaces:**
- Consumes: `flag_seen_at` (Task 1), `loadTermRanges`, `semesterEndFor` (Task 2), `assignmentFacts`, `isSubmitted` (triage.js), `currentCourses`, `roster`, `fullName` (triageCommon.js), `preferredFirstName` (studentNames.js).
- Produces: `flagRows(db, { course, students, cal, today, formative, studentId, ranges }) -> FlagRow[]` and `flagTone(cal, today, semesterEnd) -> 'green' | 'amber' | 'red'`.
- `FlagRow`: `{ kind: 'flag' | 'saved_grade', flag, studentId, studentUid, studentName, firstName, studentEmail, courseId, courseName, blockNumber, assignmentId, schoologyAssignmentId, title, dueDate, aligned, score, exception, flagSeenOn, submittedAfter, advice, semesterEnd, day, limit, tone, approx }`. `flag` is the code (0 for `saved_grade`), `flagSeenOn` a local date, `limit` the day number of the semester end (`cal.between(flagSeenOn, semesterEnd).days + 1`, or `day` when `semesterEnd` is null).

- [ ] **Step 1: Write the failing tests** (TODAY `2026-10-16`; seed `courses.term_start/term_end` = `2026-08-20`/`2026-12-18` so semester end is known)

```js
test('Late, Incomplete and Absent each give a row with their advice', ...)
  // three tasks, exception 6 / 2 / 5, flag_seen_at = epoch('2026-10-12')
  // → kind 'flag', advice per Global Constraints, flagSeenOn '2026-10-12', day 5, submittedAfter false
test('Exempt never gives a row', ...)
test('Missing gives a row only after a later submission', ...)
  // exception 3, flag_seen_at epoch('2026-10-12'), submission_type 'drop', latest_revision_at epoch('2026-10-09') → no row
  // latest_revision_at epoch('2026-10-14') → row, advice 'Clear the flag and grade the work.', submittedAfter true
test('Late with a later submission is tagged submittedAfter', ...)
test('a cleared flag with a waiting saved copy gives a saved_grade row from saved_at', ...)
  // grades.exception 0; excused_grades saved_at '2026-10-08 02:00:00', restored_at NULL → kind 'saved_grade', day counts from 2026-10-08
  // restored_at set → no row; grades.exception 6 with the copy → only the 'flag' row
test('tone follows the semester end', ...)
  // flagTone with end 2026-12-18: today 2026-10-16 green; 9 school days before end amber; 4 before red; after the end red
  // semesterEnd null → green
test('the semester is the one that contains the due date', ...)
  // two ranges: S1 2026-08-20..2026-12-18 and S2 2027-01-11..2027-06-10; today 2027-01-20 (extend seedCalendar to cover it);
  // a task due 2026-12-01 → semesterEnd '2026-12-18', tone red
test('unassigned students, dropped students and formative work (includeFormative false) give no row', ...)
test('getTriage returns flags sorted red first, then longest wait, then name, and counts.flagsOverdue', ...)
test('a flagged pair keeps its Make-ups and Feedback owed rows', ...)
  // Absent (5) on a missed test → present in makeUps and in flags; Late (6) with a submission → feedbackOwed owed 1 and a flags row
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run server/services/flagRows.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `server/services/flagRows.js`**

Scope: published, not removed tasks of the course (`published = 1 AND removed_at IS NULL`), any due date; skip unaligned tasks when `!formative`; targeted students only (`facts.assignees`). Semester: `semesterEndFor(dueDate ?? flagSeenOn, ranges)`. `flagTone`: `end == null` → green; `today > end` → red; `left = cal.between(today, end).days + 1` (school days from today to the end, both counted); `left <= 5` → red; `left <= 10` → amber; else green. Day: `cal.between(flagSeenOn, today)`; `approx` from that call. `submittedAfter = isSubmitted(a, g) && (g.latest_revision_at || 0) > g.flag_seen_at`. Saved-grade rows: `SELECT student_id, saved_at FROM excused_grades WHERE assignment_id = ? AND restored_at IS NULL`, joined to grades with exception 0; `saved_at` is UTC `YYYY-MM-DD HH:MM:SS`, so convert with `epochToLocalDate(Date.parse(saved_at.replace(' ', 'T') + 'Z') / 1000)`. Keep the advice strings as one exported `FLAG_ADVICE` object.

In `getTriage`: `const ranges = loadTermRanges(db)` once, `flags.push(...flagRows(...))` per course with `studentId` honored, sort `tone rank (red, amber, green) → day desc → studentName`, return `flags`, `counts.flagsOverdue = flags.filter(red).length`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run server/services/flagRows.test.js server/services/triage.test.js server/routes/triage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** `feat(triage): flag rows in getTriage (#174)`

---

### Task 4: PrisMCP `get_triage`

**Files:**
- Modify: `mcp/handlers.js:319-343` (`getTriageTool`)
- Modify: `mcp/server.js:395-430` (description and the `student` input description)
- Test: `mcp/handlers.test.js`

**Interfaces:**
- Consumes: `getTriage(...).flags`, `counts.flagsOverdue` (Task 3).

- [ ] **Step 1: Write the failing test**

```js
test('get_triage returns flags, filtered and recounted by student', ...)
  // two students with a Late (6) flag each; getTriageTool(db, { student: 'Ada' }) → flags.length 1, counts.flagsOverdue recounted
```

- [ ] **Step 2: Run to verify it fails:** `npx vitest run mcp/handlers.test.js` → FAIL.

- [ ] **Step 3: Implement** the filter and recount beside `lateWork`. Description: one sentence on `flags` (rows for Late, Incomplete and Absent flags, Missing after a later submission, and a cleared flag whose saved grade is not restored; `day` from the flag date; tone from the semester end of the task's due date; `advice` is the line to give the teacher; Exempt never appears). Add `flags` to the `student` input's list.

- [ ] **Step 4: Run to verify it passes:** `npx vitest run mcp/` → PASS.

- [ ] **Step 5: Commit** `feat(mcp): get_triage returns the flags rows (#174)`

---

### Task 5: The Flags panel

**Files:**
- Modify: `client/src/components/FlagsMenu.jsx` (new prop `compact`)
- Create: `client/src/components/triage/FlagsPanel.jsx`
- Modify: `client/src/components/triage/TriageSection.jsx:150-200` (register the panel, key `flags`, `onChange={load}`)
- Modify: `client/src/app.css` (only what the row needs; phone rules in `PHONE LAYOUT`)
- Test: `client/src/components/FlagsMenu.test.jsx`, `client/src/components/triage/FlagsPanel.test.jsx` (new), `client/src/components/triage/TriageSection.test.jsx`

**Interfaces:**
- Consumes: `FlagRow` (Task 3), `cardLink(row)` (`ResubmissionsPanel.jsx`), `UrgencyRing`, `PanelHead`, `ShowAllToggle`, `useShowAll`, `limitRows`, `CourseLine`, `MailLink`, `FlagDisc`.
- Produces: `FlagsMenu` prop `compact` (boolean, default false): the closed pill shows only the symbol (`FlagDisc` for a set flag, else the ⚑ icon) and the caret, with `aria-label` = the current `title`. `FlagsPanel({ rows, showCourse, scope, onChange })`.

- [ ] **Step 1: Write the failing tests**

```jsx
// FlagsMenu.test.jsx
it('compact shows the symbol only, with an accessible name', ...)
  // render <FlagsMenu compact exception={6} .../> → no visible text 'Late'; button name matches /Flag set in Schoology: Late/
// FlagsPanel.test.jsx
it('renders a row per flag with the student link, task, advice and day count', ...)
  // row kind 'flag', flag 6 → link href '/course/3/assessment/900?student=7', text of the advice, ring aria-label '4 school days'
it('tags a row submitted after the flag', ...)       // text 'Submitted after the flag'
it('a saved_grade row shows its advice and no flag symbol in the text', ...)
it('shows semester end in the subheading', ...)       // 'semester ends 18/12/2026' when rows share one end
it('empty state', ...)                                 // 'No flags waiting on you.'
it('a flag write reloads the rows', ...)               // mock setGradeFlag; after choosing Missing and confirming, onChange called
// TriageSection.test.jsx
it('includes the Flags panel and orders it by worst tone', ...)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd client && npx vitest run src/components/FlagsMenu.test.jsx src/components/triage/`
Expected: FAIL.

- [ ] **Step 3: Implement**

Panel copy: title `Flags`; badge `{n} urgent` (red rows) in `badge-red`; subheading `school days since flagged, semester ends {DD/MM/YYYY}` (for example `school days since flagged, semester ends 18/12/2026`); drop the second part when the rows have no single end. Empty: `No flags waiting on you.` Row: `UrgencyRing day={r.day} limit={r.limit} tone={r.tone} approx={r.approx} size={28}`; name `Link to={cardLink(r)}` (no `MailLink`: no email template exists for flags); a `FlagDisc` for `kind === 'flag'`; the amber tag `Submitted after the flag` when `submittedAfter`; `CourseLine` when `showCourse`; the task title; the advice line in `text-sm text-muted`. Actions: `<FlagsMenu compact size="sm" student={{ id: r.studentId, firstName: r.firstName }} assignmentId={r.assignmentId} exception={r.exception} score={r.score} aligned={r.aligned} panelHost={…row's own .triage-row__more div} onChange={onChange} />`. Five rows, then `ShowAllToggle` (`useShowAll(`flags.${scope}`)`).

- [ ] **Step 4: Run to verify they pass**

Run: `cd client && npx vitest run` (whole client suite: the em-dash guard and phone-layout tests run there). Expected: PASS.

- [ ] **Step 5: Check it in the real app.** `PORT=3002 npm run dev` (the preflight refuses a taken port), open the Dashboard on a dev database copy that has a flag (set one on the unpublished test task "AIML: Prism Flags Check (F)", `8619091769`, only after Graham approves that write), confirm the row, the compact control and the reload; `npm run check:mobile http://localhost:5173`; then `npm run dev:stop`. Screenshots hold student data: delete them after.

- [ ] **Step 6: Commit** `feat(triage): Flags panel with an in-row flags control (#174)`

---

### Task 6: Docs, verification and release

**Files:**
- Modify: `.claude/build-progress.md`, `.claude/powerschool-api-reference.md` (term ranges now stored per course, dated 2026-10-23), `docs/design-language.md` (the panel, the compact flags control), `docs/improvements-log.md` (status quo: a Schoology flag looks like a decision but leaves the task out of the grade; Prism lists every flag that favors the student, with a day count and the semester end), `AGENTS.md` only if a convention changed, `docs/superpowers/specs/2026-10-23-triage-flags-panel-design.md` (mark the two calls above as made).

- [ ] **Step 1:** Run every suite: `npx vitest run` at the root, `cd client && npx vitest run`, `npm run build`. Expected: all pass, build succeeds.
- [ ] **Step 2:** Run the house-style checker on every changed doc: `python3 <writing-style>/scripts/check_text.py --kind general --register official <files>`. Expected: 0 refused.
- [ ] **Step 3:** Commit the docs, fast-forward `main`, push (`git push -u origin main`). Confirm CI is green on that commit (`gh run list --branch main --limit 1`), then that prod serves it (`curl -s 127.0.0.1:3001/api/version`).
- [ ] **Step 4:** On prod after the next sync: `GET /api/triage` holds `flags`, and the courses have `term_start`/`term_end`. Ask Graham before reading prod data beyond the API.
- [ ] **Step 5:** Comment on #174 with the commits and evidence, then close it. Update the project memory `project_state.md` (shipped, next).
