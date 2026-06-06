# Recent-only submission-status sync — Design

**Issue:** #55 (Perf: sync wall time dominated by per-(assignment, student) submission-status calls)
**Date:** 2026-06-06
**Status:** Design — pending user review

## Goal

Let the teacher restrict the expensive per-`(assignment × student)` submission-status check to assignments that are **due within a recent window or due in the future**, skipping clearly-old and undated assignments. This is the documented wall-time bottleneck in #55 (the submission-status pass calls `GET /sections/{id}/submissions/{aid}/{uid}` once per cell and scales O(N×M) per section).

The feature is **opt-in and user-controlled**: a remembered default (per-browser) plus a per-sync override. When off, sync behaves exactly as today.

This spec deliberately implements only **direction 1** from #55 ("scope-reduce the loop"). The heavier directions (lazy/background per-assignment sync; the rolled-back concurrency/429 work) are out of scope.

## Scope

**Windowed:** *only* the submission-status step in `server/services/sync.js` (the dropbox-filtered per-cell loop, ~`sync.js:214` onward).

**Not windowed (always full):** courses, students, enrollments, assignments, grades, and mastery (SBG) sync. There is no correctness change anywhere outside the submission-status step.

## User-facing behavior

A new control appears in **Step 1 ("Schoology data — Always runs")** of the Sync dialog (`client/src/components/SyncConfig.jsx`), beside the existing *Include hidden courses* toggle:

- **Checkbox** — *"Only check recent submissions"* (off by default).
- **Day-window stepper** — a `[−] [N] [+]` control (visible/enabled only when the checkbox is on):
  - The `N` field is directly editable (type a value).
  - `[−]` / `[+]` decrement/increment by 1.
  - Validated as a **positive integer, clamped 1–365**. Invalid/empty input falls back to the default (**30**).
- **"?" info affordance** — a small info icon with hover text:
  > "Skips submission checks for assignments with no due date and those due more than N days ago. Courses, students, assignments, grades and mastery still sync fully."

**Remembered default + override:** the checkbox and day-window seed from `localStorage` on dialog open. Whatever the teacher runs with is written back to `localStorage` on Start, so the last-used setting becomes the remembered default. The teacher can override either value for any single sync.

**Rationale for skipping undated assignments (decided with the user):** many formatives are created without a due date; the submission data teachers actually rely on (final-grade deliberation, reassessment eligibility) is for dated work. Undated work is treated as optional and skipped, with the "?" affordance making the omission visible rather than silent.

## Filter semantics

When `recentOnly` is **on** with window `N` days, a submission-bearing assignment is included in the submission-status pass iff:

1. it is submission-bearing (the existing `allow_dropbox` gate at `sync.js:214`), **and**
2. its due date is set (`a.due` is truthy), **and**
3. `dueDate >= now − N days`, where `now` is the sync's reference timestamp already threaded into `syncSectionData`.

Excluded when `recentOnly` is on: assignments with **no due date**, and assignments **due more than N days ago**. Future-due dated assignments are **included** (they may already have early submissions).

When `recentOnly` is **off**: today's behavior — all `allow_dropbox` assignments — unchanged.

**Date handling:** `a.due` is the raw Schoology due string. Parse with `new Date(a.due)`; an unparseable/`NaN` date is treated as undated (skipped). Comparison uses the server clock via the existing `now` parameter, so all sections in one sync share one cutoff.

## Architecture & data flow

The existing trigger chain is reused; the two new params (`recentOnly`, `recentDays`) ride alongside `includeHidden`:

1. **`SyncConfig.jsx`** — owns the checkbox + stepper state (seeded from `localStorage`). On Start, calls `onStart(masteryCourseIds, { skipSchoology, includeHidden, recentOnly, recentDays })`.
2. **`SyncDialog.jsx`** — `startSync(ids, { skipSchoology, includeHidden, recentOnly, recentDays })` forwards the opts to `runSync`.
3. **`client/src/services/api.js` → `runSync(body, onEvent)`** — POSTs the body (now including `recentOnly`, `recentDays`) to `/sync`.
4. **`server/routes/schoology.js` → `POST /sync`** — destructures `recentOnly`/`recentDays` from `req.body`, validates/clamps them (see Guardrails), and passes them into `runUnifiedSync({ ..., recentOnly, recentDays }, write)`.
5. **Opts threading is via explicit destructures at each layer, not a generic spread** — each signature must be extended deliberately:
   - `runUnifiedSync({ masteryCourseIds, skipSchoology, includeHidden, recentOnly = false, recentDays = 30 }, onEvent)` → forwards to `fullSync(onProgress, { includeHidden, recentOnly, recentDays })` (`syncOrchestrator.js:22` / call at `:34`).
   - `fullSync(onProgress, { includeHidden = false, recentOnly = false, recentDays = 30 } = {})` (`sync.js:605`) → includes them in the explicit opts object passed to `syncSectionData` at `sync.js:723`: `{ ...syncConfig, recentOnly, recentDays, fetchSubmissionLookup }`.
   - `syncSectionData(db, sectionId, courseId, now, opts)` destructures `recentOnly = false`, `recentDays = 30` from `opts` (next to the existing `submission*` options at `sync.js:58`).
6. **`syncSectionData` window filter** — at the dropbox filter (`sync.js:214`), apply the window when `recentOnly`. Note `now` is an **ISO string** (`new Date().toISOString()`, `sync.js:608`), so the cutoff must parse it:
   ```js
   const dropboxAssignments = assignments.filter(a => a.allow_dropbox === '1' || a.allow_dropbox === 1);
   const cutoff = Date.parse(now) - recentDays * 86400000; // now is an ISO string
   const targetAssignments = recentOnly
     ? dropboxAssignments.filter(a => {
         const t = a.due ? Date.parse(a.due) : NaN;
         return !Number.isNaN(t) && t >= cutoff;
       })
     : dropboxAssignments;
   const windowSkipped = dropboxAssignments.length - targetAssignments.length;
   ```
   The per-cell loop then runs over `targetAssignments` instead of all dropbox assignments.

## Persistence (client-only)

New module `client/src/lib/syncPrefs.js`, mirroring `client/src/lib/assessmentDraft.js`:

- Keys: `prism.sync.recentOnly` (`"true"`/`"false"`), `prism.sync.recentDays` (integer string).
- `getSyncPrefs()` → `{ recentOnly: boolean, recentDays: number }`, applying defaults (off / 30) and the 1–365 clamp on read.
- `setSyncPrefs({ recentOnly, recentDays })` → writes both keys (clamped). Storage failures are swallowed (private-mode safe), same as the draft module.

The server stays stateless about the default; it only ever receives explicit per-request params.

## Reporting (no silent truncation)

`syncSectionData` adds the per-section `windowSkipped` count to its metrics/result so it surfaces in the sync progress/`sync_log`. The teacher can see how many assignments the window dropped — the speedup is visible and the omission is never silent.

## Guardrails / validation

`recentDays` is coerced and clamped in **two** places (client for UX, server because it must not trust the client):

- coerce to integer; if `NaN`/missing → `30`.
- clamp to `[1, 365]`.
- `recentOnly` coerced to boolean; `recentOnly` true with a bad `recentDays` → default `30` (never silently disables the window).

A shared clamp helper (e.g., `clampDays`) lives in `syncPrefs.js` (client) and is mirrored or re-implemented trivially server-side in the route.

## Components & files

**New**
- `client/src/components/NumberStepper.jsx` — reusable `[−] [editable N] [+]` control (props: `value`, `onChange`, `min`, `max`, `aria-label`). Clamps to a positive-integer range. Mirrors the small-control convention of `TriCheckbox.jsx`.
- `client/src/components/NumberStepper.test.jsx` — typing, step buttons, clamping at min/max, rejecting non-integers.
- `client/src/lib/syncPrefs.js` + `client/src/lib/syncPrefs.test.js` — get/set/clamp/default.

**Modified**
- `client/src/components/SyncConfig.jsx` — add the checkbox, `NumberStepper`, "?" tooltip; seed from `getSyncPrefs()`; include `recentOnly`/`recentDays` in `onStart`; write `setSyncPrefs(...)` on Start.
- `client/src/components/SyncDialog.jsx` — thread the two opts through `startSync` → `runSync`.
- `client/src/services/api.js` — include `recentOnly`/`recentDays` in the `runSync` POST body.
- `server/routes/schoology.js` — parse/validate the two params; pass into `runUnifiedSync`.
- `server/services/sync.js` — extend `fullSync`'s opts destructure (`recentOnly`, `recentDays`); include them in the explicit `syncSectionData` opts object at `:723`; destructure them in `syncSectionData`; apply the window filter at the dropbox-filter site; track `windowSkipped`.
- `server/services/syncOrchestrator.js` — extend `runUnifiedSync`'s destructure with `recentOnly`/`recentDays` and forward them in the explicit `fullSync(..., { includeHidden, recentOnly, recentDays })` call.

## Testing

**Server (`server/services/sync.test.js` + `server/routes/schoology.test.js`)**
- window filter: a mix of assignments (due within N, due > N ago, future-due, undated) → with `recentOnly` true only recent+future *dated* survive; `recentOnly` false → all dropbox assignments survive.
- `windowSkipped` equals the count dropped.
- route passes `recentOnly`/`recentDays` through; clamps out-of-range and `NaN` to defaults.

**Client**
- `syncPrefs.test.js`: defaults, round-trip, clamp 1–365, bad input → 30.
- `NumberStepper.test.jsx`: type a value, `[−]`/`[+]` step, clamp at bounds, reject non-integers.
- `SyncConfig` behavior test: checking the box enables the stepper; Start calls `onStart` with the chosen `recentOnly`/`recentDays` and writes them to `localStorage`.

**Green gate:** `npx vitest run server/`, `cd client && npx vitest run`, `cd client && npx vite build`.

## Out of scope (YAGNI)

- Lazy/background per-assignment submission sync (#55 direction 2).
- The rolled-back concurrency/parallelization + 429/Retry-After work.
- Server-side or cross-device remembered default (localStorage chosen).
- Any change to mastery sync or the per-assignment on-demand sync (`POST /mastery/:courseId/assignment/:assignmentId/sync`).

## Decisions locked

| Decision | Choice |
|---|---|
| Control model | Remembered default (localStorage) + per-sync override |
| Filter window | Due in last N days **or** future-due; **skip undated**; "?" affordance explains skipped |
| Persistence | Browser `localStorage`; server stateless |
| Day input | `[−] [N] [+]` stepper, editable, positive integer, clamped 1–365, default 30 |
| Windowed scope | Submission-status step only; rest of sync unchanged |
| Visibility | Report `windowSkipped` count (no silent truncation) |
