# Rubric Modal Submission Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface submission-status and Prism-local flag badges on the gradebook mini-rubric modal (`RubricModal`), matching how the `/student/` page renders them (#57).

**Architecture:** Extract the badge rendering from `StudentPage` into a shared `<SubmissionBadges>` component used by both pages. Add `review_needed` flags to the gradebook API payload. Thread the grade object into `RubricModal` and render the badges as a band above the rubric grid.

**Tech Stack:** React (Vite), Express, better-sqlite3, Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-05-22-rubric-modal-submission-badges-design.md`

**Conventions:** Work on `main`. Commit style `feat(#57):` / `test(#57):` / `refactor(#57):` with a `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` trailer. CSS custom properties only; existing `badge`/`badge-*` classes.

**Pre-existing failure (not in scope):** `client/src/components/SyncConfig.test.jsx` fails on `main` independently — ignore it.

---

## File Structure

- **Create** `client/src/components/SubmissionBadges.jsx` — shared badge renderer (status badges + flags + resubmitted). Returns a Fragment of `<span>` badges (no wrapper) so callers compose it into their own flex row; returns `null` when empty.
- **Create** `client/src/components/SubmissionBadges.test.jsx` — unit tests for the component.
- **Modify** `server/routes/courses.js` — add `review_needed` flags to the gradebook payload.
- **Modify** `server/routes/courses.test.js` — test the new `review_needed` payload field.
- **Modify** `client/src/pages/StudentPage.jsx` — adopt `<SubmissionBadges>`, drop the now-duplicated helpers.
- **Modify** `client/src/pages/CoursePage.jsx` — thread the grade into `RubricModal`, render the badge band.

---

## Task 1: Server — `review_needed` flags in the gradebook payload

**Files:**
- Modify: `server/routes/courses.js:186-202`
- Test: `server/routes/courses.test.js`

- [ ] **Step 1: Write the failing test**

In `server/routes/courses.test.js`, insert this new `describe` block immediately after the `resubmitted` describe block closes (after the `});` on line 93, before the `describe('GET /api/courses/:id/gradebook — individually assigned (#54)'` block):

```javascript
describe('GET /api/courses/:id/gradebook — review_needed', () => {
  test('cell review_needed is an empty array with no flag', async () => {
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].review_needed).toEqual([]);
  });

  test('an unresolved review_needed flag surfaces with its id and reason', async () => {
    getDb().prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason)
       VALUES (?, ?, 'review_needed', 'rescore Q3')`
    ).run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    const reviews = body.grades[studentId][assignmentId].review_needed;
    expect(reviews).toHaveLength(1);
    expect(reviews[0].flag_reason).toBe('rescore Q3');
    expect(typeof reviews[0].id).toBe('number');
  });

  test('a resolved review_needed flag is excluded', async () => {
    getDb().prepare(
      `INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason, resolved)
       VALUES (?, ?, 'review_needed', 'old note', 1)`
    ).run(studentId, assignmentId);
    const { body } = await get(`/api/courses/${courseId}/gradebook`);
    expect(body.grades[studentId][assignmentId].review_needed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/routes/courses.test.js`
Expected: FAIL — the new tests fail because `review_needed` is `undefined` on the grade object (`expected undefined to deeply equal []`).

- [ ] **Step 3: Implement the payload change**

In `server/routes/courses.js`, replace this block (lines ~193-202):

```javascript
  const resubmitSet = new Set(resubmitFlags.map(f => `${f.student_id}:${f.assignment_id}`));

  // Index grades by student_id -> assignment_id
  const gradeMap = {};
  for (const g of grades) {
    if (!gradeMap[g.student_id]) gradeMap[g.student_id] = {};
    g.resubmit_requested = resubmitSet.has(`${g.student_id}:${g.assignment_id}`);
    g.resubmitted = isResubmitted(g);
    gradeMap[g.student_id][g.assignment_id] = g;
  }
```

with:

```javascript
  const resubmitSet = new Set(resubmitFlags.map(f => `${f.student_id}:${f.assignment_id}`));

  // Unresolved 'review needed' flags (#57). Prism-local — surfaced on the
  // gradebook rubric modal alongside submission status.
  const reviewFlags = db.prepare(`
    SELECT f.id, f.student_id, f.assignment_id, f.flag_reason
    FROM flags f
    JOIN assignments a ON a.id = f.assignment_id
    WHERE a.course_id = ? AND f.flag_type = 'review_needed' AND f.resolved = 0
  `).all(req.params.id);
  const reviewByKey = {};
  for (const f of reviewFlags) {
    const key = `${f.student_id}:${f.assignment_id}`;
    if (!reviewByKey[key]) reviewByKey[key] = [];
    reviewByKey[key].push({ id: f.id, flag_reason: f.flag_reason });
  }

  // Index grades by student_id -> assignment_id
  const gradeMap = {};
  for (const g of grades) {
    if (!gradeMap[g.student_id]) gradeMap[g.student_id] = {};
    g.resubmit_requested = resubmitSet.has(`${g.student_id}:${g.assignment_id}`);
    g.resubmitted = isResubmitted(g);
    g.review_needed = reviewByKey[`${g.student_id}:${g.assignment_id}`] || [];
    gradeMap[g.student_id][g.assignment_id] = g;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/routes/courses.test.js`
Expected: PASS — all `review_needed`, `resubmit_requested`, `resubmitted`, and `#54` tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/courses.js server/routes/courses.test.js
git commit -m "$(cat <<'EOF'
feat(#57): add review_needed flags to the gradebook payload

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Shared `<SubmissionBadges>` component

**Files:**
- Create: `client/src/components/SubmissionBadges.jsx`
- Test: `client/src/components/SubmissionBadges.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `client/src/components/SubmissionBadges.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SubmissionBadges from './SubmissionBadges.jsx';

describe('SubmissionBadges', () => {
  it('renders a status badge with the mapped tone class', () => {
    render(<SubmissionBadges status={[{ kind: 'missing', label: 'Missing', tone: 'red' }]} />);
    expect(screen.getByText('Missing')).toHaveClass('badge', 'badge-red');
  });

  it('maps the amber tone to badge-pink', () => {
    render(<SubmissionBadges status={[{ kind: 'not-started', label: 'Not Started', tone: 'amber' }]} />);
    expect(screen.getByText('Not Started')).toHaveClass('badge', 'badge-pink');
  });

  it('renders a review_needed flag as "⚑ Review: <reason>"', () => {
    render(
      <SubmissionBadges
        status={[]}
        flags={[{ id: 1, flag_type: 'review_needed', flag_reason: 'rescore Q3' }]}
      />
    );
    expect(screen.getByText(/⚑ Review: rescore Q3/)).toHaveClass('badge', 'badge-amber');
  });

  it('renders the resubmit_requested and resubmitted badges', () => {
    render(
      <SubmissionBadges
        status={[]}
        flags={[{ id: 'resubmit', flag_type: 'resubmit_requested' }]}
        resubmitted
      />
    );
    expect(screen.getByText(/⟳ Re-submit requested/)).toHaveClass('badge', 'badge-resubmit');
    expect(screen.getByText(/↩ Resubmitted/)).toHaveClass('badge', 'badge-resubmitted');
  });

  it('renders nothing when there are no badges, flags, or resubmission', () => {
    const { container } = render(<SubmissionBadges status={[]} flags={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd client && npx vitest run src/components/SubmissionBadges.test.jsx`
Expected: FAIL — module `./SubmissionBadges.jsx` cannot be resolved.

- [ ] **Step 3: Create the component**

Create `client/src/components/SubmissionBadges.jsx`:

```jsx
// Shared submission-state + flag badges. Renders a flat run of <span> badges
// (a Fragment, no wrapper element) so callers can drop it straight into their
// own flex row. Used by the /student/ course table (StudentPage) and the
// gradebook rubric modal (CoursePage). Returns null when there is nothing to
// show, so a conditionally-rendered band collapses cleanly.
//
// Props:
//   status         — array from submissionStatus(): [{ kind, label, tone }]
//   flags          — array of flag objects; renders review_needed,
//                    resubmit_requested, and any other flag_type generically
//   resubmitted    — boolean → "↩ Resubmitted" badge
//   assignmentTitle — optional; the generic-flag branch suppresses a reason
//                    that merely repeats the assignment title

const TONE_CLASS = { red: 'badge-red', blue: 'badge-blue', amber: 'badge-pink', neutral: 'badge-gray' };

function formatFlagReason(flag) {
  return flag?.flag_reason || '';
}

export default function SubmissionBadges({ status = [], flags = [], resubmitted = false, assignmentTitle }) {
  if (status.length === 0 && flags.length === 0 && !resubmitted) return null;
  return (
    <>
      {status.map(b => (
        <span key={b.kind} className={`badge ${TONE_CLASS[b.tone]}`} style={{ fontSize: '0.65rem' }}>{b.label}</span>
      ))}
      {flags.map(flag => {
        const flagReason = formatFlagReason(flag);
        // Review flags use the same amber badge + "⚑ Review: …" format as the
        // assessment page.
        if (flag.flag_type === 'review_needed') {
          return (
            <span key={flag.id} className="badge badge-amber" style={{ fontSize: '0.68rem' }}>
              ⚑ Review: {flagReason}
            </span>
          );
        }
        if (flag.flag_type === 'resubmit_requested') {
          return (
            <span key={flag.id} className="badge badge-resubmit" style={{ fontSize: '0.68rem' }}>
              ⟳ Re-submit requested
            </span>
          );
        }
        const showReason = flagReason && flagReason !== assignmentTitle;
        return (
          <span key={flag.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
            <span className={`badge ${flag.resolved ? 'badge-green' : 'badge-red'}`} style={{ textTransform: 'capitalize' }}>
              {flag.flag_type.replace('_', ' ')}
            </span>
            {showReason && <span className="text-xs text-muted">{flagReason}</span>}
          </span>
        );
      })}
      {resubmitted && (
        <span className="badge badge-resubmitted" style={{ fontSize: '0.68rem' }}
              title="The student has submitted new work since this was last graded">
          ↩ Resubmitted
        </span>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd client && npx vitest run src/components/SubmissionBadges.test.jsx`
Expected: PASS — all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/SubmissionBadges.jsx client/src/components/SubmissionBadges.test.jsx
git commit -m "$(cat <<'EOF'
feat(#57): add shared SubmissionBadges component

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: StudentPage adopts `<SubmissionBadges>`

Pure refactor — `StudentPage`'s `CourseSection` swaps its inline badge JSX for the
shared component. The component renders byte-identical markup to the code being
removed, so there is **no visual change** to `/student/`. No new test: the badge
rendering is covered by Task 2; correctness here is verified by the production build.

**Files:**
- Modify: `client/src/pages/StudentPage.jsx` (import line 8; helper lines 13-15; `TONE_CLASS` line 49; badge block lines 140-179)

- [ ] **Step 1: Add the import**

In `client/src/pages/StudentPage.jsx`, after the existing `CompactRubric` import (line 8):

```jsx
import CompactRubric from '../components/CompactRubric.jsx';
```

add:

```jsx
import SubmissionBadges from '../components/SubmissionBadges.jsx';
```

- [ ] **Step 2: Replace the badge block**

Replace this block (`StudentPage.jsx` lines ~139-179):

```jsx
                    {/* Due + flags row */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
                      <span className="text-xs text-muted">Due: {g.due_date || '—'}</span>
                      {statusBadges.map(b => (
                        <span key={b.kind} className={`badge ${TONE_CLASS[b.tone]}`} style={{ fontSize: '0.65rem' }}>{b.label}</span>
                      ))}
                      {assignmentFlags.map(flag => {
                        const flagReason = formatFlagReason(flag);
                        // Review flags use the same amber badge + "⚑ Review: …"
                        // format as the assessment page.
                        if (flag.flag_type === 'review_needed') {
                          return (
                            <span key={flag.id} className="badge badge-amber" style={{ fontSize: '0.68rem' }}>
                              ⚑ Review: {flagReason}
                            </span>
                          );
                        }
                        if (flag.flag_type === 'resubmit_requested') {
                          return (
                            <span key={flag.id} className="badge badge-resubmit" style={{ fontSize: '0.68rem' }}>
                              ⟳ Re-submit requested
                            </span>
                          );
                        }
                        const showReason = flagReason && flagReason !== g.assignment_title;
                        return (
                          <span key={flag.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                            <span className={`badge ${flag.resolved ? 'badge-green' : 'badge-red'}`} style={{ textTransform: 'capitalize' }}>
                              {flag.flag_type.replace('_', ' ')}
                            </span>
                            {showReason && <span className="text-xs text-muted">{flagReason}</span>}
                          </span>
                        );
                      })}
                      {g.resubmitted && (
                        <span className="badge badge-resubmitted" style={{ fontSize: '0.68rem' }}
                              title="The student has submitted new work since this was last graded">
                          ↩ Resubmitted
                        </span>
                      )}
                    </div>
```

with:

```jsx
                    {/* Due + flags row */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
                      <span className="text-xs text-muted">Due: {g.due_date || '—'}</span>
                      <SubmissionBadges
                        status={statusBadges}
                        flags={assignmentFlags}
                        resubmitted={g.resubmitted}
                        assignmentTitle={g.assignment_title}
                      />
                    </div>
```

- [ ] **Step 3: Delete the now-unused helpers**

`formatFlagReason` and `TONE_CLASS` now live in `SubmissionBadges.jsx` and have no
other consumers in `StudentPage.jsx` (verified: `formatFlagReason` was used only
in the block removed above; `TONE_CLASS` only on the removed `statusBadges.map`).

Delete the `formatFlagReason` function (`StudentPage.jsx` lines ~13-15):

```jsx
function formatFlagReason(flag) {
  return flag?.flag_reason || '';
}
```

Delete the `TONE_CLASS` constant (`StudentPage.jsx` line ~49):

```jsx
const TONE_CLASS = { red: 'badge-red', blue: 'badge-blue', amber: 'badge-pink', neutral: 'badge-gray' };
```

Leave the adjacent `EXCEPTION_LABELS` constant untouched.

- [ ] **Step 4: Verify the build**

Run: `cd client && npx vite build`
Expected: build succeeds with no errors (in particular, no "unused variable" or "not defined" errors for `formatFlagReason` / `TONE_CLASS`).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/StudentPage.jsx
git commit -m "$(cat <<'EOF'
refactor(#57): render StudentPage badges via SubmissionBadges

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: CoursePage — render the badge band in `RubricModal`

Threads the grade object into `RubricModal` and renders `<SubmissionBadges>` as a
band between the modal header and the rubric grid. No new automated test — the
component is covered by Task 2 and the wiring is verified by the build plus a
manual check (the spec scopes automated tests to Tasks 1 and 2).

**Files:**
- Modify: `client/src/pages/CoursePage.jsx` (import line 11; `RubricModal` ~460-520; `setRubricModal` call ~838-841; `<RubricModal>` render ~911-917)

- [ ] **Step 1: Add the import**

In `client/src/pages/CoursePage.jsx`, after the `CompactRubric` import (line 11):

```jsx
import CompactRubric from '../components/CompactRubric.jsx';
```

add:

```jsx
import SubmissionBadges from '../components/SubmissionBadges.jsx';
```

- [ ] **Step 2: Add the `grade` prop and compute the badge data in `RubricModal`**

Replace this block (`CoursePage.jsx` lines ~460-462):

```jsx
function RubricModal({ student, assignment, courseId, topics, comment, onClose }) {
  const name = student.preferred_name_teacher || student.preferred_name || student.first_name;
  return (
```

with:

```jsx
function RubricModal({ student, assignment, courseId, topics, comment, grade, onClose }) {
  const name = student.preferred_name_teacher || student.preferred_name || student.first_name;
  // Submission state + flags, shown above the rubric — matching the /student/ page.
  const status = submissionStatus({
    score: grade.score, exception: grade.exception, late: grade.late,
    draft: grade.draft, submitted_at: grade.submitted_at, due_date: assignment.due_date,
  });
  const flags = [
    ...(grade.review_needed || []).map(f => ({ ...f, flag_type: 'review_needed' })),
    ...(grade.resubmit_requested ? [{ id: 'resubmit', flag_type: 'resubmit_requested' }] : []),
  ];
  const hasBadges = status.length > 0 || flags.length > 0 || grade.resubmitted;
  return (
```

- [ ] **Step 3: Render the badge band above the rubric**

Replace this block (`CoursePage.jsx` lines ~493-494):

```jsx
        <div style={{ padding: '1rem 1.1rem' }}>
          <CompactRubric topics={topics} />
```

with:

```jsx
        <div style={{ padding: '1rem 1.1rem' }}>
          {hasBadges && (
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center',
              marginBottom: '0.85rem',
            }}>
              <SubmissionBadges status={status} flags={flags} resubmitted={grade.resubmitted} />
            </div>
          )}
          <CompactRubric topics={topics} />
```

- [ ] **Step 4: Pass the grade into `setRubricModal`**

Replace this block (`CoursePage.jsx` lines ~838-841):

```jsx
                      onClick={() => setRubricModal({
                        student: s, assignment: a, topics: rubricTopics,
                        comment: g.grade_comment || '',
                      })}
```

with:

```jsx
                      onClick={() => setRubricModal({
                        student: s, assignment: a, topics: rubricTopics,
                        comment: g.grade_comment || '', grade: g,
                      })}
```

- [ ] **Step 5: Pass the grade into the `<RubricModal>` render**

Replace this block (`CoursePage.jsx` lines ~911-918):

```jsx
      <RubricModal
        student={rubricModal.student}
        assignment={rubricModal.assignment}
        courseId={courseId}
        topics={rubricModal.topics}
        comment={rubricModal.comment}
        onClose={() => setRubricModal(null)}
      />
```

with:

```jsx
      <RubricModal
        student={rubricModal.student}
        assignment={rubricModal.assignment}
        courseId={courseId}
        topics={rubricModal.topics}
        comment={rubricModal.comment}
        grade={rubricModal.grade}
        onClose={() => setRubricModal(null)}
      />
```

- [ ] **Step 6: Verify the build and full test suites**

Run: `cd client && npx vite build`
Expected: build succeeds with no errors.

Run: `npx vitest run server/`
Expected: PASS — `courses.test.js` (incl. the new `review_needed` block) passes; no regressions.

Run: `cd client && npx vitest run src/components/SubmissionBadges.test.jsx`
Expected: PASS — all 5 component tests pass.

- [ ] **Step 7: Manual verification**

Run `npm run dev` (if ports are busy: `lsof -ti:3001 | xargs kill -9; lsof -ti:5173 | xargs kill -9` first). Open `/course/3` (ACSS — has aligned summatives and flags), click a rubric cell to open the modal, and confirm:
- a badge band appears between the assignment title and the rubric grid;
- submission-status badges (e.g. Late, Submitted) render where applicable;
- a `review_needed` flag renders as an amber `⚑ Review: …` badge;
- an already-graded summative with no flags shows no band (no empty gap above the rubric).

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/CoursePage.jsx
git commit -m "$(cat <<'EOF'
feat(#57): show submission status + flags on the rubric modal

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Done

All four tasks committed. Issue #57 is satisfied: the gradebook rubric modal now
shows submission-status badges and `review_needed` / `resubmit_requested` /
`resubmitted` flags via the shared `<SubmissionBadges>` component, with `/student/`
refactored onto the same component and unchanged visually.
