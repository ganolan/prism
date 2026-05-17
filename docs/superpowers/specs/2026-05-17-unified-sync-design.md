# Unified sync with progress overlay — design

**Issues:** #18 (multiple sync types confuse users), #17 (no live progress on sync)
**Milestone:** Wave 2 — Sync subsystem
**Date:** 2026-05-17

## Problem

Prism has two separate, separately-triggered syncs:

- **Sync Schoology** — a global pull of all courses/students/assignments/grades
  via the public API, triggered by the sidebar button (`POST /api/sync`).
- **Sync Mastery** — a per-course pull of standards-based-grading data via a
  Playwright browser session, triggered from each Course page
  (`POST /api/mastery/sync/:courseId`). Requires a one-time browser login.

Users assume "Sync Schoology" also pulls mastery data; it does not (#18).
Neither sync gives any live feedback — the button just says "Syncing..." while
progress goes to the server console, so users keep interacting with stale data,
unsure whether the app is frozen (#17).

**Note on #18's "auto-flag" text:** #18 also asks to merge a "run auto-flag"
feature into sync. That feature was removed in commit `743a68d`, and #45 purged
its leftover rows. All flags are now user-managed — there is nothing to merge.
This is explicitly out of scope.

## Goals

1. One entry point — the sidebar **Sync** button — covers Schoology and mastery.
2. The user chooses which courses get the slow mastery pass, up front.
3. A blocking progress overlay shows live phase progress, record counts, and the
   server's own log lines, with a confirmation button to dismiss.
4. Per-course mastery failures are recoverable and tell the user what to do next.

## User flow

1. Sidebar **Sync** button opens the **Sync dialog** in *config* mode.
2. **Config mode:**
   - **Step 1 · Schoology data** — a fixed, always-runs card (no checkbox). The
     public-API sync is global; per-course selection is not offered for it.
   - **Step 2 · Mastery (SBG) data** — optional. Shows a disclaimer that mastery
     runs one course at a time via a browser session (~20–40s each). Courses are
     listed in three collapsible groups — **Visible**, **Hidden**, **Archived** —
     each with a tri-state "select all" checkbox and per-course checkboxes. The
     Visible group is expanded by default with all its courses checked; Hidden
     and Archived are collapsed and unchecked. Empty groups are not rendered.
   - If no mastery browser session exists, Step 2 replaces the course tree with
     a notice and a **Log in to Schoology** button (see Mastery login below).
   - Footer shows a live selection summary ("Schoology + N mastery courses") and
     **Cancel** / **Start sync**.
3. **Start sync** switches the dialog to *running* mode — a blocking overlay.
4. **Running mode:** spinner, a "don't close Prism" line, a progress bar
   (phases completed ÷ total phases), a phase checklist (Schoology, then one row
   per selected mastery course) with live record counts, and a scrolling log box
   showing the server's progress messages. **Done** is disabled.
5. When the sync stream ends, the dialog switches to *done* mode: a summary with
   per-phase record counts and, if anything failed, remediation banners. **Done**
   is enabled and dismisses the dialog.
6. **Retry** (offered per failure) re-runs only the failed mastery courses,
   skipping the Schoology phase.

The per-course **Sync Mastery** button on each Course page is kept as a quick
single-course refresh.

## Mastery login

Mastery sync needs a Playwright browser session that can expire. The session's
*existence* is detectable (a session storage file on disk); its *validity* is
not, short of attempting a sync.

- **Config mode:** `GET /api/mastery/login-status` reports whether the session
  file exists. If absent, Step 2 shows the login prompt instead of the course
  tree. The **Log in to Schoology** button calls the existing
  `POST /api/mastery/login` (interactive browser login); on success the config
  re-checks status and shows the course tree.
- **Running mode:** if the session is present but turns out expired, the mastery
  course fails mid-sync and surfaces as a recoverable failure in *done* mode.

## Architecture

### Backend

**New module — `server/services/syncOrchestrator.js`**

```
runUnifiedSync({ masteryCourseIds = [], skipSchoology = false }, onEvent)
```

- Unless `skipSchoology`, runs `fullSync` (existing, in `sync.js`), forwarding
  its `onProgress({ message })` callbacks as `log` events.
- Then, for each `masteryCourseId` in sequence, calls `syncMasteryForCourse`
  (existing, in `masterySync.js`) inside a try/catch — one course failing does
  not abort the others.
- Writes `sync_log` rows: the `full` row is written by `fullSync` already; the
  orchestrator writes one `mastery` row per course (logic moved/shared from the
  current `mastery.js` route).
- A `classifyMasteryError(err)` helper returns `'login'` or `'other'` based on
  the error message (login/session errors — e.g. "Not logged in",
  "mastery:login" — vs anything else).
- If the Schoology phase throws, the orchestrator emits a hard-error event and
  does **not** run the mastery phase (mastery depends on freshly-synced course
  rows).

**Progress event schema** (each event is one JSON object):

| Event | Fields |
|---|---|
| Schoology phase | `{ phase: 'schoology', status: 'running'\|'done'\|'error', records?, message? }` |
| Mastery phase | `{ phase: 'mastery', courseId, courseName, status: 'running'\|'done'\|'error', records?, errorKind?: 'login'\|'other', message? }` |
| Log line | `{ type: 'log', message }` |
| Summary | `{ type: 'summary', schoology: {...}, mastery: [...], elapsedMs }` |

**Route — `server/routes/schoology.js`**

- `POST /api/sync` becomes a streaming endpoint. Body: `{ masteryCourseIds,
  skipSchoology }`. Response is newline-delimited JSON (`application/x-ndjson`):
  each orchestrator event is written as `JSON.stringify(evt) + '\n'`, then
  `res.end()`. The `syncInProgress` guard stays — a second concurrent request
  gets `409`.
- `GET /api/sync/status` is unchanged.

**Route — `server/routes/mastery.js`**

- New `GET /api/mastery/login-status` → `{ loggedIn: boolean }` — checks for the
  Playwright session storage file. `POST /api/mastery/login` is unchanged.

**Course list:** the modal reuses `GET /api/courses?archived=true&hidden=true`
and groups client-side by the `archived` / `hidden` flags. No new endpoint.

**Schema:** no changes to `sync_log` or any table.

### Frontend

**New components**

- `client/src/components/SyncDialog.jsx` — parent modal. Owns the mode state
  machine (`config` → `running` → `done`), accumulates progress events, invokes
  the streaming sync, and handles retry. Rendered from `App.jsx`.
- `client/src/components/SyncConfig.jsx` — Step 1 card + Step 2 course tree
  (grouped, collapsible, tri-state "select all"), or the login prompt. Fetches
  the course list and mastery login status. Reports selected mastery course IDs
  to `SyncDialog`.
- `client/src/components/SyncProgress.jsx` — phase checklist, progress bar, log
  box, summary, remediation banners, and Done/Retry buttons.

**`client/src/App.jsx`** — the sidebar button opens `SyncDialog` instead of
calling `handleSync` directly; the old inline `syncResult` banner is removed.

**`client/src/services/api.js`** — new `runSync({ masteryCourseIds,
skipSchoology }, onEvent)` reads the streamed response via
`response.body.getReader()`, splitting on `\n` and parsing each line as a JSON
event passed to `onEvent`. New `getMasteryLoginStatus()`. Course list uses the
existing `getCourses`-style call with `archived`/`hidden` query params.

**Styling** — per `CLAUDE.md`: CSS custom properties only (no hardcoded hex),
`.alert.alert-warning` for the recoverable-failure banner, existing button
classes (`.primary`, `.secondary`, `.ghost`). The dialog follows the app's
existing modal pattern.

## Error handling

- **Schoology phase fails** → hard-error event; mastery phase skipped; *done*
  mode shows a hard failure (red header), only **Done** offered.
- **Mastery course fails** → caught per-course; remaining courses still run.
  *done* mode shows a per-course remediation banner:
  - `errorKind: 'login'` → amber `.alert-warning` banner explaining the session
    expired, with **Log in to Schoology** and a **Retry** button (Retry enabled
    only after a successful re-login).
  - `errorKind: 'other'` → red banner showing the actual error message and a
    plain **Retry** button (re-login would not help).
- **Retry** → `runSync({ masteryCourseIds: failedIds, skipSchoology: true })`.
- **Concurrent sync** → second request returns `409`.
- **Overlay is blocking** while running — no dismiss until the stream ends. If
  the user closes the browser tab mid-sync, the server sync continues and the
  `sync_log` rows record the outcome.

## Testing

TDD — failing tests written first.

**Server** (`npm run test:server`, Vitest):
- `syncOrchestrator`: phase order (Schoology before mastery); `skipSchoology`
  skips the Schoology phase; a mastery course that throws does not abort the
  others; `classifyMasteryError` returns `login` vs `other` correctly; a
  Schoology failure skips the mastery phase.
- Streaming route: emits newline-delimited JSON events; returns `409` when a
  sync is already in progress. (Orchestrator mocked.)

**Client** (`cd client && npm test -- --run`, Vitest + RTL):
- `SyncConfig`: the three groups render and collapse/expand; tri-state
  "select all" reflects and toggles child checkboxes; the login-prompt state
  renders when not logged in.
- `SyncProgress`: builds the phase checklist from a sequence of events; the
  remediation banner picks amber vs red by `errorKind`; **Done** is disabled
  while running and enabled when the stream ends.

## Out of scope

- Merging any "auto-flag" behaviour into sync (the feature no longer exists).
- Per-course selection for the Schoology (public-API) sync — it stays global.
- Changing the Course-page per-course mastery sync button.
- Phase 5 Schoology write-back.
