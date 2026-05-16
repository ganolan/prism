# Issue #45 — Stale "missing" / "not started" flags on assignments

## Problem

Stale red flags such as "missing" and "late submission" appear on assignments
on the student page and never go away, even after the work is submitted or
graded.

## Root cause

Commit `743a68d` ("drop auto-flags") removed the auto-flag *generator* — code
in `server/routes/analytics.js` that scanned synced data and inserted rows
into the `flags` table with `flag_type` values `'missing'` and
`'late_submission'`. The generator code was deleted, but **the flag rows it
had already created were never removed.**

`StudentPage.jsx` still has dead handling for those rows:

- `isAutoFlag = ['missing', 'late_submission'].includes(f.flag_type)`
  ([StudentPage.jsx:687](../../../client/src/pages/StudentPage.jsx#L687)).
- For `isAutoFlag` rows the Resolve/Reopen and Delete buttons are **suppressed**
  ([:712](../../../client/src/pages/StudentPage.jsx#L712),
  [:719](../../../client/src/pages/StudentPage.jsx#L719)); a static
  "Auto from Schoology" label is shown instead
  ([:722](../../../client/src/pages/StudentPage.jsx#L722)).

So every legacy `missing` / `late_submission` flag is a permanent, un-removable
red badge — in the per-assignment grade rows and in the Flags list — with no
process left to keep it accurate or clear it.

Submission status (missing / late) is now derived live from Schoology and
rendered as inline badges by `submissionStatus()`. The stored flags are
therefore both redundant and frequently wrong.

Additionally, the flag-creation form still offers "Late Submission"
([:676](../../../client/src/pages/StudentPage.jsx#L676)) — creating one would
immediately produce a new flag that the `isAutoFlag` guard makes un-deletable.

### Scope clarifications

- The **gradebook** (`GradebookView` in `CoursePage.jsx`) does not render
  stored flags at all — only live-derived submission-status badges. The stale
  flags surface only on the **student page**. The issue's "(and elsewhere?
  needs testing)" is resolved here.
- `'performance_change'` and `'review_needed'` were also auto-flag types, but
  both remain valid *manual* flag types in the creation form and are not
  subject to the `isAutoFlag` button-suppression, so they are not stuck and
  are out of scope. Distinguishing their legacy-auto instances from
  manually-created ones is not reliably possible and not needed.

## The fix

### 1. Purge migration (server)

Delete all `flags` rows of type `'missing'` or `'late_submission'`, regardless
of when or how they were created. Per the project directive — Schoology is the
single source of truth for submission status — both types only duplicate the
live inline badges, so no manually-created instance is worth preserving.

`server/db/index.js` is refactored for testability:

- Extract a `migrate(db)` function that runs `schema.sql`, the incremental
  migration list, and then the purge.
- Extract `purgeLegacyAutoFlags(db)` — a named function running
  `DELETE FROM flags WHERE flag_type IN ('missing', 'late_submission')`.
- `getDb()` opens the database and calls `migrate(db)`.

Both `migrate` and `purgeLegacyAutoFlags` are exported so the server test can
drive them against an in-memory database.

The purge is idempotent — running it on every boot is harmless (after the
first run there is nothing to delete, and the form no longer creates these
types). It doubles as a permanent guard.

### 2. StudentPage cleanup (client)

- Remove the `isAutoFlag` constant and both `!isAutoFlag` guards, so every
  flag row shows Resolve/Reopen and Delete buttons.
- Remove the "Auto from Schoology" label branch.
- Remove the `<option value="late_submission">Late Submission</option>` from
  the flag-type `<select>`. Remaining options: Custom, Review Needed,
  Performance Change.
- Simplify `formatFlagReason()` — its `['missing', 'late_submission']` branch
  (which stripped a legacy `"Missing: "` prefix) is dead once those rows are
  purged; reduce it to returning `flag.flag_reason`.

No change is needed to the per-assignment flag rendering or the gradebook —
once the rows are gone, nothing renders them.

## Testing

### Server test harness (new)

This is the first server-side test. Set up a minimal harness:

- Add `vitest` as a root `devDependency`.
- Add a root `vitest.config.js` scoped to server tests
  (`include: ['server/**/*.test.js']`, `environment: 'node'`).
- Add a root `package.json` script: `"test:server": "vitest run"`.

Add `server/db/index.test.js`:

- Create an in-memory `better-sqlite3` database, run `migrate(db)` to build
  the schema.
- Seed `flags` rows of types `missing`, `late_submission`, `custom`,
  `review_needed`, and `performance_change`.
- Call `purgeLegacyAutoFlags(db)`.
- Assert: `missing` and `late_submission` rows are gone; `custom`,
  `review_needed`, and `performance_change` rows remain untouched.
- Assert idempotency: a second `purgeLegacyAutoFlags(db)` call changes nothing.

### Client test

Add a Vitest + React Testing Library test for the StudentPage Flags section
(following `AssessmentSummaryPage.test.jsx` for API mocking):

- A rendered flag row of any type shows a Delete button (no row is
  button-suppressed).
- The flag-type `<select>` does not contain a "Late Submission" option.

## Out of scope

- Any redesign of the flags feature or reintroduction of auto-flagging.
- Legacy auto-created `performance_change` / `review_needed` rows — these are
  already user-manageable and indistinguishable from manual flags.
- The live-derived submission-status badges, which are correct and are the
  intended replacement for the dropped auto-flags.
