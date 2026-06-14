# LTI submission-status: retry, persist outcome, and stop showing "Ungraded"

**Date:** 2026-06-14
**Status:** Approved (design) — pending implementation plan
**Area:** Sync (`server/services/sync.js`), gradebook grid (`client/src/pages/CoursePage.jsx`, `client/src/lib/gradeLabel.js`)

## Problem

In the gradebook grid, OneDrive (lti_submission) cells that Prism has **no submission
state** for render a `·` dot with the tooltip **"Ungraded"** (`gradeLabel.js` `ltiBadges`,
the `state == null && overdue` branch). This is misleading on two counts:

1. *Every* unscored cell in the gradebook is technically ungraded, so singling these out
   as "Ungraded" is confusing — and it reads as a grading state when the cell's actual
   problem is **submission** status.
2. The real meaning is **"Prism couldn't read the submission status,"** i.e. *unknown* —
   not "submitted, awaiting grade" and not "didn't submit."

Observed case (ACSS, 2026-06-13 sync): two identically-configured choice projects, *IoT
Smart System* (id 33) and *AR Experience* (id 32), both LTI/OneDrive, both due 10 Jun, each
assigned to 2 students. IoT captured `lti_submission_state='submitted'` for both assignees
→ green `S`. AR captured **nothing** for either → `·`/"Ungraded". Both synced in the same
run on the same session, so AR's blank is a **transient capture failure**, not a real
difference in how students submitted.

## Verified background (do not re-derive)

- **The LTI fetch is bulk per-assignment, all-or-nothing.**
  `fetchAssignmentSubmissionState` (`server/services/graderDocuments.js`) makes exactly two
  calls per assignment — `/iapi2/assignments/{aid}/submitted-documents/` and
  `/in-progress-documents/` — each returning the whole roster. If both return null it
  returns `null` and the sync skips the entire assignment. There is **no per-cell fetch**,
  so one cell cannot fail while a sibling succeeds. A lone null cell among populated
  siblings only happens when a student is genuinely absent from both Schoology lists (rare
  data condition, not a sync failure). This is the documented #62 mechanism; a bulk
  endpoint already exists — no API spike is needed.
- **A failed fetch erases state; it never corrupts it.** `not_started` / `in_progress` /
  `submitted` only exist when the fetch succeeded. A failure yields `null` (nothing
  stored), so a failure can never produce a *wrong* NS/IP — only "unknown". Therefore the
  warning must key on *"the fetch failed,"* not on the due date (gating on overdue would
  hide pre-due failures, which null out IP/NS just the same).
- **Retry today covers native dropbox only.** `retrySubmissions` (`sync.js:360`) retries
  *public-API* (native dropbox) transient errors via `failedAssignmentIds`, and runs
  *after the browser is closed* (`sync.js:770`). The LTI document fetch
  (`sync.js:326-343`) is `try { … } catch { null }; if (!stateMap) continue;` — fire-once,
  swallow-all, never tracked, never retried. This asymmetry is the root cause of the AR
  blank.

## Design

Three layers, retry first so the warning is genuinely rare.

### Layer 1 — Retry the LTI fetch (root-cause fix)

When `opts.fetchDocuments(assignmentId)` returns `null`, retry **once** (2 attempts total)
with a short fixed backoff (~750 ms), inline in the `sync.js` LTI loop while the browser
session is still open. Only when the retry also returns null do we treat the assignment as
failed.

- Add a small generic helper `retryAsync(fn, { attempts, backoffMs, sleep })` in
  `server/lib/` (injectable `sleep` so tests pass `backoffMs: 0`), unit-tested
  independently.
- "No session" is unaffected: when there is no saved session, `createSubmissionFetcher`
  returns null up front, `opts.fetchDocuments` is `undefined`, and the whole loop is
  skipped — no retries, no status writes (see Layer 2's "untouched" rule).

### Layer 2 — Persist the per-assignment fetch outcome

Add `lti_fetch_status TEXT` to `assignments` (`'ok'` | `'failed'`; `NULL` = never
attempted).

- **Schema:** append `ALTER TABLE assignments ADD COLUMN lti_fetch_status TEXT` to the
  `MIGRATIONS` array in `server/db/index.js`, and add the column to the `assignments`
  definition in `server/db/schema.sql` (for fresh DBs), matching the existing
  "(migration-added)" pattern.
- **Sync loop (`sync.js:326-343`):**
  - fetch (after retry) returns a map → write states as today **and** set
    `lti_fetch_status = 'ok'`.
  - fetch returns null after retry → set `lti_fetch_status = 'failed'` (instead of bare
    `continue`).
  - assignment not in `ltiAssignments` (windowed-out / old), or the whole loop skipped (no
    session) → **leave `lti_fetch_status` untouched**. This is why old/undated work never
    false-flags and why the flag self-clears on a later successful full sync.
  - Use a prepared `UPDATE assignments SET lti_fetch_status = ? WHERE id = ?` keyed on the
    resolved `assignRow.id`.

### Layer 3 — Serve it and fix the display

- **Route:** add `a.lti_fetch_status` to the gradebook assignment SELECT
  (`server/routes/courses.js:151-152`).
- **`gradeLabel.js`:**
  - In `ltiBadges`, delete the `state == null && overdue → 'Ungraded'` branch; the
    null/unknown path now returns `[]` in all cases. (Keep the `submission_type →
    'submitted'` fallback and the NS/IP/S branches.)
  - Add a pure predicate
    `ltiStatusUnavailable({ is_lti_submission, lti_fetch_status, score, exception })` →
    `lti_fetch_status === 'failed' && score == null && !exception`.
- **`CoursePage.jsx` (GradebookView grid cells):**
  - Remove `ungraded: '·'` from `SHORT_BADGE` (`:20`).
  - In both grid-cell badge branches (the no-grade-row path `:903-916` and the
    score-null path `:961-1016`), evaluate the predicate with the assignment's
    `lti_fetch_status` plus the cell's `score`/`exception`
    (`ltiStatusUnavailable({ is_lti_submission: a.is_lti_submission, lti_fetch_status:
    a.lti_fetch_status, score: g?.score ?? null, exception: g?.exception })`); when true,
    render an amber `⚠` marker in place of the now-empty badge list. Hover wires the existing
    `setPopover` with: *"Submission status unavailable — Prism couldn't read OneDrive
    submissions for this assignment at the last sync (it retried once). Re-sync to refresh;
    if your Schoology session has expired, run `mastery:login` first."* A static `title`
    gives a fallback tooltip.
  - The per-assessment `SubmissionBadges` view (`:577`) is unaffected — it shows real
    states only.
- **CSS:** add a small `.lti-unavailable` marker class coloured with `var(--warning)`
  (modelled on `.help-dot`); no hardcoded hex.

### Resulting cell behaviour (LTI, ungraded, non-excepted)

| `lti_fetch_status` | captured state | Cell shows |
|---|---|---|
| `'ok'` | submitted / in_progress / not_started | `S` / `IP` / `NS` (unchanged) |
| `'ok'` | null (student absent from both lists) | `—` (blank — genuine, rare; not a failure) |
| `'failed'` | null (all cells) | amber `⚠` + re-sync popover |
| `NULL` (never attempted) | null | `—` (blank — we don't claim a failure) |

A whole-assignment failure lights up `⚠` on **every** ungraded, non-excepted assignee, so
it's impossible to miss; graded and excepted cells stay clean.

## Edge cases

- **Session expired mid-sync:** assignments processed before expiry stay `'ok'`; ones after
  get `'failed'`. The popover's `mastery:login` hint covers this. A persisted `'failed'`
  keeps warning until a session-enabled sync clears it — truthful behaviour.
- **Single-LTI-assignment course / all LTI failed:** still handled correctly — Layer 2
  keys on the assignment's own recorded outcome, not on sibling comparison, so there's no
  dependence on a "working sibling".
- **Isolated student absent from both lists** (fetch succeeded): renders `—`, not warned —
  it is not a sync failure and re-syncing may not change it.

## Testing

**Backend**
- `retryAsync`: success first try (no retry/sleep), fail-then-succeed (one retry, returns
  value), fail-all (returns null). `backoffMs: 0` / injected `sleep`.
- Sync (inject `opts.fetchDocuments`): null-then-map ⇒ `lti_fetch_status='ok'` + states
  written; null-always ⇒ `'failed'`; assignment outside the window ⇒ untouched (`NULL`);
  no fetcher ⇒ untouched.
- Route: gradebook payload includes `lti_fetch_status`.

**Frontend**
- `gradeLabel.test.js`: `ltiBadges` null+overdue ⇒ `[]`; `ltiStatusUnavailable` truth
  table (`failed`+ungraded+no-exception ⇒ true; `'ok'` / `NULL` / graded / excepted ⇒
  false).
- `SubmissionBadges.test.jsx`: no `ungraded` / `·` rendered.
- `CoursePage` grid test: cell shows amber `⚠` iff `lti_fetch_status==='failed'` and the
  cell is ungraded & non-excepted; absent for `'ok'` / `NULL` / graded / excepted.

## Docs to update

- `docs/design-language.md` — append: LTI submission-status capture failures surface as a
  cell-level amber `⚠` re-sync affordance, driven by a persisted per-assignment fetch
  outcome; unknown-but-not-failed cells render blank, never "Ungraded".
- `.claude/schoology-api-reference.md` (#62 section) — note the fetch is now retried once
  and its all-or-nothing outcome persisted in `assignments.lti_fetch_status`.

## Out of scope (YAGNI)

- No cross-assignment bulk LTI endpoint hunt — per-assignment bulk already exists (#62).
- No column-header aggregate warning — cell-level was chosen.
- Document-endpoint behaviour on archived sections / large-roster pagination — already
  logged as open in the api-ref; irrelevant to current ~20-student sections.
- No attempt to time/justify resubmissions here (separate: #49/#53).
