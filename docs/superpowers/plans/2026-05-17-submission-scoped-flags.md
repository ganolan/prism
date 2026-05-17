# Submission-scoped review flags + student-profile cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the "review needed" flag off the student profile and onto individual assignment submissions on the assessment page, and remove the now-redundant Flags and analytics sections from the student profile.

**Architecture:** No schema change — the `flags` table already has a nullable `assignment_id`. Review flags become `flags` rows with `flag_type = 'review_needed'` and both `student_id` and `assignment_id` set. A boot-time purge clears orphaned student-scoped (`assignment_id IS NULL`) flags. The assessment-page rubric card creates/clears the flag via the existing `/api/flags` routes; the mastery-for-assignment endpoint surfaces each student's current flag. The student profile drops the FlagsCard, the active-flags banner, and the `StudentAnalytics` component (which renders nothing once its two sections are removed).

**Tech Stack:** Express, better-sqlite3, React, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-17-submission-scoped-flags-design.md`

---

## File Structure

- `server/db/index.js` — add `purgeStudentScopedFlags()`, call it from `migrate()`.
- `server/db/index.test.js` — tests for the new purge.
- `server/routes/mastery.js` — `GET /:courseId/assignment/:assignmentId` attaches `review_flag` per student.
- `server/routes/mastery.test.js` — DB-backed tests for the `review_flag` field.
- `server/routes/analytics.js` — remove the unused `GET /student/:id` handler.
- `client/src/pages/AssessmentSummaryPage.jsx` — `StudentRubricCard` gains the review-flag control.
- `client/src/pages/AssessmentSummaryPage.test.jsx` — tests for the review-flag control.
- `client/src/pages/StudentPage.jsx` — remove FlagsCard, the active-flags banner, `CollapsibleCard`, and the `StudentAnalytics` usage; export `CourseSection`.
- `client/src/pages/StudentPage.test.jsx` — replace the FlagsCard tests with a `CourseSection` badge test.
- `client/src/components/StudentAnalytics.jsx` — deleted.
- `client/src/services/api.js` — remove `getStudentAnalytics`.

The `flags` table, `flags.js` routes, and `createFlag`/`deleteFlag` API helpers are reused unchanged.

---

## Task 1: DB migration — purge orphaned student-scoped flags

**Files:**
- Modify: `server/db/index.js`
- Test: `server/db/index.test.js`

- [ ] **Step 1: Write the failing test**

In `server/db/index.test.js`, update the import on line 3 to add `purgeStudentScopedFlags`:

```js
import { migrate, purgeLegacyAutoFlags, purgeStudentScopedFlags } from './index.js';
```

Append this `describe` block to the end of the file:

```js
describe('purgeStudentScopedFlags', () => {
  let db;
  let studentId;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    studentId = newStudent(db);
  });

  test('deletes flags with no assignment_id', () => {
    seedFlag(db, studentId, 'custom');
    seedFlag(db, studentId, 'review_needed');
    purgeStudentScopedFlags(db);
    expect(db.prepare('SELECT COUNT(*) AS c FROM flags').get().c).toBe(0);
  });

  test('keeps submission-scoped flags (assignment_id set)', () => {
    db.prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, 999, 'review_needed', 'recheck')`
    ).run(studentId);
    purgeStudentScopedFlags(db);
    expect(db.prepare('SELECT COUNT(*) AS c FROM flags').get().c).toBe(1);
  });

  test('runs as part of migrate() and is idempotent', () => {
    seedFlag(db, studentId, 'custom');
    migrate(db);
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS c FROM flags').get().c).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/db/index.test.js`
Expected: FAIL — `purgeStudentScopedFlags` is not exported (`SyntaxError` / undefined import).

- [ ] **Step 3: Write the implementation**

In `server/db/index.js`, add this function immediately after `purgeLegacyAutoFlags` (after its closing `}` on line 52):

```js
// Remove orphaned student-scoped flags. Before #20/#19, flags could be created
// against a student profile with no assignment_id (the retired FlagsCard).
// Review flags are now always submission-scoped — student AND assignment — so a
// NULL assignment_id marks a flag with no home in the UI. Idempotent — safe to
// run on every boot. See #20/#19.
export function purgeStudentScopedFlags(database) {
  database.exec(`DELETE FROM flags WHERE assignment_id IS NULL`);
}
```

In the same file, in `migrate()`, add the call right after `purgeLegacyAutoFlags(database);`:

```js
  purgeLegacyAutoFlags(database);
  purgeStudentScopedFlags(database);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/db/index.test.js`
Expected: PASS — all `purgeStudentScopedFlags` tests plus the existing `purgeLegacyAutoFlags` tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/db/index.js server/db/index.test.js
git commit -m "$(cat <<'EOF'
feat(#20,#19): purge orphaned student-scoped flags on boot

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Mastery-for-assignment endpoint surfaces the review flag

**Files:**
- Modify: `server/routes/mastery.js` (handler `GET /:courseId/assignment/:assignmentId`)
- Test: `server/routes/mastery.test.js`

- [ ] **Step 1: Write the failing test**

In `server/routes/mastery.test.js`, change the existing `vi.hoisted` call so it also points the DB at an in-memory database **before any import runs** (`vi.hoisted` is the only top-level code guaranteed to run before imports):

```js
const h = vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
  return { loggedIn: true };
});
```

Add a `getDb` import directly below the existing `import router from './mastery.js';` line:

```js
import { getDb } from '../db/index.js';
```

Append this `describe` block to the end of the file:

```js
describe('GET /api/mastery/:courseId/assignment/:assignmentId — review flags', () => {
  let courseId;
  let studentId;
  let assignmentInternalId;

  beforeEach(() => {
    const db = getDb();
    db.exec(
      'DELETE FROM flags; DELETE FROM enrolments; DELETE FROM assignments; ' +
      'DELETE FROM students; DELETE FROM courses;'
    );
    courseId = db.prepare(
      `INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'Course')`
    ).run().lastInsertRowid;
    studentId = db.prepare(
      `INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('uid-1', 'Ada', 'Lovelace')`
    ).run().lastInsertRowid;
    db.prepare(
      `INSERT INTO enrolments (student_id, course_id, schoology_enrolment_id) VALUES (?, ?, 'enr-1')`
    ).run(studentId, courseId);
    assignmentInternalId = db.prepare(
      `INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'sa-1', 'Project')`
    ).run(courseId).lastInsertRowid;
  });

  test('review_flag is null when the student has no review flag', async () => {
    const { status, body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(status).toBe(200);
    expect(body.students).toHaveLength(1);
    expect(body.students[0].review_flag).toBeNull();
  });

  test('review_flag carries id and reason for a review_needed flag', async () => {
    const db = getDb();
    const flagId = db.prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, ?, 'review_needed', 'Check the citations')`
    ).run(studentId, assignmentInternalId).lastInsertRowid;

    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].review_flag).toEqual({
      id: flagId,
      flag_reason: 'Check the citations',
    });
  });

  test('a non-review flag on the same submission is ignored', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, ?, 'custom', 'something else')`
    ).run(studentId, assignmentInternalId);

    const { body } = await get(`/api/mastery/${courseId}/assignment/sa-1`);
    expect(body.students[0].review_flag).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/routes/mastery.test.js`
Expected: FAIL — `body.students[0].review_flag` is `undefined`, not `null` / the expected object.

- [ ] **Step 3: Write the implementation**

In `server/routes/mastery.js`, in the `GET /:courseId/assignment/:assignmentId` handler, find the `res.json({` call near the end of the handler. Insert this block immediately **before** it:

```js
  // Submission-scoped 'review needed' flags for this assignment (#20).
  // Prism-local; keyed by internal student_id. assignmentRow is undefined for
  // an unknown assignment id — no flags can exist in that case.
  const reviewFlagRows = assignmentRow
    ? db.prepare(`
        SELECT id, student_id, flag_reason FROM flags
        WHERE assignment_id = ? AND flag_type = 'review_needed'
      `).all(assignmentRow.id)
    : [];
  const reviewFlagMap = {};
  for (const r of reviewFlagRows) {
    reviewFlagMap[r.student_id] = { id: r.id, flag_reason: r.flag_reason };
  }

  res.json({
```

Then, in the `students.map(s => ({ ... }))` inside that same `res.json` call, add a `review_flag` line after `has_grade_row`:

```js
      comment_status: commentStatusMap[s.schoology_uid] ?? null,
      has_grade_row: hasGradeRowMap[s.schoology_uid] === true,
      review_flag: reviewFlagMap[s.id] || null,
    })),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/routes/mastery.test.js`
Expected: PASS — all three new tests plus the existing login-status tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/mastery.js server/routes/mastery.test.js
git commit -m "$(cat <<'EOF'
feat(#20): surface submission review flags on the assessment endpoint

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Review-flag control on the assessment-page rubric card

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx`
- Test: `client/src/pages/AssessmentSummaryPage.test.jsx`

- [ ] **Step 1: Write the failing test**

In `client/src/pages/AssessmentSummaryPage.test.jsx`, replace the `vi.mock('../services/api.js', ...)` block (lines 7-12) with one that also mocks the flag helpers:

```js
vi.mock('../services/api.js', () => ({
  getMasteryForAssignment: vi.fn(),
  syncMasteryForAssignment: vi.fn(),
  writeMasteryScores: vi.fn().mockResolvedValue({}),
  writeMasteryComment: vi.fn().mockResolvedValue({}),
  createFlag: vi.fn().mockResolvedValue({ id: 99, flag_reason: 'Check citations' }),
  deleteFlag: vi.fn().mockResolvedValue({ success: true }),
}));
```

Add an import of the mocked helpers below the existing imports at the top of the file:

```js
import { createFlag, deleteFlag, writeMasteryScores, writeMasteryComment } from '../services/api.js';
```

Replace the `renderCard` helper so it accepts a `student` override and gives `assignmentRow` an `id`:

```js
function renderCard(extraProps = {}) {
  const { student, ...rest } = extraProps;
  return render(
    <MemoryRouter>
      <StudentRubricCard
        student={student || makeStudent()}
        topics={TOPICS}
        courseId="4"
        assignmentId="8"
        assignmentRow={{ id: 50, mastery_grading_period_id: 1, mastery_grading_category_id: 2 }}
        onSaved={() => {}}
        {...rest}
      />
    </MemoryRouter>
  );
}
```

Append this `describe` block to the end of the file:

```js
describe('StudentRubricCard review flag (#20)', () => {
  it('shows a "Flag for review" button when there is no review flag', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /flag for review/i })).toBeInTheDocument();
  });

  it('creates a submission-scoped review_needed flag with a reason', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.change(screen.getByPlaceholderText('Reason for review...'), {
      target: { value: 'Check citations' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));

    await waitFor(() => {
      expect(createFlag).toHaveBeenCalledWith({
        student_id: 1,
        assignment_id: 50,
        flag_type: 'review_needed',
        flag_reason: 'Check citations',
      });
    });
    expect(await screen.findByText(/Review: Check citations/)).toBeInTheDocument();
  });

  it('shows the review badge and a Clear control when a flag exists', () => {
    renderCard({ student: { ...makeStudent(), review_flag: { id: 7, flag_reason: 'Re-mark' } } });
    expect(screen.getByText(/Review: Re-mark/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear review flag/i })).toBeInTheDocument();
  });

  it('clears the review flag via deleteFlag', async () => {
    renderCard({ student: { ...makeStudent(), review_flag: { id: 7, flag_reason: 'Re-mark' } } });
    fireEvent.click(screen.getByRole('button', { name: /clear review flag/i }));
    await waitFor(() => expect(deleteFlag).toHaveBeenCalledWith(7));
  });

  it('flagging for review does not trigger a Schoology write', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /flag for review/i }));
    fireEvent.change(screen.getByPlaceholderText('Reason for review...'), {
      target: { value: 'Check citations' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    await waitFor(() => expect(createFlag).toHaveBeenCalled());
    expect(writeMasteryScores).not.toHaveBeenCalled();
    expect(writeMasteryComment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npm test -- --run src/pages/AssessmentSummaryPage.test.jsx`
Expected: FAIL — no "Flag for review" button is rendered.

- [ ] **Step 3: Write the implementation**

In `client/src/pages/AssessmentSummaryPage.jsx`, update the api import on line 3 to add the flag helpers:

```js
import { getMasteryForAssignment, syncMasteryForAssignment, writeMasteryScores, writeMasteryComment, createFlag, deleteFlag } from '../services/api.js';
```

In `StudentRubricCard`, add review-flag state immediately after `const [saveResult, setSaveResult] = useState(null);`:

```js
  const [saveResult, setSaveResult] = useState(null);

  // Review flag (#20) — Prism-local, submission-scoped. Written via /api/flags,
  // entirely independent of the Schoology grade/comment write below.
  const [reviewFlag, setReviewFlag] = useState(student.review_flag || null);
  const [showFlagInput, setShowFlagInput] = useState(false);
  const [flagReason, setFlagReason] = useState('');
  const [flagBusy, setFlagBusy] = useState(false);
```

Add the two handlers immediately after `handleSave`'s closing `}` (just before `return (`):

```js
  async function handleFlagForReview() {
    const reason = flagReason.trim();
    if (!reason || !assignmentRow?.id) return;
    setFlagBusy(true);
    try {
      const flag = await createFlag({
        student_id: student.id,
        assignment_id: assignmentRow.id,
        flag_type: 'review_needed',
        flag_reason: reason,
      });
      setReviewFlag({ id: flag.id, flag_reason: flag.flag_reason });
      setShowFlagInput(false);
      setFlagReason('');
    } finally {
      setFlagBusy(false);
    }
  }

  async function handleClearReviewFlag() {
    if (!reviewFlag) return;
    setFlagBusy(true);
    try {
      await deleteFlag(reviewFlag.id);
      setReviewFlag(null);
    } finally {
      setFlagBusy(false);
    }
  }

  return (
```

Add the header badge — find the `{saveResult?.startsWith('error') && (` block in the student header and insert the review badge after it, before `{isRubricLocked && (`:

```js
        {saveResult?.startsWith('error') && (
          <span className="badge badge-red" style={{ fontSize: '0.68rem' }}>{saveResult}</span>
        )}
        {reviewFlag && (
          <span className="badge" style={{ background: '#fef3c7', color: '#92400e', fontSize: '0.68rem' }}>
            ⚑ Review: {reviewFlag.flag_reason}
          </span>
        )}
        {isRubricLocked && (
```

Add the in-row control — find the end of the comment/button section (the `</label>` closing the Display-to-student toggle, followed by the button-row `</div>` and the comment-section `</div>`) and insert the review-flag row between those two `</div>`s:

```js
            </span>
          </label>
        </div>
        {/* Review flag (#20) — Prism-local; never part of a Schoology save */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
          {reviewFlag ? (
            <button className="ghost danger" onClick={handleClearReviewFlag} disabled={flagBusy}>
              Clear review flag
            </button>
          ) : showFlagInput ? (
            <>
              <input
                type="text"
                value={flagReason}
                onChange={e => setFlagReason(e.target.value)}
                placeholder="Reason for review..."
                style={{ flex: 1, fontSize: '0.8rem' }}
                autoFocus
              />
              <button
                className="primary"
                onClick={handleFlagForReview}
                disabled={flagBusy || !flagReason.trim()}
              >
                Flag
              </button>
              <button className="ghost" onClick={() => { setShowFlagInput(false); setFlagReason(''); }}>
                Cancel
              </button>
            </>
          ) : (
            <button className="ghost accent" onClick={() => setShowFlagInput(true)}>
              ⚑ Flag for review
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npm test -- --run src/pages/AssessmentSummaryPage.test.jsx`
Expected: PASS — the five new tests plus the existing draft-persistence tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx client/src/pages/AssessmentSummaryPage.test.jsx
git commit -m "$(cat <<'EOF'
feat(#20): flag-for-review control on the assessment rubric card

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Remove FlagsCard, active-flags banner, and StudentAnalytics usage from the student profile

**Files:**
- Modify: `client/src/pages/StudentPage.jsx`
- Test: `client/src/pages/StudentPage.test.jsx`

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `client/src/pages/StudentPage.test.jsx` with:

```js
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CourseSection } from './StudentPage.jsx';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));

function renderCourseSection(flagsByAssignment) {
  return render(
    <MemoryRouter>
      <CourseSection
        course={{ id: 1, course_name: 'AIML' }}
        grades={[{
          course_id: 1,
          assignment_id: 10,
          schoology_assignment_id: 'sa-10',
          assignment_title: 'Computer Vision Project',
          due_date: '2026-04-12',
          score: 80,
          assignment_max_points: 100,
          exception: 0,
          late: 0,
          draft: 0,
          submitted_at: 1,
          grading_scale_id: null,
          mastery: null,
        }]}
        flagsByAssignment={flagsByAssignment}
        studentUid="uid-1"
        scales={[]}
      />
    </MemoryRouter>
  );
}

describe('CourseSection review flag badge', () => {
  it('renders a review_needed flag as a badge on the assignment row', () => {
    renderCourseSection({
      10: [{ id: 5, flag_type: 'review_needed', flag_reason: 'Check citations', assignment_id: 10, resolved: 0 }],
    });
    expect(screen.getByText('review needed')).toBeInTheDocument();
    expect(screen.getByText('Check citations')).toBeInTheDocument();
  });

  it('renders no review badge when the assignment has no flags', () => {
    renderCourseSection({});
    expect(screen.queryByText('review needed')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npm test -- --run src/pages/StudentPage.test.jsx`
Expected: FAIL — `CourseSection` is not an exported member of `StudentPage.jsx`.

- [ ] **Step 3: Export `CourseSection`**

In `client/src/pages/StudentPage.jsx`, change the `CourseSection` declaration:

```js
function CourseSection({ course, grades, flagsByAssignment, studentUid, scales }) {
```

to:

```js
export function CourseSection({ course, grades, flagsByAssignment, studentUid, scales }) {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npm test -- --run src/pages/StudentPage.test.jsx`
Expected: PASS — both `CourseSection` tests pass.

- [ ] **Step 5: Remove the FlagsCard component and the dead UI**

Make all of the following edits in `client/src/pages/StudentPage.jsx`:

**(a)** Update the imports at the top — remove the flag helpers and the `StudentAnalytics` import:

```js
import {
  getStudent, updateStudent, updateParentPhone,
  createNote, updateNote, deleteNote,
  createFlag, resolveFlag, reopenFlag, deleteFlag,
} from '../services/api.js';
import StudentAnalytics from '../components/StudentAnalytics.jsx';
```

becomes:

```js
import {
  getStudent, updateStudent, updateParentPhone,
  createNote, updateNote, deleteNote,
} from '../services/api.js';
```

**(b)** Delete the entire `FlagsCard` component — from its leading comment line `// Flags list + creation form. All flags are user-managed:` through the closing `}` of `export function FlagsCard(...)`, immediately above `export default function StudentPage()`.

**(c)** Delete the `CollapsibleCard` component — the whole `function CollapsibleCard({ title, count, defaultOpen = false, children }) { ... }` declaration through its closing `}`. It is used only by the Flags card removed in step (e) and has no other callers.

**(d)** Delete the four flag handlers:

```js
  async function handleAddFlag(flagType, flagReason) {
    if (!flagReason?.trim()) return;
    await createFlag({ student_id: parseInt(id), flag_type: flagType, flag_reason: flagReason });
    reload();
  }

  async function handleResolveFlag(flagId) { await resolveFlag(flagId); reload(); }
  async function handleReopenFlag(flagId) { await reopenFlag(flagId); reload(); }
  async function handleDeleteFlag(flagId) { await deleteFlag(flagId); reload(); }
```

**(e)** Replace the `assignmentLookup` / `assignmentFlagMap` / `activeFlags` block:

```js
  const assignmentFlagMap = {};
  const assignmentLookup = {};
  for (const g of student.grades) {
    if (!assignmentLookup[g.assignment_id]) {
      assignmentLookup[g.assignment_id] = { title: g.assignment_title, courseName: g.course_name };
    }
  }
  for (const f of student.flags) {
    if (!f.assignment_id || f.resolved) continue;
    if (!assignmentFlagMap[f.assignment_id]) assignmentFlagMap[f.assignment_id] = [];
    assignmentFlagMap[f.assignment_id].push(f);
  }
  const activeFlags = student.flags.filter(f => !f.resolved && !f.assignment_id);
```

with just the `assignmentFlagMap` build:

```js
  const assignmentFlagMap = {};
  for (const f of student.flags) {
    if (!f.assignment_id || f.resolved) continue;
    if (!assignmentFlagMap[f.assignment_id]) assignmentFlagMap[f.assignment_id] = [];
    assignmentFlagMap[f.assignment_id].push(f);
  }
```

**(f)** Delete the active-flags banner:

```js
      {/* Active flags banner */}
      {activeFlags.length > 0 && (
        <div className="alert alert-warning">
          <strong style={{ color: '#92400e' }}>Active flags ({activeFlags.length})</strong>
          {activeFlags.map(f => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.4rem' }}>
              <span className="badge badge-red" style={{ textTransform: 'capitalize' }}>{f.flag_type.replace('_', ' ')}</span>
              <span className="text-sm">{formatFlagReason(f) || f.flag_reason || '—'}</span>
              <button onClick={() => handleResolveFlag(f.id)} className="ghost accent" style={{ marginLeft: 'auto' }}>Resolve</button>
            </div>
          ))}
        </div>
      )}
```

**(g)** Delete the Flags collapsible card:

```js
      {/* Flags — collapsible, collapsed by default */}
      <CollapsibleCard title="Flags" count={student.flags.length} defaultOpen={false}>
        <FlagsCard
          flags={student.flags}
          assignmentLookup={assignmentLookup}
          onAddFlag={handleAddFlag}
          onResolveFlag={handleResolveFlag}
          onReopenFlag={handleReopenFlag}
          onDeleteFlag={handleDeleteFlag}
        />
      </CollapsibleCard>
```

**(h)** Delete the `StudentAnalytics` usage:

```js
      {/* Summary analytics (cross-course comparison + performance alerts) */}
      <StudentAnalytics studentId={parseInt(id)} />
```

Leave `formatFlagReason` (still used by `CourseSection`) and the `assignmentFlagMap` → `flagsByAssignment` wiring intact.

- [ ] **Step 6: Verify the full client suite still passes**

Run: `cd client && npm test -- --run`
Expected: PASS — no test imports the removed `FlagsCard`; nothing references `StudentAnalytics`, `CollapsibleCard`, or the flag handlers. (`StudentAnalytics.jsx` still exists on disk but is now unused — deleted in Task 5.)

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/StudentPage.jsx client/src/pages/StudentPage.test.jsx
git commit -m "$(cat <<'EOF'
feat(#19): remove FlagsCard, active-flags banner, and analytics from profile

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Delete StudentAnalytics and its now-dead backend

**Files:**
- Delete: `client/src/components/StudentAnalytics.jsx`
- Modify: `client/src/services/api.js`
- Modify: `server/routes/analytics.js`

- [ ] **Step 1: Delete the component file**

```bash
git rm client/src/components/StudentAnalytics.jsx
```

- [ ] **Step 2: Remove the `getStudentAnalytics` API helper**

In `client/src/services/api.js`, delete this line:

```js
export const getStudentAnalytics = (id, threshold) => request(`/analytics/student/${id}?threshold=${threshold || 15}`);
```

- [ ] **Step 3: Remove the unused analytics route**

In `server/routes/analytics.js`, delete the entire `GET /student/:id` handler — from the comment line `// GET /api/analytics/student/:id — individual student analytics` through the closing `});` on the line immediately after `res.json({ trends, crossCourse, alerts, threshold });`.

Leave the `percentile` and `round` helper functions below it in place — they are still used by the other analytics routes in this file.

- [ ] **Step 4: Verify both suites pass**

Run: `cd client && npm test -- --run`
Expected: PASS — no module imports `StudentAnalytics` or `getStudentAnalytics`.

Run: `npm run test:server`
Expected: PASS — the analytics file still parses; no test referenced the removed route.

- [ ] **Step 5: Verify the client build still compiles**

Run: `cd client && npm run build`
Expected: build succeeds with no unresolved-import errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/services/api.js server/routes/analytics.js
git commit -m "$(cat <<'EOF'
feat(#19): delete StudentAnalytics component and its dead endpoint

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Final Verification

- [ ] **Run the full server suite**

Run: `npm run test:server`
Expected: PASS

- [ ] **Run the full client suite**

Run: `cd client && npm test -- --run`
Expected: PASS

- [ ] **Build the client**

Run: `cd client && npm run build`
Expected: build succeeds

- [ ] **Manual smoke check** (optional, requires `npm run dev` + a logged-in mastery session)
  - Open an assessment page (`/course/<id>/assessment/<aid>`): each rubric card shows a "⚑ Flag for review" button; flagging with a reason shows the amber `⚑ Review: …` badge in the card header; "Clear review flag" removes it.
  - Open that student's profile: the flagged assignment row shows a "review needed" badge with the reason; there is no Flags card, no active-flags banner, and no Performance Alerts / Cross-Course Comparison section.
