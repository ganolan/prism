# Persist /assessment/ Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unsaved grading work on the `/assessment/` page (rubric selections, comment text, display toggle) survives a browser refresh by persisting to localStorage.

**Architecture:** A new `client/src/lib/assessmentDraft.js` module owns the localStorage read/write/clear logic behind a tiny key-based API. `StudentRubricCard` in `AssessmentSummaryPage.jsx` reads a draft via lazy `useState` initializers on mount, writes it from a `useEffect` whenever unsaved changes exist, and explicitly clears it on a successful Schoology save.

**Tech Stack:** React (Vite client), localStorage. Tests added with Vitest + React Testing Library (jsdom environment) — the client has no test harness today, so Task 1 sets one up.

Spec: [docs/superpowers/specs/2026-05-16-assessment-draft-persistence-design.md](../specs/2026-05-16-assessment-draft-persistence-design.md)

---

### Task 1: Set up Vitest + React Testing Library

The client (`client/`) currently has no test framework. This task adds one so the rest of the plan (and Waves 3-5) can write automated tests.

**Files:**
- Modify: `client/package.json`
- Modify: `client/vite.config.js`
- Create: `client/src/test-setup.js`
- Test: `client/src/lib/smoke.test.js` (temporary — deleted in this task's last step)

- [ ] **Step 1: Install dev dependencies**

Run (from `client/`):

```bash
cd client && npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

Expected: packages added to `client/package.json` `devDependencies`, no errors.

- [ ] **Step 2: Add the `test` script to `client/package.json`**

In the `"scripts"` block of `client/package.json`, add a `test` entry alongside the existing `dev`/`build`/`preview` scripts:

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest"
  },
```

- [ ] **Step 3: Add the Vitest config to `client/vite.config.js`**

Replace the contents of `client/vite.config.js` with:

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.js',
  },
});
```

- [ ] **Step 4: Create the test setup file**

Create `client/src/test-setup.js`:

```js
import '@testing-library/jest-dom';
```

- [ ] **Step 5: Write a temporary smoke test**

Create `client/src/lib/smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';

describe('test harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Run the smoke test**

Run (from `client/`): `npm test -- --run`
Expected: PASS — 1 test passed.

- [ ] **Step 7: Delete the smoke test**

```bash
rm client/src/lib/smoke.test.js
```

- [ ] **Step 8: Commit**

```bash
git add client/package.json client/package-lock.json client/vite.config.js client/src/test-setup.js
git commit -m "test: set up Vitest + React Testing Library for the client"
```

Note: if `package-lock.json` lives at the repo root instead of `client/`, stage that path instead.

---

### Task 2: Create the `assessmentDraft` localStorage module

A focused module that owns the storage key format and the three localStorage operations, each guarded against localStorage being unavailable.

**Files:**
- Create: `client/src/lib/assessmentDraft.js`
- Test: `client/src/lib/assessmentDraft.test.js`

- [ ] **Step 1: Write the failing tests**

Create `client/src/lib/assessmentDraft.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { draftKey, readDraft, writeDraft, clearDraft } from './assessmentDraft.js';

beforeEach(() => {
  localStorage.clear();
});

describe('draftKey', () => {
  it('builds a namespaced key from course, assignment, and enrollment ids', () => {
    expect(draftKey('4', '8216461388', '99')).toBe(
      'prism:assessment-draft:4:8216461388:99'
    );
  });
});

describe('writeDraft / readDraft', () => {
  it('round-trips a draft object', () => {
    const key = draftKey('4', '8', '1');
    const draft = { pending: { t1: 'ED' }, comment: 'hi', display: true };
    writeDraft(key, draft);
    expect(readDraft(key)).toEqual(draft);
  });

  it('returns null when no draft is stored', () => {
    expect(readDraft(draftKey('4', '8', '1'))).toBeNull();
  });

  it('returns null when the stored value is not valid JSON', () => {
    const key = draftKey('4', '8', '1');
    localStorage.setItem(key, '{not json');
    expect(readDraft(key)).toBeNull();
  });
});

describe('clearDraft', () => {
  it('removes a stored draft', () => {
    const key = draftKey('4', '8', '1');
    writeDraft(key, { pending: {}, comment: 'x', display: false });
    clearDraft(key);
    expect(readDraft(key)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `client/`): `npm test -- --run assessmentDraft`
Expected: FAIL — cannot resolve `./assessmentDraft.js` / functions not defined.

- [ ] **Step 3: Write the module**

Create `client/src/lib/assessmentDraft.js`:

```js
// Persists unsaved /assessment/ grading work (rubric selections, comment text,
// display toggle) to localStorage so it survives a page reload. See #47.

const PREFIX = 'prism:assessment-draft';

export function draftKey(courseId, assignmentId, enrollmentId) {
  return `${PREFIX}:${courseId}:${assignmentId}:${enrollmentId}`;
}

export function readDraft(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // localStorage unavailable or value corrupt — treat as no draft.
    return null;
  }
}

export function writeDraft(key, draft) {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // localStorage unavailable (private mode / quota) — degrade silently.
  }
}

export function clearDraft(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // localStorage unavailable — nothing to clear.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `client/`): `npm test -- --run assessmentDraft`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/assessmentDraft.js client/src/lib/assessmentDraft.test.js
git commit -m "feat(#47): add assessmentDraft localStorage module"
```

---

### Task 3: Wire `StudentRubricCard` to persist, restore, and clear drafts

Connect the module into the card: restore on mount, write on change, clear on save.

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx`
- Test: `client/src/pages/AssessmentSummaryPage.test.jsx`

- [ ] **Step 1: Write the failing component tests**

Create `client/src/pages/AssessmentSummaryPage.test.jsx`:

```jsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StudentRubricCard } from './AssessmentSummaryPage.jsx';

vi.mock('../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn().mockResolvedValue({}),
  writeMasteryComment: vi.fn().mockResolvedValue({}),
}));

const TOPICS = [
  { id: 't1', title: 'Topic 1', category_title: 'Cat', external_id: 'X1' },
];

function makeStudent() {
  return {
    id: 1,
    enrollment_id: 'enr-1',
    schoology_uid: 'uid-1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    preferred_name: null,
    preferred_name_teacher: null,
    grade_comment: '',
    comment_status: 0,
    exception: null,
    scores: {},
  };
}

function renderCard(extraProps = {}) {
  return render(
    <MemoryRouter>
      <StudentRubricCard
        student={makeStudent()}
        topics={TOPICS}
        courseId="4"
        assignmentId="8"
        assignmentRow={{ mastery_grading_period_id: 1, mastery_grading_category_id: 2 }}
        onSaved={() => {}}
        {...extraProps}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('StudentRubricCard draft persistence', () => {
  it('restores pending rubric selection and comment text after a remount', () => {
    const { unmount } = renderCard();

    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    fireEvent.change(screen.getByPlaceholderText(/Teacher comment/i), {
      target: { value: 'work in progress' },
    });

    expect(screen.getByText('1 pending change')).toBeInTheDocument();

    unmount();
    renderCard();

    expect(screen.getByText('1 pending change')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Teacher comment/i)).toHaveValue(
      'work in progress'
    );
  });

  it('clears the stored draft after a successful save', async () => {
    renderCard();

    fireEvent.click(screen.getByTitle('Set Topic 1 to Developing'));
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Update Schoology' }));

    await waitFor(() => {
      expect(
        localStorage.getItem('prism:assessment-draft:4:8:enr-1')
      ).toBeNull();
    });
  });

  it('does not write a draft when there are no unsaved changes', () => {
    renderCard();
    expect(
      localStorage.getItem('prism:assessment-draft:4:8:enr-1')
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `client/`): `npm test -- --run AssessmentSummaryPage`
Expected: FAIL — `StudentRubricCard` is not an exported member of `AssessmentSummaryPage.jsx`.

- [ ] **Step 3: Export `StudentRubricCard` and import the draft module**

In `client/src/pages/AssessmentSummaryPage.jsx`, add the import near the top (after the existing `api.js` import on line 3):

```jsx
import { draftKey, readDraft, writeDraft, clearDraft } from '../lib/assessmentDraft.js';
```

Add the `useEffect` to the React import on line 1 — change:

```jsx
import { useState, useEffect } from 'react';
```

(it already imports both — no change needed if so; confirm `useEffect` is present).

Change the `StudentRubricCard` declaration on line 29 from:

```jsx
function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, onSaved }) {
```

to:

```jsx
export function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, onSaved }) {
```

- [ ] **Step 4: Restore the draft via lazy `useState` initializers**

In `StudentRubricCard`, replace this exact block — the `// pending:` comment
through the `autoFlipArmed` `useState` call (the lines immediately after the
function's opening brace):

```jsx
  // pending: { [topicId]: 'ED'|'EX'|'D'|'EM'|'IE' }
  const [pending, setPending] = useState({});
  const [comment, setComment] = useState(student.grade_comment || '');
  // Display-to-student toggle (#34). Loaded from grades.comment_status:
  // 1 → ON, anything else → OFF. Auto-flip is armed when the row hasn't been
  // published yet AND has no comment text — covers virgin records and rows
  // that exist from a sync but haven't had any meaningful teacher action.
  // Once the toggle has been touched (auto or manual) we disarm; Schoology's
  // existing state (already-published rows or rows with saved comments) is
  // never auto-flipped over.
  const loadedDisplay = student.comment_status === 1;
  const [display, setDisplay] = useState(loadedDisplay);
  const [autoFlipArmed, setAutoFlipArmed] = useState(
    student.comment_status !== 1 && !student.grade_comment
  );
```

with this block (the display-toggle comment is preserved; `loadedDisplay` and
`storageKey` are hoisted above the `useState` calls that reference them):

```jsx
  const loadedDisplay = student.comment_status === 1;
  const storageKey = draftKey(courseId, assignmentId, student.enrollment_id);

  // Restore any unsaved draft for this card from localStorage (#47). Read once
  // on mount; a restored draft means the teacher already interacted with the
  // card, so auto-flip starts disarmed.
  const [restoredDraft] = useState(() => readDraft(storageKey));

  // pending: { [topicId]: 'ED'|'EX'|'D'|'EM'|'IE' }
  const [pending, setPending] = useState(() => restoredDraft?.pending ?? {});
  const [comment, setComment] = useState(
    () => restoredDraft?.comment ?? (student.grade_comment || '')
  );
  // Display-to-student toggle (#34). Loaded from grades.comment_status:
  // 1 → ON, anything else → OFF. Auto-flip is armed when the row hasn't been
  // published yet AND has no comment text — covers virgin records and rows
  // that exist from a sync but haven't had any meaningful teacher action.
  // Once the toggle has been touched (auto or manual) we disarm; Schoology's
  // existing state (already-published rows or rows with saved comments) is
  // never auto-flipped over. A restored draft also disarms it.
  const [display, setDisplay] = useState(
    () => restoredDraft?.display ?? loadedDisplay
  );
  const [autoFlipArmed, setAutoFlipArmed] = useState(() =>
    restoredDraft
      ? false
      : student.comment_status !== 1 && !student.grade_comment
  );
```

- [ ] **Step 5: Persist the draft from a `useEffect`**

In `StudentRubricCard`, immediately after the `hasPendingChanges` declaration (currently lines 60-64), add:

```jsx
  // Persist unsaved work to localStorage so it survives a page reload (#47).
  // Remove the entry the moment the card returns to a no-changes state.
  useEffect(() => {
    if (hasPendingChanges) {
      writeDraft(storageKey, { pending, comment, display });
    } else {
      clearDraft(storageKey);
    }
  }, [hasPendingChanges, pending, comment, display, storageKey]);
```

- [ ] **Step 6: Clear the draft on a successful save**

In `handleSave`, the success path currently reads (lines 127-129):

```jsx
      setSaveResult('saved');
      setPending({});
      onSaved?.();
```

Change it to:

```jsx
      setSaveResult('saved');
      setPending({});
      // Explicit clear: onSaved() triggers a page reload that unmounts this
      // card, so the write effect above will not run to clear the key itself.
      clearDraft(storageKey);
      onSaved?.();
```

- [ ] **Step 7: Run the component tests to verify they pass**

Run (from `client/`): `npm test -- --run AssessmentSummaryPage`
Expected: PASS — 3 tests passed.

- [ ] **Step 8: Run the full client test suite**

Run (from `client/`): `npm test -- --run`
Expected: PASS — all tests (assessmentDraft + AssessmentSummaryPage) green.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "feat(#47): persist unsaved /assessment/ drafts across page reloads"
```

---

### Task 4: Manual browser verification

Automated tests cover the logic; this task confirms the feature works against the real running app.

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run (from repo root): `npm run dev`
If the port is busy: `lsof -ti:3001 | xargs kill -9; lsof -ti:5173 | xargs kill -9` then retry.

- [ ] **Step 2: Walk the verification checklist**

Open an `/assessment/` page with synced students and confirm each:

1. Make rubric selections, edit a comment, toggle "Display to student" on one card → reload the page → all three are restored, "N pending changes" badge intact.
2. Click "Update Schoology" → wait for "Saved ✓" → reload → card shows synced values, no draft, "No changes".
3. Make changes → click "Discard Changes" → reload → card shows synced values, no draft.
4. Make changes → click "Refresh from Schoology" → the unsaved draft still shows after the refresh.
5. Make independent changes on two different students → reload → each card restores its own draft only.
6. On a rubric-locked card (exception active), edit the comment / toggle display → reload → comment and toggle draft are restored.

- [ ] **Step 3: Confirm completion**

All six checklist items pass → #47 is complete. If any fail, return to Task 3.
