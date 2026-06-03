# Skip per-cell submission detection when finalising archived-course imports

**Issue:** [#72](https://github.com/ganolan/prism/issues/72) (Wave A — Sync correctness & finish)
**Date:** 2026-06-03
**Status:** Design approved

## Problem

Archived-course import (#71 shipped the UX) is correct but **slow for grade-heavy
courses** (e.g. AP CS Principles). The wall-time dominator is the per-(assignment,
student) submission-status loop in `syncSectionData`.

`finalizeArchivedCourse` (`server/services/sync.js:533`) calls
`syncSectionData(db, sectionId, courseId, now)` with **no opts**, so
`submissionLookup` is null and it runs `GET /sections/{id}/submissions/{aid}/{uid}`
for every dropbox cell at the default concurrency (2), with no pre-filter. The
recurring sync mitigates this by passing `fetchSubmissionLookup` + concurrency opts
(`sync.js:712`), but the GHD pre-filter it relies on (`grader_header_data`) is
**blind for archived/inactive sections** (probed 2026-06-01: archived AP CSP
`7361043994` returned HTTP 200 but 0 submissions / 0 grades), so it cannot help here.

## Determination (with the user, settled before this spec)

Imported archived courses are **immutable** (#70) and do **not** need per-cell
OneDrive/GDrive (`lti_submission`) M/NS or resubmission detection — that's a
live-course grading-workflow signal, frozen for completed courses. So archived
finalisation **skips the submission-status loop entirely**. The bulk
`GET /sections/{id}/grades` (one call) already provides scores, so the bulk import
suffices.

Confirmed during this brainstorm:
- **Skip scope:** skip the *whole* loop for all archived dropbox assignments (not a
  partial lti-only skip). Native-dropbox `late`/`draft` detection is intentionally
  given up for archived courses.
- **Observability:** emit one diagnostic log line per finalised course.

## Design

### Change 1 — `syncSectionData` gains a `skipSubmissions` opt (`server/services/sync.js`)

Add `skipSubmissions = false` to the opts destructure (~line 57). Apply it by
short-circuiting the dropbox-assignment list (~line 206):

```js
const dropboxAssignments = skipSubmissions
  ? []   // #72: archived = frozen; skip the per-cell submission loop entirely
  : assignments.filter(a => a.allow_dropbox === '1' || a.allow_dropbox === 1);
```

An empty list makes every downstream step a clean no-op with no further edits:
- the `fetchSubmissionLookup` fetch is guarded by `dropboxAssignments.length` (line 211) → stays null;
- the `for (const a of dropboxAssignments)` loop (258) does not iterate;
- `writeSubmissions([])` is a no-op;
- returned counters (`submissionCount`, `submissionAttempts`, `submissionSkipped`,
  `failedAssignmentIds`, `submissionAbandoned`) come out at their zero/empty values.

**Shape rationale:** chosen over wrapping the ~90-line phase in `if (!skipSubmissions)`
— the short-circuit is a one-line, surgical diff with clean blame, and the empty-list
semantics are already exercised by the existing dropbox filter.

The **active recurring sync (`fullSync`) never passes `skipSubmissions`**, so its
behaviour (`fetchSubmissionLookup`, concurrency, GHD pre-filter, abandon/retry) is
completely unchanged.

### Change 2 — `finalizeArchivedCourse` passes the opt + logs (`server/services/sync.js:533`)

```js
const c = db.prepare('SELECT course_name, grading_period FROM courses WHERE id = ?').get(courseId) || {};
const period = c.grading_period ? ` — ${c.grading_period}` : '';
console.log(`[archived] "${c.course_name || sectionId}"${period} (section ${sectionId}): skipped per-cell submission detection (frozen)`);
const counts = await syncSectionData(db, String(sectionId), courseId, now, { skipSubmissions: true });
```

The log line carries **course name**, **year/semester**, and the **section id**.
Year/semester comes from the raw `courses.grading_period` text (e.g.
`"Semester 1: 08/14/2024 - 01/11/2025"`), which already encodes both the semester
label and the date range the year is derived from. We log the raw field rather than
the parsed `{ academicYear, semester }` form — the parser (`parseGradingPeriod` in
`client/src/lib/courseDisplay.js`) is client-side, and relocating it to a shared
module is out of scope for a diagnostic log line. `finalizeArchivedCourse` is the
single chokepoint for all three archived paths —
**import** (`courses.js:298`), **transition** (`detectArchivedTransitions:573`), and
**backfill** (`backfillUnfinalizedArchived:589`) — so this one edit covers them all.
Log prefix follows the codebase idiom (`[masterySync]`, etc.).

### Frozen-state behaviour (accepted tradeoff)

With the loop skipped, `late` / `draft` / `submission_type` / `latest_revision_at`
come from the grades INSERT alone (`sync.js:146`):
- **Fresh import:** `late=0, draft=0, submission_type=NULL` (INSERT literals / DB
  defaults). For ungraded cells this matches the *old* behaviour exactly (empty
  revisions → no row), just faster.
- **Re-finalisation** (backfill of an old-flow import, or a re-import): the grades
  `ON CONFLICT` clause deliberately does not touch those columns, so existing values
  are **preserved (frozen), not cleared** — no extra clear step, and a re-import
  never wipes previously-detected badges.
- **Only delta:** freshly-imported *native-dropbox* archived work won't get
  `late`/`draft`. Accepted per the determination.

## Testing (`server/services/sync.test.js`)

1. **Direct skip-opt unit test** on `syncSectionData`: seed a dropbox assignment +
   student, call with `{ skipSubmissions: true }` → assert `getSubmissionStatus` is
   **not** called, `result.submissionCount === 0`, and the grades-phase row is intact.
2. **finalizeArchivedCourse**: with a dropbox assignment mocked, assert
   `getSubmissionStatus` is **not** called.
3. **detectArchivedTransitions**: same negative assertion (routes through finalize).
4. **backfillUnfinalizedArchived**: same negative assertion.

The active-sync path stays covered by the existing GHD tests (`sync.test.js:391`
already proves the public API *is* called when not skipping → confirms the opt
defaults off). `courses.test.js` mocks `finalizeArchivedCourse`, so it is unaffected.

## Docs

Fold in the issue's TODO: add the "`grader_header_data` is blind for archived/inactive
sections" limitation to `.claude/schoology-api-reference.md`.

## Out of scope

- Mastery sync (~20–40s/course) — the inherent archived-import floor.
- Any change to active recurring-sync submission behaviour (concurrency, GHD
  pre-filter, abandon/retry) — that is #55's broader scope.

## Manual verification (user's call)

Time a real archived import (e.g. AP CSP) before/after. Hits live Schoology and
mutates the DB, so it is run by the user, not the automated suite.

## Workflow

Brainstorm (done) → writing-plans → subagent-driven TDD, as #69/#70/#71.
