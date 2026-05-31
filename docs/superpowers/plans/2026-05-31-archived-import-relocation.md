# Archived-Course Import Relocation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the archived-course discovery/import UI out of the Sync dialog onto the Dashboard Archived tab (above the imported-course cards), remove the redundant manual import-by-Section-ID form, and reconcile so imported archived courses appear only once.

**Architecture:** Frontend-only. `ArchivedCoursesPanel` is slimmed from "imported list + discovery queue" to **discovery-only** and made **self-contained** (owns its Schoology login). The Dashboard's existing year-grouped cards stay as the sole imported-course view; the panel renders above them. The Sync dialog drops the panel and its `refreshCourses`/`onImported` wiring. Backend endpoints (`GET /api/courses/archived/discover`, `POST /api/courses/import`) are unchanged.

**Tech Stack:** React (Vite), Vitest + @testing-library/react, react-router (`MemoryRouter` in tests), CSS custom properties in `client/src/app.css`.

**Spec:** `docs/superpowers/specs/2026-05-31-archived-import-relocation-design.md`

**Ordering rationale:** Remove the panel from the dialog *first* (Task 1) so the panel has a single consumer before we refactor it (Task 2) and re-home it (Task 3). Each task leaves the full test suite green at its commit. Run client tests from `client/`: `cd client && npx vitest run`.

---

### Task 1: Remove the panel from the Sync dialog

**Files:**
- Modify: `client/src/components/SyncConfig.jsx` (import line 2; render block lines ~171–177; signature line 23)
- Modify: `client/src/components/SyncDialog.jsx` (lines ~29–33, ~91)
- Modify: `client/src/components/SyncConfig.test.jsx` (lines ~93–97)

This task is pure removal (no behaviour change to the still-old panel). It keeps `loggedIn`/`onLogin`/`busy` on `SyncConfig` — those drive the Step 2 mastery login prompt (`SyncConfig.jsx:102`), not the panel.

- [ ] **Step 1: Remove the panel test from `SyncConfig.test.jsx`**

Delete this block (currently lines 93–97, including the leading blank line):

```jsx

  it('renders the Import archived courses panel', () => {
    renderConfig();
    expect(screen.getByText('Import archived courses')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Remove the panel from `SyncConfig.jsx`**

Delete the import (line 2):

```jsx
import ArchivedCoursesPanel from './ArchivedCoursesPanel.jsx';
```

Delete the render block (lines ~171–177):

```jsx
      <ArchivedCoursesPanel
        courses={courses}
        loggedIn={loggedIn}
        onLogin={onLogin}
        busy={busy}
        onImported={onImported}
      />
```

Remove `onImported` from the component signature (line 23). Change:

```jsx
export default function SyncConfig({ courses, loggedIn, busy, onStart, onCancel, onLogin, onImported }) {
```

to:

```jsx
export default function SyncConfig({ courses, loggedIn, busy, onStart, onCancel, onLogin }) {
```

- [ ] **Step 3: Remove the dead wiring from `SyncDialog.jsx`**

Delete the `refreshCourses` function and its comment (lines ~29–33):

```jsx
  // Re-pull the course list after an archived-course import so the Archived
  // panel's grouped-by-year section reflects the newly imported course.
  async function refreshCourses() {
    try { setCourses(await getCourses(true, true)); } catch { /* keep current list */ }
  }
```

Remove the `onImported` prop from the `<SyncConfig>` element (line ~91). Change:

```jsx
          <SyncConfig
            courses={courses}
            loggedIn={loggedIn}
            busy={busy}
            onStart={(ids, opts) => startSync(ids, opts)}
            onCancel={onClose}
            onLogin={handleLogin}
            onImported={refreshCourses}
          />
```

to:

```jsx
          <SyncConfig
            courses={courses}
            loggedIn={loggedIn}
            busy={busy}
            onStart={(ids, opts) => startSync(ids, opts)}
            onCancel={onClose}
            onLogin={handleLogin}
          />
```

(Leave the `getCourses` import — it is still used by the initial-load `useEffect` at line 18.)

- [ ] **Step 4: Run the client suite to confirm green**

Run: `cd client && npx vitest run`
Expected: PASS. `SyncConfig.test.jsx` has one fewer test; `ArchivedCoursesPanel.test.jsx` still passes (the panel file is untouched, just no longer rendered in the dialog). No failures.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SyncConfig.jsx client/src/components/SyncDialog.jsx client/src/components/SyncConfig.test.jsx
git commit -m "refactor(#69): remove archived-import panel from the Sync dialog

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Refactor `ArchivedCoursesPanel` to discovery-only + self-contained (TDD)

**Files:**
- Modify (rewrite): `client/src/components/ArchivedCoursesPanel.test.jsx`
- Modify (rewrite): `client/src/components/ArchivedCoursesPanel.jsx`
- Modify: `client/src/app.css` (replace lines ~821–824)

After this task the panel is orphaned (rendered nowhere) — that is expected; Task 3 mounts it on the Dashboard.

- [ ] **Step 1: Rewrite the failing test `ArchivedCoursesPanel.test.jsx`**

Replace the entire file with:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ArchivedCoursesPanel from './ArchivedCoursesPanel.jsx';
import { discoverArchivedCourses, importCourse, triggerMasteryLogin } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  discoverArchivedCourses: vi.fn(),
  importCourse: vi.fn(),
  triggerMasteryLogin: vi.fn(),
}));

const DISCOVERED = {
  available: true,
  sections: [
    { courseTitle: 'Photography 7', courseCode: null, sectionId: '7004', imported: false, noCourseCode: true },
    { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false },
  ],
};

function renderPanel(props = {}) {
  return render(<ArchivedCoursesPanel onImported={props.onImported || (() => {})} />);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('ArchivedCoursesPanel', () => {
  it('discovers not-yet-imported sections, flags no-code, and sizes "Import all"', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    expect(screen.getByText('Photography 7')).toBeInTheDocument();
    expect(screen.getByText(/no course code/)).toBeInTheDocument();
    expect(screen.getByText(/Import all \(1, excl\. no-code\)/)).toBeInTheDocument();
  });

  it('transforms the Check button in place into Import all once the queue appears', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    expect(screen.queryByText(/Check Schoology for archived courses/)).not.toBeInTheDocument();
    expect(screen.getByText(/Import all \(1, excl\. no-code\)/)).toBeInTheDocument();
  });

  it('Import all imports only code-bearing, not-yet-imported sections', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({});
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    fireEvent.click(screen.getByText(/Import all/));
    await waitFor(() => expect(importCourse).toHaveBeenCalledTimes(1));
    expect(importCourse).toHaveBeenCalledWith('7005');
  });

  it('logs in on demand and auto-re-runs discovery', async () => {
    discoverArchivedCourses
      .mockResolvedValueOnce({ available: false, reason: 'no_session' })
      .mockResolvedValueOnce(DISCOVERED);
    triggerMasteryLogin.mockResolvedValue({});
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText(/Log in to Schoology/);
    fireEvent.click(screen.getByText(/Log in to Schoology/));
    await waitFor(() => expect(triggerMasteryLogin).toHaveBeenCalled());
    // auto re-check surfaces the queue without another Check click
    await screen.findByText('Drama 8');
    expect(discoverArchivedCourses).toHaveBeenCalledTimes(2);
  });

  it('per-course Import removes the row from the queue and refreshes the Dashboard', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockResolvedValue({});
    const onImported = vi.fn();
    renderPanel({ onImported });
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    const dramaRow = screen.getByText('Drama 8').closest('.archived-import-row');
    fireEvent.click(within(dramaRow).getByText('Import'));
    await waitFor(() => expect(importCourse).toHaveBeenCalledWith('7005'));
    await waitFor(() => expect(screen.queryByText('Drama 8')).not.toBeInTheDocument());
    expect(onImported).toHaveBeenCalled();
    expect(screen.queryByText(/Import all/)).not.toBeInTheDocument();
  });

  it('excludes already-imported discovered sections from the queue', async () => {
    discoverArchivedCourses.mockResolvedValue({
      available: true,
      sections: [
        { courseTitle: 'History 9', courseCode: 'HIS9', sectionId: '7010', imported: true, noCourseCode: false },
        { courseTitle: 'Drama 8', courseCode: 'DRA8', sectionId: '7005', imported: false, noCourseCode: false },
      ],
    });
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    expect(screen.queryByText('History 9')).not.toBeInTheDocument();
    expect(screen.getByText(/Found on Schoology \(2\) — 1 not yet imported/)).toBeInTheDocument();
    expect(screen.getByText(/Import all \(1, excl\. no-code\)/)).toBeInTheDocument();
  });

  it('surfaces an error when an import fails', async () => {
    discoverArchivedCourses.mockResolvedValue(DISCOVERED);
    importCourse.mockRejectedValue(new Error('Section not accessible'));
    renderPanel();
    fireEvent.click(screen.getByText(/Check Schoology for archived courses/));
    await screen.findByText('Drama 8');
    const dramaRow = screen.getByText('Drama 8').closest('.archived-import-row');
    fireEvent.click(within(dramaRow).getByText('Import'));
    expect(await screen.findByText('Section not accessible')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run src/components/ArchivedCoursesPanel.test.jsx`
Expected: FAIL — the current component renders no element matching `.archived-import-row`, has no self-contained login (`triggerMasteryLogin` not imported), and gates discovery behind the collapse caret, so the new tests cannot find the expected nodes.

- [ ] **Step 3: Rewrite the component `ArchivedCoursesPanel.jsx`**

Replace the entire file with:

```jsx
import { useState } from 'react';
import { discoverArchivedCourses, importCourse, triggerMasteryLogin } from '../services/api.js';

// Discovery-only surface for importing archived (past) courses, mounted on the
// Dashboard Archived tab (issue #69). It scrapes Schoology's /mycourses/past source
// page via the saved browser session to list archived sections NOT yet imported, and
// imports them once (per-course or bulk). Already-imported archived courses are shown
// as cards by the Dashboard itself — this component never renders them (no
// duplication). Self-contained login: it owns the "Log in to Schoology" trigger and
// its busy state, and auto-re-runs discovery on success. "Archived" is the app's
// canonical term; "past" only names Schoology's source page (see CONTEXT.md).
export default function ArchivedCoursesPanel({ onImported }) {
  const [discovered, setDiscovered] = useState(null); // null until checked
  const [checking, setChecking] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [importingId, setImportingId] = useState(null);
  const [importedIds, setImportedIds] = useState(() => new Set()); // imported this session
  const [bulk, setBulk] = useState(null); // { done, total } while bulk-importing
  const [error, setError] = useState(null);

  const isImported = (s) => s.imported || importedIds.has(s.sectionId);
  const markImported = (sectionId) =>
    setImportedIds((prev) => new Set(prev).add(sectionId));

  async function handleCheck() {
    setChecking(true); setError(null); setNeedLogin(false);
    try {
      const res = await discoverArchivedCourses();
      if (!res.available) { setNeedLogin(true); setDiscovered(null); }
      else setDiscovered(res.sections);
    } catch (e) {
      setError(e.message);
    } finally {
      setChecking(false);
    }
  }

  async function handleLogin() {
    setLoggingIn(true); setError(null);
    try {
      await triggerMasteryLogin();
      setNeedLogin(false);
      await handleCheck(); // auto re-run discovery once logged in
    } catch (e) {
      setError(e.message);
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleImport(sectionId) {
    setImportingId(sectionId); setError(null);
    try {
      await importCourse(sectionId);
      markImported(sectionId); // drops it from the to-import queue below
      onImported?.();           // refetch so it appears as a card on the Dashboard
    } catch (e) {
      setError(e.message);
    } finally {
      setImportingId(null);
    }
  }

  async function handleImportAll() {
    const targets = (discovered || []).filter((s) => !isImported(s) && !s.noCourseCode);
    setBulk({ done: 0, total: targets.length }); setError(null);
    let anySucceeded = false;
    for (let i = 0; i < targets.length; i++) {
      try {
        await importCourse(targets[i].sectionId);
        markImported(targets[i].sectionId);
        anySucceeded = true;
      } catch (e) {
        setError(e.message);
      }
      // `done` counts attempts so the bar advances even on a failure; importedIds
      // reflects the actual successes.
      setBulk({ done: i + 1, total: targets.length });
    }
    setBulk(null);
    if (anySucceeded) onImported?.(); // refresh the cards once
  }

  // The found-list is the to-import queue — only sections not already imported.
  // Imported ones are the Dashboard's cards (no duplication here).
  const remaining = (discovered || []).filter((s) => !isImported(s));
  const importAllCount = remaining.filter((s) => !s.noCourseCode).length;

  return (
    <div className="archived-import">
      <h3 className="archived-import-title">Import archived courses from Schoology</h3>

      {/* One action slot: "Check Schoology" before a scan, then it transforms in
          place into "Import all" once the queue is known. */}
      <div className="archived-import-action">
        {discovered === null ? (
          <button type="button" className="secondary" onClick={handleCheck} disabled={checking || loggingIn}>
            {checking ? 'Checking…' : 'Check Schoology for archived courses'}
          </button>
        ) : importAllCount > 0 ? (
          <button
            type="button"
            className="primary"
            onClick={handleImportAll}
            disabled={!!bulk || importingId !== null}
          >
            {bulk
              ? `Importing ${bulk.done}/${bulk.total}…`
              : `Import all (${importAllCount}, excl. no-code)`}
          </button>
        ) : null}
      </div>

      {needLogin && (
        <div className="alert alert-warning sync-login-prompt">
          <p>Finding archived courses needs a Schoology browser session. Log in once to enable it.</p>
          <button type="button" className="secondary" onClick={handleLogin} disabled={loggingIn}>
            {loggingIn ? 'Logging in…' : 'Log in to Schoology'}
          </button>
        </div>
      )}

      {error && <div className="alert alert-warning">{error}</div>}

      {discovered && remaining.length > 0 && (
        <>
          <p className="archived-import-found">
            Found on Schoology ({discovered.length}) — {remaining.length} not yet imported
          </p>
          <div className="archived-import-list">
            {remaining.map((s) => (
              <div className="archived-import-row" key={s.sectionId}>
                <span>
                  {s.courseTitle}
                  {s.noCourseCode && <span className="badge badge-gray"> no course code</span>}
                </span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => handleImport(s.sectionId)}
                  disabled={importingId === s.sectionId || !!bulk}
                >
                  {importingId === s.sectionId ? 'Importing…' : 'Import'}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {discovered && remaining.length === 0 && (
        <p className="archived-import-empty">
          {discovered.length === 0
            ? 'No archived courses found on Schoology.'
            : 'All archived courses found on Schoology are imported.'}
        </p>
      )}
    </div>
  );
}
```

(The login alert reuses the shared `sync-login-prompt` helper — a neutral font-size/margin/button-spacing utility, not dialog chrome. All structural sync-dialog classes — `sync-step`, `sync-group`, `sync-course`, `sync-badge`, `sync-caret` — are gone.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run src/components/ArchivedCoursesPanel.test.jsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Restyle in `app.css`**

Replace the orphaned discovery-row rules (currently lines 821–824):

```css
/* Discovery rows: the action sits right-aligned as a clear button, and the whole
   row highlights on hover so it's obvious which course a button belongs to. */
.archived-discovery-row { justify-content: space-between; gap: 0.75rem; padding: 0.3rem 0.5rem; border-radius: 6px; transition: background 0.12s ease; }
.archived-discovery-row:hover { background: var(--bg-subtle); }
```

with the new Dashboard-matched section:

```css
/* ── Archived-course import (Dashboard Archived tab, #69) ────────── */
.archived-import { margin-bottom: 2rem; }
.archived-import-title {
  margin: 0 0 0.75rem;
  color: var(--text-muted);
  font-weight: 500; font-size: 0.85rem;
  text-transform: uppercase; letter-spacing: 0.08em;
}
.archived-import-action { margin-bottom: 0.75rem; }
.archived-import-found {
  color: var(--text-muted); font-size: 0.85rem; margin: 0 0 0.4rem;
}
.archived-import-list { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.5rem; }
.archived-import-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem; padding: 0.45rem 0.65rem;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--card-bg);
  transition: background 0.12s ease;
}
.archived-import-row:hover { background: var(--bg-subtle); }
.archived-import-empty { color: var(--text-muted); font-size: 0.85rem; }
```

- [ ] **Step 6: Re-run the panel test (CSS change must not break it) and commit**

Run: `cd client && npx vitest run src/components/ArchivedCoursesPanel.test.jsx`
Expected: PASS (7 tests).

```bash
git add client/src/components/ArchivedCoursesPanel.jsx client/src/components/ArchivedCoursesPanel.test.jsx client/src/app.css
git commit -m "refactor(#69): ArchivedCoursesPanel becomes discovery-only + self-contained login

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Mount the panel on the Dashboard Archived tab + remove the manual form (TDD)

**Files:**
- Create: `client/src/pages/Dashboard.test.jsx`
- Modify: `client/src/pages/Dashboard.jsx` (import line 3; new component import; state lines 12–15; `useEffect` lines 41–45; `handleImport` lines 54–71; archived-tab block lines 206–259)

- [ ] **Step 1: Write the failing test `client/src/pages/Dashboard.test.jsx`**

Create the file with:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  getCourses: vi.fn(),
  getCoursesByView: vi.fn(),
  getSyncStatus: vi.fn(),
  toggleCourseVisibility: vi.fn(),
  updateCourseBlockNumber: vi.fn(),
  discoverArchivedCourses: vi.fn(),
  importCourse: vi.fn(),
  triggerMasteryLogin: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.getCoursesByView.mockResolvedValue([]);
  api.getCourses.mockResolvedValue([]);
  api.getSyncStatus.mockResolvedValue({});
});

function renderDashboard() {
  return render(<MemoryRouter><Dashboard /></MemoryRouter>);
}

describe('Dashboard — Archived tab', () => {
  it('shows the archived-course discovery surface', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByText('Archived'));
    expect(await screen.findByText(/Check Schoology for archived courses/)).toBeInTheDocument();
  });

  it('no longer renders the manual "Add an archived course" form', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByText('Archived'));
    await screen.findByText(/Check Schoology for archived courses/);
    expect(screen.queryByText('Add an archived course')).not.toBeInTheDocument();
    expect(screen.queryByText(/Section ID/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run src/pages/Dashboard.test.jsx`
Expected: FAIL — the Dashboard does not yet render `ArchivedCoursesPanel` (no "Check Schoology…" text) and still renders the "Add an archived course" form.

- [ ] **Step 3: Update imports in `Dashboard.jsx`**

Change the api import (line 3) — drop `importCourse` (only the deleted form used it):

```jsx
import { getCourses, getCoursesByView, getSyncStatus, toggleCourseVisibility, importCourse, updateCourseBlockNumber } from '../services/api.js';
```

to:

```jsx
import { getCourses, getCoursesByView, getSyncStatus, toggleCourseVisibility, updateCourseBlockNumber } from '../services/api.js';
```

Add the component import directly below the `courseDisplay` import (after line 4):

```jsx
import ArchivedCoursesPanel from '../components/ArchivedCoursesPanel.jsx';
```

- [ ] **Step 4: Remove the manual-import state and handler in `Dashboard.jsx`**

Delete these state declarations (lines 12–15):

```jsx
  const [importId, setImportId] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importSuccess, setImportSuccess] = useState(null);
```

Simplify the `useEffect` (lines 41–45) — drop the now-undefined setters:

```jsx
  useEffect(() => {
    setImportError(null);
    setImportSuccess(null);
    reload();
  }, [activeTab, showHidden]);
```

to:

```jsx
  useEffect(() => {
    reload();
  }, [activeTab, showHidden]);
```

Delete the `handleImport` function (lines 54–71):

```jsx
  async function handleImport(e) {
    e.preventDefault();
    const sid = importId.trim();
    if (!sid) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const result = await importCourse(sid);
      setImportSuccess(result);
      setImportId('');
      reload();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  }
```

- [ ] **Step 5: Replace the archived-tab block in `Dashboard.jsx`**

Replace the entire `{activeTab === 'archived' && (...)}` block (lines 206–259) with:

```jsx
      {/* Archived tab */}
      {activeTab === 'archived' && (
        <div>
          <ArchivedCoursesPanel onImported={reload} />

          {yearGroups.length === 0 ? (
            <div className="card empty-state">
              <p>No archived courses imported yet. Use the "Check Schoology for archived courses" action above to find and import them.</p>
            </div>
          ) : (
            yearGroups.map(({ year, courses: groupCourses }) => (
              <div key={year} style={{ marginBottom: '2rem' }}>
                <h3 style={{ marginBottom: '0.75rem', color: 'var(--text-muted)', fontWeight: 500, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {year}
                </h3>
                <div className="grid-2">
                  {groupCourses.map(c => <CourseCard key={c.id} c={c} showSemester />)}
                </div>
              </div>
            ))
          )}
        </div>
      )}
```

- [ ] **Step 6: Run the Dashboard test to verify it passes**

Run: `cd client && npx vitest run src/pages/Dashboard.test.jsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full client suite**

Run: `cd client && npx vitest run`
Expected: PASS — all client tests green (the `ArchivedCoursesPanel` rewrite, the removed `SyncConfig` panel test, and the new `Dashboard.test.jsx` reconcile).

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/Dashboard.jsx client/src/pages/Dashboard.test.jsx
git commit -m "feat(#69): mount archived-import discovery on the Dashboard Archived tab; remove manual form

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Update `CONTEXT.md`

**Files:**
- Modify: `CONTEXT.md` (the canonical-term example list, lines ~11–16; the "Sync dialog surfaces" section, lines ~37–45)

- [ ] **Step 1: Fix the canonical-term example list**

Replace (lines ~11–16):

```markdown
- **Archived** — the **canonical** term for a completed / past course (a previous
  year or semester). Backed by the `courses.archived` flag. Use it everywhere
  user-facing (Dashboard **Archived** tab, the Sync dialog's **Import archived
  courses** panel, the **Include archived courses** toggle) and in app-level code
  (`server/services/archivedCourses.js`, `getArchivedSections`,
  `discoverArchivedCourses`, `GET /api/courses/archived/discover`,
  `ArchivedCoursesPanel`).
```

with:

```markdown
- **Archived** — the **canonical** term for a completed / past course (a previous
  year or semester). Backed by the `courses.archived` flag. Use it everywhere
  user-facing (the Dashboard **Archived** tab — which hosts both the imported-course
  cards and the **Import archived courses** discovery surface — and the Sync dialog's
  **Include archived courses** toggle) and in app-level code
  (`server/services/archivedCourses.js`, `getArchivedSections`,
  `discoverArchivedCourses`, `GET /api/courses/archived/discover`,
  `ArchivedCoursesPanel`).
```

- [ ] **Step 2: Rewrite the "Sync dialog surfaces" section**

Replace (lines ~37–45):

```markdown
## Sync dialog surfaces (avoid label collisions)

The Sync dialog has two *different* archived-course surfaces — keep their labels
distinct:
- **Step 2 → "Archived courses"** group — selects already-imported archived
  courses for the optional **mastery (SBG)** sync.
- **"Import archived courses"** panel — discovers archived sections from Schoology
  and imports them once (gradebook only; mastery stays opt-in via the Step 2
  group).
```

with:

```markdown
## Archived-course surfaces (avoid label collisions)

After #69 the **Sync dialog** has a single archived-course surface — the **Step 2 →
"Archived courses"** group, which selects already-imported archived courses for the
optional **mastery (SBG)** sync. The **Import archived courses** discovery surface
(`ArchivedCoursesPanel`: discovers archived sections from Schoology and imports them
once — gradebook only; mastery stays opt-in via the Step 2 group) now lives on the
**Dashboard Archived tab**, above the imported-course cards. Keep these two labels
distinct.
```

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md
git commit -m "docs(#69): CONTEXT — archived-import discovery moved to the Dashboard tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full verification + build-progress entry

**Files:**
- Modify: `.claude/build-progress.md` (append a #69 entry)

- [ ] **Step 1: Run both full test suites**

Run: `npx vitest run` (server) and `cd client && npx vitest run` (client)
Expected: server PASS (122); client PASS (the prior 125 minus the removed `SyncConfig` panel test, minus the dropped imported-list panel test, plus the 2 new `Dashboard.test.jsx` tests — net count is informational, the bar is **all green, zero failures**).

- [ ] **Step 2: Live UI verification**

Ensure the dev server is running (`npm run dev`; if the port is stuck, see CLAUDE.md's listener-kill one-liner). In the browser:
- Dashboard → **Archived** tab: the "Import archived courses from Schoology" surface renders **above** the year-grouped cards; the old Section-ID form is gone.
- Click **Check Schoology for archived courses** → the queue of not-yet-imported sections appears and the button becomes **Import all (N, excl. no-code)**; no-code rows show the "no course code" badge.
- Import one course → its row leaves the queue and it appears as a **card** above (once, not duplicated). `Import all` imports the code-bearing remainder.
- If there is no browser session, the **Log in to Schoology** prompt shows; after login the check **auto-re-runs**. (Only run `npm run mastery:login` if the session is actually dead — confirm first.)
- Open the sidebar **Sync** dialog → it no longer contains the "Import archived courses" panel; the Step 2 mastery **"Archived courses"** group is unaffected.

- [ ] **Step 3: Append a build-progress entry**

Add a dated `## 2026-05-31 — #69 …` entry to `.claude/build-progress.md` summarising: panel relocated to the Dashboard Archived tab (above the cards), slimmed to discovery-only + self-contained login (auto-re-check), manual Section-ID form removed, Sync dialog wiring (`refreshCourses`/`onImported`) removed, `CONTEXT.md` updated, tests rewritten + `Dashboard.test.jsx` added. Note the live-verified result. End with the standard "not yet explored" list (carry forward the deferred items: configurable date-format/locale + shared `formatDate`; the inert "Include archived" toggle cleanup; whether the internal mastery API serves archived sections).

- [ ] **Step 4: Commit**

```bash
git add .claude/build-progress.md
git commit -m "docs(#69): build-progress — archived-import relocation shipped

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Close the issue (after the human confirms live verification)**

```bash
gh issue close 69 --comment "Relocated the archived-course discovery/import to the Dashboard Archived tab (above the cards), removed the redundant Section-ID form, reconciled with the card view, and slimmed ArchivedCoursesPanel to discovery-only + self-contained login. Backend unchanged. Tests rewritten + Dashboard.test.jsx added; suites green; live-verified."
```

---

## Self-Review

**Spec coverage:**
- Panel → discovery-only, drops imported list + `courses` prop + display helpers → Task 2.
- Props shrink to `onImported`; `loggedIn` dead-prop removed; self-contained `triggerMasteryLogin` + busy → Task 2.
- Drop collapse caret + "Import once" badge → Task 2 (component rewrite has neither).
- Auto-re-run check after login → Task 2 (`handleLogin` calls `handleCheck`; covered by the "logs in on demand and auto-re-runs discovery" test).
- Restyle to Dashboard via new `.archived-import*` classes → Task 2 Step 5.
- Mount above the cards + remove manual form + empty-state copy → Task 3.
- Sync dialog cleanup (`SyncConfig` panel + `onImported`; `SyncDialog.refreshCourses`) → Task 1.
- `CONTEXT.md` two spots → Task 4.
- Tests: rewrite panel test, remove SyncConfig panel test, add `Dashboard.test.jsx` → Tasks 1–3; full-suite + live verify → Task 5.
- Backend unchanged → no backend task. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected outcomes. ✓ (The net client test count in Task 5 is intentionally described as informational — the pass/fail bar is explicit.)

**Type/name consistency:** `discoverArchivedCourses`, `importCourse`, `triggerMasteryLogin`, `onImported`, `reload`, `.archived-import-row` (used identically in the component and both test files), `handleCheck`/`handleLogin`/`handleImport`/`handleImportAll` — consistent across tasks. The `renderConfig` helper in `SyncConfig.test.jsx` already omits `onImported`, so removing it from the signature is safe. ✓
