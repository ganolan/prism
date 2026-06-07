# Spec: True submission-state badges for `lti_submission` work (#62)

**Issue:** #62 — "Not Started" badge asserts submission state Prism can't verify for `lti_submission` assignments
**Date:** 2026-06-07
**Status:** approved design, ready for implementation plan
**Scope decision:** true 4-state badges, scoped to #62 (does not rework #55/#58, though it incidentally reduces sync calls).

## Problem

`submissionStatus()` in `client/src/lib/gradeLabel.js` shows an amber **"Not Started"** badge for ungraded, past-due work whenever there's no positive submission signal. For **OneDrive/GDrive `lti_submission`** assignments (most HKIS summatives) that claim is unverifiable from the surfaces Prism used:

- The public revisions API (`/sections/{id}/submissions/{aid}/{uid}`) returns an **empty revision array for submitted students** (it hides post-submit OneDrive revisions) and an **auto-provisioned empty `draft=1` revision** for students who were merely *assigned* the work — so neither presence nor absence of a revision is a reliable engagement signal.
- The internal `grader_header_data` (GHD) `submission` key reliably identifies **submitted**, but a bare GHD cell cannot separate "opened, in progress" from "never opened."

Net effect: for an ungraded `lti_submission` student, Prism asserted "Not Started" (and red "Missing") for students who may well have opened or even submitted the work — at HKIS, the common case.

## Spike findings (2026-06-07, verified)

Driving the Schoology grader UI and grepping its React bundle (`react-common/assignment-*.js`) surfaced the endpoints that feed the grader's own **"In Progress" / "Submitted"** tabs. Two **per-assignment** reads (browser-session auth, same session as GHD/mastery) give the authoritative, teacher-visible state:

- `GET /iapi2/assignments/{assignmentId}/submitted-documents/` → students who **submitted**.
- `GET /iapi2/assignments/{assignmentId}/in-progress-documents/` → students **not yet submitted**, each with a boolean **`revisionCreated`**: `true` = created their own copy / opened it (**In Progress**), `false` = never opened (**Not Started**).

Each entry: `{ id (=schoology uid), enrollmentId, firstName, middleName, lastName, avatarUrl, submissionTiming, submissionStatus, exception, grade, revisionCreated, submissionDate }`.

**Verified** on Robotics section `7899907720` against teacher ground truth:
- Notebook 4 (`8348763574`): 1 submitted + 18 in-progress, of which exactly one — `revisionCreated:false`, uid 132465441 (Maria Sakai) — was the teacher-confirmed never-opened student. The public API could not find her (0 revisions for both her and the submitted student).
- Notebook 3 (`8348763571`): 17 submitted + 2 in-progress (both `revisionCreated:true`) + 0 not-started.
- `submitted-documents` count == GHD `submission`-present count in both (1/1, 17/17) — cross-validated.
- All 404 `draft=1` rows in the local DB sit on `lti_submission` assignments (the auto-provisioned noise); **native dropbox has zero drafts** — confirming non-LTI work has no meaningful "in progress" state.

Full record: `.claude/schoology-api-reference.md` (Submissions & Comments → the 2026-06-07 RESOLVED note). Probe scripts retained under `scripts/probe-*.js`.

**Cost note:** these are per-assignment list reads (2 calls cover the whole roster), strictly cheaper than today's O(students×assignments) public per-cell walk — so for lti assignments this *removes* calls rather than adding them.

## Design

### 1. Persist the lti marker (new, isolated column)

- Add `assignments.is_lti_submission INTEGER DEFAULT 0`, set in `sync.js` from Schoology's API field **`a.assignment_type === 'lti_submission'`** (the real OneDrive/GDrive marker).
- ⚠️ Do **not** reuse the existing `assignments.assignment_type` column — it is already overloaded by `masterySync.js` / `analytics.js` for the formative/summative (mastery-aligned) classification. The lti marker is independent.
- Include `is_lti_submission` on the assignment objects the API serves to the client (the routes feeding CoursePage/StudentPage).

### 2. Read true state during sync (replaces the per-cell public walk for lti only)

- New service `server/services/graderDocuments.js`, sibling of `graderSubmissions.js`, reusing the same browser-session fetcher pattern (`createSubmissionFetcher` / the `.playwright-session` storage state). Exposes, per assignment, a `uid → state` map where `state ∈ { submitted, in_progress, not_started }`:
  - `submitted-documents/` → `submitted`
  - `in-progress-documents/` → `revisionCreated ? in_progress : not_started`
- A pure parser (`server/lib/parseGraderDocuments.js`) over the captured response shape, unit-tested with real shapes — mirrors the `parseGraderHeaderData.js` split.
- In `sync.js`, for `is_lti_submission` assignments take this path **instead of** the public per-(student × assignment) submission loop. Native dropbox assignments keep their existing public-revisions path untouched.
- Persist via new column `grades.lti_submission_state TEXT` (nullable). Null = non-lti, or lti cell not covered (no session / endpoint blind). Upsert mirrors the existing submission-status upsert (insert a row so a not-yet-graded lti cell still surfaces; do not clobber `score`).

### 3. Render (`gradeLabel.js` `submissionStatus`)

Thread two new inputs in: `isLti` (from `assignment.is_lti_submission`) and `ltiState` (from `grade.lti_submission_state`). For lti cells, **drive badges from `ltiState` and ignore `draft`/`submitted_at`** (now known to be noise). Graded cells (`score != null`) short-circuit to the grade label with no status badge, as today.

**Due-proximity buckets** from `due_date` vs `today`: `none` (no due date), `early` (`now < due − 7d`), `soon` (`due − 7d ≤ now ≤ due`), `overdue` (`now > due`).

**LTI badge matrix:**

| state | `early` / `none` | `soon` | `overdue` |
|---|---|---|---|
| `submitted` | 🟢 Submitted | 🟢 Submitted | 🟢 Submitted |
| `in_progress` | 🔵 In Progress | 🔵 In Progress | 🟡 In Progress |
| `not_started` | ⚪ Not Started (grey) | 🔴 Not Started | 🔴 Not Started |
| `null` (no session/uncovered) | *(no badge)* | *(no badge)* | ⚪ Ungraded (neutral) |

Rules captured: Not Started is **red from one week before the due date through past-due**; **grey** when there's no due date or more than a week out. In Progress is **blue before the due date** (incl. no due date) and **amber/yellow once overdue**. The `null` row is the no-session fallback: it never shows a false "Not Started" — nothing before the due date, and only a neutral "Ungraded" once overdue (low-noise: most cells are ungraded, so we don't badge every future-due cell when the browser session is absent).

**Non-LTI badge matrix** (only submitted-or-not is knowable; no in-progress):

| state | before due / `none` | `overdue` |
|---|---|---|
| `submitted` | 🟢 Submitted | 🟢 Submitted |
| `not_submitted` | *(no badge)* | 🔴 Missing |

**Non-LTI is a rendering change too** (not just sync): the existing `Missing • Not Started` double badge becomes **`Missing` alone** (drop the unverifiable "Not Started" qualifier), shown only once overdue; nothing before due; `submitted` → green. The non-lti *sync* path (public revisions → `submitted` via `submitted_at`/revisions) is unchanged. A native-dropbox `draft`, if one ever appears, folds into `not_submitted` (no "In Progress" for non-lti).

**Consolidation:** one state machine, one tone ladder. The **label** encodes how much we know — **"Not Started"** = verified never-opened (lti only); **"Missing"** = not-submitted, opened-ness unknowable (non-lti). Non-lti shows nothing before the due date because it cannot distinguish not-started from in-progress, so there is no honest early warning to give.

**Tones → existing themed classes** (all CSS-variable based; add the two new tone keys to `TONE_CLASS` in `SubmissionBadges.jsx`):

| tone | class | used for |
|---|---|---|
| `green` *(new key)* | `badge-green` | Submitted |
| `blue` | `badge-blue` | In Progress (pre-due) |
| `yellow` *(new key)* | `badge-amber` | In Progress (overdue) |
| `red` | `badge-red` | Not Started (urgent), Missing |
| `neutral` | `badge-gray` | Not Started (early), Ungraded |

### 4. Fallback & edge cases

- **No browser session:** lti cells get `null` state → neutral "Ungraded" badge; never a false "Not Started". (Same dependency as mastery/GHD sync.)
- **Archived/inactive sections:** out of scope — frozen via #72; the iapi2 endpoints are likely GHD-blind there too (not yet verified). Archived finalisation continues to skip the submission loop.
- **`submission_type` (GHD) signal:** retained for now as a corroborating source; the new `lti_submission_state` is authoritative for lti display.

### 5. Testing

- `gradeLabel.test.js`: extend `submissionStatus` coverage — each lti state × due-proximity bucket (the full matrix above), `null` state → neutral, and non-lti unchanged (Submitted / Missing-after-due / nothing-before-due, no regressions to existing cases).
- `parseGraderDocuments.test.js`: parse real captured shapes → correct `uid → state` map, including the `revisionCreated:false` → `not_started` case.
- `sync` test: lti assignment takes the graderDocuments path (not the per-cell public walk); native dropbox still uses the public path; no-session falls back cleanly.

## Scope / non-goals

- **In scope:** lti 4-state detection + storage + badges; the `is_lti_submission` marker; non-lti consolidated to Submitted/Missing.
- **Out of scope:** reworking the broader submission sync for perf (#55) or Simplify Sync (#58); resubmission timing (#49/#53, on hold); using `submissionTiming` for authoritative late detection (noted as a future enhancement); archived-section coverage.

## Open caveats (scoped per the API-exploration playbook — conclusions hold for surfaces tested)

- Pagination on very large rosters (HKIS sections ~20 students returned inline; not tested at scale).
- Cross-grading-period coverage (per-assignment URL, so likely fine — unlike GHD which is current-period only; not exhaustively verified).
- Archived/inactive sections (likely blind, as GHD is; not verified).
