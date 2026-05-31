# Archived-Course Parity + Always-Fresh Student Data — Design

**Issue:** (no dedicated issue yet — derived from the #5/#69 archived-course follow-ups;
relates to #58 "Simplify Sync", #52 "mastery staleness", #66/#65 PowerSchool PII.)
**Date:** 2026-05-31
**Status:** Approved design, pending implementation plan
**Scope:** **Sub-project A** of a two-part effort. Sub-project B (archived-import UX —
year/semester grouping, checkbox select-all/select-year, modal progress) is a separate
later spec. This spec is **backend data-correctness only**.

## Problem

Three gaps in how Prism handles courses as the academic year turns over:

1. **No current→archived transition.** `fullSync` (`server/services/sync.js:459`)
   enumerates sections via `getMySections` → `/v1/users/{id}/sections`
   (`schoology.js:80`), which returns **active sections only**. On upsert it hardcodes
   `archived=0` and never updates `archived` on conflict; nothing detects a
   previously-synced active course dropping off the active list. So when a course is
   archived on Schoology between syncs, the recurring sync simply *stops touching it* —
   the DB row keeps `archived=0` and its **stale data**, lingering in the **Current**
   tab. The `includeArchived` toggle (`sync.js:574`) is inert (it only un-skips
   DB-archived courses that are *still active*, which past courses never are).

2. **Archived imports lack mastery + full student data.** `POST /api/courses/import`
   (`courses.js:260`) calls `syncSectionData` (gradebook, public OAuth) but **not**
   mastery, and **not** the profile-enrichment loop. Mastery for archived sections is
   confirmed to work (the user has synced it via the Step 2 group), so it should be
   captured automatically.

3. **Student data goes stale — a safeguarding risk.** Course gradebook + mastery are
   immutable once a course is archived, **but student data is not**: students move up
   years into new courses; parent contacts change. `fullSync` already re-fetches every
   student's profile each sync (`sync.js:648–700`, `SELECT … FROM students WHERE
   schoology_uid IS NOT NULL`), but it **upserts parents without reconciling** — a
   removed/changed guardian row **lingers** (the "wrong parent contact" hazard) — and
   the import path skips enrichment entirely.

**Organising principle: immutability is per-data-type.** Gradebook + mastery freeze at
archive time. **Student data never freezes** — it is refreshed (and reconciled) every
sync for **every retained student**, including students in no active course.

## Decisions (confirmed with the user, 2026-05-31)

| Decision | Choice |
|---|---|
| Detect a course as archived | **Confirm via section read** — only archive a dropped course when `GET /sections/{id}` returns `active:0`; `active:1` → leave (transient/ambiguous); 404/error → mark archived but keep last snapshot |
| What "finalise" captures | **Gradebook + mastery only** (the immutable snapshot). **Not** student data |
| Student data | **Never frozen** — refreshed + **reconciled** every sync for all retained students; also enriched at import time for immediacy |
| Parent reconciliation safety | Reconcile (delete guardians no longer returned) **only on a successful `getUserProfile`**; a failed fetch never wipes contacts (preserve last-known) |
| Mastery when browser session is dead | Skip mastery (it can't change post-archive); capture it on a later session-enabled sync. Gradebook + profiles always run (public OAuth) |
| `finalized_at` semantics | **"mastery sync has run for this archived course"** — set only when mastery actually ran (session present); left null otherwise so backfill retries |
| Existing archived courses | **Backfill once** on next (session-enabled) sync |
| Redundant surfaces | **Remove** the "Include archived" toggle (+ plumbing) and the Step 2 "Archived courses" mastery group. Keep `includeHidden` and the visible/hidden mastery groups |
| PowerSchool safeguarding (deceased, do-not-contact, SEN) | **Out of scope** → #66/#65 (freshness notes added there 2026-05-31) |

## Architecture

### 1. `enrichStudentProfiles(db, students, now)` — extracted, with parent reconciliation

Extract the inline loop at `sync.js:648–700` into an exported function. `students` is a
list of `{ id, schoology_uid }`.

For each student, `getUserProfile(uid)` (`schoology.js:103`, public OAuth):
- **On success:**
  - Update `students`: `email` (latest wins via `COALESCE(?, email)` keeps current
    behaviour of filling/refreshing), `grad_year`, preferred-name handling unchanged
    (teacher override `preferred_name_teacher` untouched).
  - **Reconcile `parents`:** upsert every guardian in `profile.parents?.parent` (by
    `(student_id, schoology_uid)`), then **delete** the student's `parents` rows whose
    `schoology_uid` is **not** in the fetched set. This removes stale/removed guardians.
- **On failure** (profile inaccessible — e.g. a graduated student the teacher can no
  longer read): log + **skip** (no update, **no parent deletion**) — preserve last-known.

`fullSync` calls it with **all** students (unchanged coverage). The import path calls it
with the imported section's students. Students are **never deleted** (retention),
including those with no active enrolment.

### 2. `finalizeArchivedCourse(db, { courseId, sectionId, now, runMastery })` — immutable snapshot

A single operation reused by import, transition, and backfill:
1. `syncSectionData(db, sectionId, courseId, now)` — gradebook (enrollments, assignments,
   grades), public OAuth (`sync.js:51`).
2. If `runMastery` **and** `hasMasterySession()` (`masterySync.js`):
   `syncMasteryForCourse(courseId, { allowInteractiveLogin: false })` — the existing,
   working mastery sync. On success (even if it finds no SBG data), set
   `courses.finalized_at = now`. If the session is absent, **skip** and leave
   `finalized_at` null.
3. Does **not** enrich student profiles (that is job #1).

Returns the gradebook counts + whether mastery ran.

### 3. Import path — `POST /api/courses/import` (`courses.js:260`)

After upserting the course row (`archived=1`):
1. `finalizeArchivedCourse(db, { courseId, sectionId, now, runMastery: true })` (the
   discovery flow always has a session, so mastery is captured + `finalized_at` set).
2. `enrichStudentProfiles(db, <the section's students>, now)` — so a just-imported
   archived course's students have contacts immediately (closes the 2b gap).

### 4. Transition detection — in `fullSync`, every sync

After the active-section sync loop, compute **dropped** courses: rows with
`archived = 0 AND excluded = 0 AND synced_at IS NOT NULL` whose `schoology_section_id`
is **not** in the active set returned by `getMySections`. For each dropped course,
`GET /sections/{id}`:
- **`active == 0`** → `finalizeArchivedCourse({ runMastery: hasMasterySession() })`, set
  `archived = 1`, refresh `grading_period` from the section.
- **`active == 1`** → leave as-is (still active elsewhere / transient drop — do **not**
  archive). Log.
- **404 / error** → set `archived = 1` only (section gone/inaccessible — keep the last
  snapshot, no data refresh). Log.

### 5. Backfill once — in `fullSync`

For archived courses with `finalized_at IS NULL`, run
`finalizeArchivedCourse({ runMastery: hasMasterySession() })` once. Captures mastery for
courses imported under the old flow. Converges on the next session-enabled sync; never
re-runs once `finalized_at` is set. (Gradebook re-runs are idempotent/harmless on
session-less syncs until mastery is captured.)

### 6. fullSync ordering

Active-section sync loop → **transition detection (4)** → **backfill (5)** → **global
student enrichment (1)** over all students (the relocated/extended `sync.js:648` loop,
now reconciling parents). Student coverage is order-independent (transitioned/backfilled
courses' students already exist in the DB), but this order keeps everything in one pass.

### 7. Remove redundant surfaces

- **"Include archived" toggle:** remove the `includeArchived` checkbox in `SyncConfig`,
  the `includeArchived` argument through `client/src/services/api.js` → `POST /api/sync`
  (`routes/schoology.js`) → `runUnifiedSync` (`syncOrchestrator.js`) → `fullSync`, and the
  `if (courseRow.archived && !includeArchived) { … continue; }` skip at `sync.js:574`.
  Keep `includeHidden` end-to-end (hidden ≠ archived).
- **Step 2 "Archived courses" mastery group:** remove the `archived` entry from the
  `GROUPS` array in `SyncConfig.jsx` (archived mastery is now automatic). Keep the
  `visible` and `hidden` groups (active-course mastery selection is unaffected).

### 8. Migration

Append `` `ALTER TABLE courses ADD COLUMN finalized_at TEXT` `` to the incremental
migrations list in `server/db/index.js` (duplicate-column errors are already ignored
there).

## Testing (TDD, server — `npx vitest run`)

- **`enrichStudentProfiles`:** on a successful profile fetch, a guardian removed from the
  profile is **deleted** from `parents`, a new one is inserted, email/grad_year update;
  on a **failed** fetch, existing parents are **preserved** (not deleted) and the student
  row is untouched; the student is **never deleted**. (Inject a fake `getUserProfile`.)
- **`finalizeArchivedCourse`:** runs gradebook always; runs mastery and sets
  `finalized_at` **only** when the session is present; with no session, gradebook runs,
  mastery is skipped, `finalized_at` stays null. (Inject fakes for `syncSectionData` /
  `syncMasteryForCourse` / `hasMasterySession`.)
- **Transition detection:** given an active set and DB courses, the dropped set is
  computed correctly; `active:0` → finalise + `archived=1`; `active:1` → unchanged; 404 →
  `archived=1` with no data refresh. (Inject fake `getMySections` + section fetch.)
- **Backfill:** archived courses with `finalized_at IS NULL` are finalised once when a
  session is present; skipped (left null) when absent; never re-run once set.
- **Import route:** after `POST /api/courses/import`, the course is finalised (mastery
  attempted) and the section's students have profiles + reconciled parents.
- **Removals:** delete the `includeArchived` tests; update `SyncConfig` tests to drop the
  archived mastery-group assertions; confirm `includeHidden` still works.
- Full server + client suites stay green.
- **Live verification:** run a sync and confirm (a) a course archived on Schoology moves
  to the Archived tab with refreshed data, (b) an existing archived course gets mastery
  backfilled, (c) a student's removed guardian disappears after a sync, (d) the Sync
  dialog no longer shows the "Include archived" toggle or the Step 2 archived group.

## Out of scope (deliberate)

- **Sub-project B** — the archived-import UX (year/semester grouping for cards + the
  import list, checkbox select-all/select-year, per-year "Import all", modal progress +
  auto-refresh). Separate spec.
- **PowerSchool safeguarding PII** (deceased / do-not-contact guardians, SEN/accommodation
  plans) — not synced here; tracked in **#66** and **#65**, where the same
  refresh-and-reconcile-every-sync principle has been recorded (2026-05-31).
- **Sync performance** — enriching all retained students every sync (now with parent
  reconciliation) grows as archived students accumulate. Accepted as the cost of
  safeguarding freshness; optimisation (e.g. parallel profile fetches) is deferred and
  overlaps #55.
- **Re-syncing imported archived courses' gradebook/mastery beyond the one-time capture**
  — they are immutable; the manual archive/un-archive toggle (`PUT /:id/archive`) remains
  the only override.
