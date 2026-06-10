# Sync & display student grade level — design (#43)

**Date:** 2026-06-10
**Issue:** #43 (Sync and display student grade and graduating year)
**Related:** #106 (block-number sync — the pass we extend), #116 (follow-up probe of a date-free PT-v1 source), #73 (grade-level roster filter — future consumer)

## Problem

Prism has a `students.grad_year` column and a profile badge that renders "Grade N (Class of YYYY)",
but the column is never populated for students: the Schoology user profile only returns `grad_year`
for staff, not students (the existing read in `server/services/sync.js` is a no-op for students).
So the badge never shows, and there is no grade-level column on the search page or class roster.

The authoritative source is PowerSchool. The Schoology→PowerSchool attendance LTI app exposes per-student
`gradeLevel` (9–12) via `GET /ws/attendance/section_attendance`, joined to Prism students by
`students.school_uid === '1_' + ps.dcid`. See `.claude/powerschool-api-reference.md`.

## Spike outcome (2026-06-10)

We checked whether a date-free endpoint could supply `gradeLevel` (avoiding the in-session-date
dependency). Verified live (`scripts/probe-ps-gradelevel-source.js`, ACSS sectionDcid 49355):

- `POST /teachers/mba_alerts/queries/getStudentsInSection.json` is date-free (body `sectionIds={dcid}`)
  but returns **roster identity only** (`ccid, sectionid, lastfirst, studentid, studentdcid`) — **no
  `gradeLevel`**. Not a grade source.
- `/ws/pt/v1/student/...` did **not** fire on the grid render; unprobed. Filed as **#116** (low priority —
  a cleaner-source optimization, not a blocker).
- `/ws/attendance/section_attendance` re-confirmed as the only working `gradeLevel` read; it needs an
  in-session date, which we derive for free from the `section_info` calendar we already fetch.

**Decision:** use `section_attendance` + an in-session date from `section_info.calenderDays`.

## Storage model — store the invariant

Persist `grad_year` (graduating year), **not** the raw current grade. `gradeLevel` is time-relative
("Gr 12" means nothing without the year it was observed); `grad_year` is time-invariant ("Class of 2026"
forever). A departed student stops being re-synced and their stored value freezes — a frozen `grad_year`
stays correct indefinitely, whereas a frozen `gradeLevel` re-derived against the current year would drift
wrong every rollover. For active (re-synced) students the two are equivalent; the distinction only matters
for departed students, which is exactly when correctness matters.

- Compute once per sync: `grad_year = schoolYearEndYear + (12 − gradeLevel)`
  (2025-26 → `schoolYearEndYear = 2026`; G12→2026, G11→2027, G10→2028, G9→2029).
- Display derives the current grade on read: `grade = 12 − (grad_year − schoolYearEndYear)`, shown only
  when 1–12; a departed student (derived grade > 12) shows "Class of YYYY" with no grade.
- **No schema change** — reuse the existing `students.grad_year` column.

(This supersedes the earlier "store grade_level, derive grad_year" note in the api-ref, which assumed
continuous re-sync; corrected there 2026-06-10.)

## Architecture — Approach A: generalize the block-number sync

`server/services/blockNumberSync.js` already performs the exact per-active-course pass we need
(shared PS session, `sectionDcid` resolution, `section_info` fetch). We generalize it rather than add a
second PowerSchool pass (a sibling service would re-establish the session and re-resolve every section →
roughly doubles that phase's wall-time; rejected on perf — see #55/#108).

**Rename** `server/services/blockNumberSync.js` → `server/services/psAttendanceSync.js`, exporting a single
`syncPsAttendance({ onProgress, courseIds })` that resolves block number (per-course) **and** grade level
(per-student) in one loop. Update the two call sites:
- `server/routes/courses.js` (archived-course import, currently `syncBlockNumbers({ courseIds: [id] })`)
- `server/services/syncOrchestrator.js` (regular-sync block phase)

Pure functions stay isolated and unit-testable:
- `server/lib/psBlockNumber.js` — unchanged (`pickBlockNumber`, `sectionDcidFromLaunchForm`).
- `server/lib/psGradeLevel.js` — **new**:
  - `pickInSessionDate(sectionInfo, today)` → most recent in-session day ≤ today, else earliest future
    in-session day, else `null`.
  - `extractGradeLevels(sectionAttendanceJson)` → `[{ dcid, gradeLevel }]`.
  - `gradeLevelToGradYear(gradeLevel, schoolYearEndYear)` → integer grad year.
  - `currentSchoolYearEndYear(date)` → August-rollover school-year-ending calendar year (server-side
    mirror of the client's existing `gradYearToLevel` rollover logic).

## Data flow (per active course, inside the existing loop)

1. Resolve `sectionDcid` from the LTI launch-form HTML (existing Schoology fetch). Also read
   `custom_userdcid` from the same form for the `section_attendance` call.
2. Fetch `section_info` (existing) → block-pick **and** `pickInSessionDate(section_info, today)`.
3. If an in-session date exists, fetch
   `GET /ws/attendance/section_attendance?sectionDcid={dcid}&userDcid={userDcid}&startDate={d}&endDate={d}&includeStudentAlerts=false&multiSections=false&sortByFirstName=false`
   → `extractGradeLevels(...)`.
4. Accumulate results into a `Map<dcid → gradeLevel>` across the whole loop (dedupes a student enrolled in
   multiple of the teacher's sections; same value, last-write-wins).
5. **After** the loop: one batched `UPDATE students SET grad_year = ? WHERE school_uid = '1_' || ?`, one row
   per `dcid` in the map. Only rows we have data for are touched — a student not seen this sync keeps their
   existing `grad_year` (never nulled).

Grade-level extraction inherits the block sync's current-year scoping for free: prior-year/archived sections
fail `section_info` → no in-session date → grade skipped, self-healing on a sync when an in-session day exists.

### `userDcid` caveat (confirm during build, low risk)

Today's probe used `userDcid=10005` and the api-ref notes PowerSchool resolves the real user from the session
(`userDcid` only scopes "attendance taken by"), so the roster + `gradeLevel` should return regardless of the
value passed. We pass the launch form's `custom_userdcid` (prefix stripped) and verify the roster returns
during implementation. If it gates the roster unexpectedly, fall back to the probe's known-good value path.

## Display (frontend only — `grad_year` already returned by `SELECT * FROM students`)

- Extract `gradYearToLevel()` out of `StudentPage.jsx` into a shared **`client/src/lib/gradeLevel.js`**:
  - `gradYearToLevel(gradYear)` (existing logic), and
  - `formatGradeBadge(gradYear)` → `{ grade, classOf, label }` for consistent rendering.
- **Profile** (`StudentPage`): badge already renders once `grad_year` is populated — active → "Grade 11 ·
  Class of 2027"; departed (derived grade > 12 → `null`) → "Class of 2026" with no grade. Reuse the shared
  helper (behaviour unchanged).
- **Search** (`SearchPage`): add a **Grade** column (currently Name / Email).
- **Class roster** (per-course student table): add a **Grade** column. Confirm its endpoint returns
  `grad_year` (the `SELECT *` pattern indicates yes); pin the exact roster route in the plan.

## Orchestration & opt-out

The orchestrator's existing block phase becomes a "PowerSchool attendance" phase that reports **both** block
and grade-level counts in its summary/events. The existing `syncBlocks` opt-out now gates the whole PS pass
(block + grade). Best-effort and non-fatal, exactly as today: a stale PS session logs an error but never
aborts the overall sync.

## Testing

- **Server unit** (`server/lib/psGradeLevel.test.js`): `pickInSessionDate` (recent-past / start-of-year
  fallback / none), `extractGradeLevels` from a masked `section_attendance` fixture, `gradeLevelToGradYear`
  and `currentSchoolYearEndYear` math including the August rollover.
- **Server integration** (beside `psAttendanceSync`): the batched update + `'1_' + dcid` join against a
  seeded DB and a fixture payload; assert a not-seen student's `grad_year` is preserved (not nulled).
- **Client**: `client/src/lib/gradeLevel.test.js` (active grade, graduated → no grade, rollover); column-render
  tests for `SearchPage` and the roster; `StudentPage` badge test (active vs graduated).

## Out of scope / follow-ups

- `/ws/pt/v1/student` date-free demographics/grade probe (#116).
- Grade-level filter on the combined roster (#73) — this feature provides the data it will consume.
- A general roster "Grade" sort/filter beyond a display column.

## Acceptance (from #43)

- Grade level synced from PowerSchool and stored as `grad_year`.
- Grade level visible on the student profile, the student search page, and the class roster.
- Existing server + client suites stay green; new logic covered by tests.
