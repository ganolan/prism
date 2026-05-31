# Relocate Archived-Course Import to the Dashboard — Design

**Issue:** #69 — "Move archived-course import to the Dashboard Archived tab (out of
the Sync dialog); remove the redundant import-by-code form."
**Date:** 2026-05-31
**Status:** Approved design, pending implementation plan
**Builds on:** #5 (`docs/superpowers/specs/2026-05-31-past-course-discovery-design.md`)

## Problem

The archived-course discovery/import UI shipped in #5 (`ArchivedCoursesPanel`) was
embedded in the **Sync dialog**, which is now bloated. That UI is a **one-time,
irregular** action (discover + import past/archived sections), so it sits awkwardly
next to the **recurring** sync configuration — and beside the Step 2 mastery
**"Archived courses"** group, forcing a disambiguating "Import archived courses"
title.

The natural home is the Dashboard's **Archived** tab, which already renders imported
archived courses as rich cards. This is a **frontend relocation** — the backend
(`GET /api/courses/archived/discover`, `POST /api/courses/import`) is unchanged.

## The duplication to resolve

`ArchivedCoursesPanel` today renders **two** things:
1. Its own grouped-by-year list of *already-imported* archived courses (plain text).
2. The discovery queue of *not-yet-imported* sections + Check/Import-all/login.

The Dashboard Archived tab **already** renders imported archived courses as cards
(block number, hide/show, semester badge, settings cog) — the richer view. So a naive
lift-and-shift would show imported courses twice. **Reconciliation:** the relocated
panel becomes **discovery-only** (the not-yet-imported queue); the Dashboard's existing
cards remain the sole imported-course view.

## Decisions (confirmed with the user, 2026-05-31)

| Decision | Choice |
|---|---|
| Placement on the Archived tab | **Above** the year-grouped cards |
| Visibility | **Always visible** — no collapse caret (the tab is already the archived context) |
| Visual treatment | **Restyle to match the Dashboard** (themed section header + buttons + row list), not a lift-and-shift of `sync-*` classes |
| Login handling | **Self-contained** in the panel (owns `triggerMasteryLogin` + local busy); Dashboard passes only `onImported` |
| After successful login | **Auto re-run the check** (re-call discovery; no second click) |
| Manual "Add an archived course" (Section-ID) form | **Removed** — redundant now that discovery + one-click import exists |
| Component name | **Keep** `ArchivedCoursesPanel` (rename would churn CONTEXT.md + tests for little gain); rewrite its purpose comment |
| Backend | **Unchanged** |
| Dashboard test | **Add** a focused `Dashboard.test.jsx` (none exists today) |

## Terminology

Per `CONTEXT.md`: **"archived"** is the canonical app term; **"past"** is reserved for
Schoology's `/mycourses/past` source page + its parser (`parsePastCourses`). This work
adds no new domain terms.

## Architecture

### 1. `ArchivedCoursesPanel` → discovery-only, self-contained (`client/src/components/ArchivedCoursesPanel.jsx`)

**Removed:**
- The internal grouped-by-year *imported* list (current lines ~97–118) — the
  de-duplication. With it go the `courses` prop and the
  `parseGradingPeriod`/`groupByAcademicYear`/`formatLastSynced` imports.
- The collapse caret + `collapsed` state and the "Import once" `sync-badge`.
- The `loggedIn` prop (already dead — never referenced), and the `onLogin`/`busy`
  props (internalised, see below).

**Props shrink to:** `{ onImported }` — a callback the Dashboard wires to its `reload()`
so imported courses appear in the card view.

**Self-contained login:** import `triggerMasteryLogin` from `../services/api.js`. The
panel owns a local `busy` state. On "Log in to Schoology" click → `setBusy(true)` →
`await triggerMasteryLogin()` → on success **auto-call `handleCheck()`** (re-runs
discovery) and clear `needLogin`; `finally setBusy(false)`. A login failure leaves the
prompt in place (no throw to the user).

**Kept (behaviour from #5):**
- "Check Schoology for archived courses" → `discoverArchivedCourses()`; on
  `available: false` show the login prompt; on success store the sections.
- The single action slot transforms **in place**: Check → `Import all (N, excl.
  no-code)` once the queue is known (re-checking isn't a useful next step).
- Per-course **Import** (`importCourse(sectionId)`), `Import all` over code-bearing
  not-yet-imported sections sequentially with a live `done/total` count, partial-success
  on a single failure.
- Import-once: a section is imported if `s.imported` (API annotation) **or** in the
  session `importedIds` set; imported rows leave the queue.
- `onImported()` fires after a successful import (per-course and once after a bulk run)
  so the Dashboard refetches its cards.
- Error display.

### 2. Restyle for the Dashboard (`client/src/app.css`)

Replace the `sync-*` classes used by this component with a small new themed class set
(CSS variables only — no hardcoded hex, per CLAUDE.md frontend conventions). Proposed
`.archived-import*` namespace:
- A **section header** in the tab's existing uppercase-muted style (matching the year
  group `<h3>`: `text-transform: uppercase`, letter-spacing, `var(--text-muted)`).
- Action button: `.secondary` for "Check Schoology…", transforming to `.primary` for
  "Import all".
- Discovery rows: a themed list (`.archived-import-list` / `.archived-import-row`) — row
  = course title (+ "no course code" `.badge.badge-gray`) and an `[Import]` `.secondary`
  button — using `var(--border)`, `var(--card-bg)`, etc.
- The `sync-*` classes remain in use by the Sync dialog itself and are **not** removed
  globally; only this component stops using them. Remove the now-orphaned
  `.archived-discovery-row` rule if it has no other consumer.

### 3. Dashboard Archived tab (`client/src/pages/Dashboard.jsx`)

- Render `<ArchivedCoursesPanel onImported={reload} />` **above** the year-grouped card
  list, inside the `activeTab === 'archived'` block.
- **Remove** the manual "Add an archived course" / Section-ID form (current lines
  ~226–257) and the now-dead state + handler: `importId`, `importing`, `importError`,
  `importSuccess`, `handleImport`, and the `importCourse` import (used only by that
  handler).
- Update the empty-state copy: "No archived courses yet…" should reference the discovery
  action above, not "the form below".

### 4. Sync dialog cleanup

- `SyncConfig.jsx`: remove the `import ArchivedCoursesPanel`, the `<ArchivedCoursesPanel
  .../>` render block (lines ~171–177), and the `onImported` prop from the signature.
  **Keep** `loggedIn`/`onLogin`/`busy` — they drive the Step 2 mastery login prompt
  (line ~102), independent of the panel.
- `SyncDialog.jsx`: remove `onImported={refreshCourses}` from the `<SyncConfig>` props
  and delete the now-dead `refreshCourses` function (lines ~29–33).

### 5. `CONTEXT.md`

The panel leaves the Sync dialog, so two spots need correcting in place:
- The canonical-term example list (currently "(Dashboard Archived tab, the Sync dialog's
  Import archived courses panel, …)") — the discovery panel is now **on the Dashboard
  Archived tab**, not in the dialog.
- The **"Sync dialog surfaces (avoid label collisions)"** section — after #69 the dialog
  retains only the Step 2 mastery **"Archived courses"** group, so the in-dialog
  label-collision concern is resolved. Note the discovery surface now lives on the
  Dashboard Archived tab (above the imported-course cards).

## Testing (TDD)

- **Rewrite `ArchivedCoursesPanel.test.jsx`:**
  - Drop the "lists imported archived courses grouped by year" test (that view is gone)
    and the `expand()` helper (no caret).
  - `renderPanel` passes only `onImported`; drop `courses`/`loggedIn`/`onLogin`/`busy`.
  - Update the row selector from `.sync-course` to the new `.archived-import-row`.
  - Login test: add `triggerMasteryLogin` to the api mock; assert clicking "Log in to
    Schoology" calls it and (mock resolved + `discoverArchivedCourses` re-mocked to
    `available: true`) the queue then appears (auto re-check).
  - Keep: discover/no-code-flag/Import-all sizing, transform-in-place, Import-all imports
    code-bearing only, per-course import removes row + fires `onImported`,
    excludes-already-imported, error-on-failure.
- **`SyncConfig.test.jsx`:** remove the "renders the Import archived courses panel" test
  (~lines 94–96). The "Archived courses" assertion (line 30) refers to the Step 2 mastery
  group and stays.
- **Add `Dashboard.test.jsx`** (follows `StudentPage.test.jsx` /
  `AssessmentSummaryPage.test.jsx`: mock `../services/api.js`, wrap in `MemoryRouter`):
  switch to the Archived tab and assert (a) the discovery action ("Check Schoology for
  archived courses") renders **above** the cards, and (b) the manual Section-ID form is
  **gone** (no "Add an archived course" / "Section ID" input).
- Full suites must stay green: server `npx vitest run` (122), client `cd client &&
  npx vitest run` (125 ± the net test delta).
- Live UI verification: load the Dashboard Archived tab, confirm discovery + per-course
  Import + Import-all + the login prompt, and confirm the Sync dialog no longer shows the
  panel.

## Out of scope (deliberate)

- **Backend changes** — discovery + import endpoints are unchanged.
- **Renaming `ArchivedCoursesPanel`** — kept to avoid CONTEXT.md/test churn.
- **The inert "Include archived" sync toggle cleanup** — a separate #5 follow-up.
- **Configurable date-format/locale + shared `formatDate` helper** — deferred follow-up
  (the relocated panel renders no dates now that the imported list is gone).
- **Mastery (SBG) sync for archived sections** — import stays gradebook-only; mastery
  remains opt-in via the dialog's Step 2 "Archived courses" group.
