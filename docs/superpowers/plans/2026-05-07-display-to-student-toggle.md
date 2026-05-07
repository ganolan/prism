# Display-to-student toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-student "Display to student" slide toggle to the assessment page that controls Schoology's `comment_status` flag for that (student, assignment) row.

**Architecture:** A presentation layer over the existing `grades.comment_status` column. The toggle reads its initial state from local DB (already populated by the regular grades sync and by the assessment-page Refresh wired up in #46), is treated as a pending-change like rubric scores and comment text, and on save is sent to the existing `/api/mastery/:courseId/write-comment` route which is extended to forward the value into the public-API PUT to Schoology.

**Tech Stack:** React (client), Express + better-sqlite3 (server), Schoology public OAuth API for the write.

**Reference:** [Spec](../specs/2026-05-07-display-to-student-toggle-design.md). [Issue #34](https://github.com/ganolan/prism/issues/34).

**Note on testing:** This repo has no automated test framework — verification is manual through the browser plus `node --check` for server syntax and `npm run build` for client type/build checks. Each task ends with the smallest concrete verification that proves the change works.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `server/routes/mastery.js` | modify | Accept `commentStatus` on `/write-comment`; pass to PUT payload; persist to local `grades.comment_status`. Surface `comment_status` + `has_grade_row` in the assessment GET response. |
| `client/src/services/api.js` | modify | Forward `commentStatus` from `writeMasteryComment` caller to the request body. |
| `client/src/pages/AssessmentSummaryPage.jsx` | modify | Render the toggle, manage its state (loaded value, pending value, auto-flip arming), include it in `hasPendingChanges`, pass to save. |

No new files. No schema changes — the `grades.comment_status` column already exists.

---

## Task 1: Surface `comment_status` and `has_grade_row` in the assessment GET response

The page-load handler currently selects `grade_comment` and `exception` from the grades table but ignores `comment_status`. It also doesn't tell the client whether a grades row exists at all (needed to arm auto-flip for virgin records).

**Files:**
- Modify: `server/routes/mastery.js:360-394`

- [ ] **Step 1: Update the SQL select to include `comment_status` and broaden the maps**

Replace the block at `server/routes/mastery.js:360-377` (the comment/exception select + map population) with a version that also pulls `comment_status` and tracks which students have a grades row:

```javascript
  // Grade comments + exception + comment_status from the regular grades table.
  // Exception (1=Excused, 2=Incomplete, 3=Missing, 4=Late) deletes any
  // existing score in Schoology when set — surfaced on the assessment page so
  // the rubric can be locked while an exception is active.
  // comment_status drives the Display-to-student toggle (#34): integer 1 = visible,
  // null/missing = hidden. has_grade_row distinguishes "synced and got null"
  // from "never synced" so the client can arm auto-flip only for virgin rows.
  const gradeRows = db.prepare(`
    SELECT s.schoology_uid, g.grade_comment, g.exception, g.comment_status
    FROM grades g
    JOIN students s ON s.id = g.student_id
    JOIN assignments a ON a.id = g.assignment_id
    WHERE a.schoology_assignment_id = ?
  `).all(assignmentId);

  const commentMap = {};
  const exceptionMap = {};
  const commentStatusMap = {};
  const hasGradeRowMap = {};
  for (const c of gradeRows) {
    commentMap[c.schoology_uid] = c.grade_comment || '';
    exceptionMap[c.schoology_uid] = c.exception ?? 0;
    commentStatusMap[c.schoology_uid] = c.comment_status ?? null;
    hasGradeRowMap[c.schoology_uid] = true;
  }
```

- [ ] **Step 2: Add the new fields to each student in the response**

Replace the `students.map(...)` block at `server/routes/mastery.js:388-393` so each student also surfaces the two new fields:

```javascript
    students: students.map(s => ({
      ...s,
      scores: scoreMap[s.schoology_uid] || {},
      grade_comment: commentMap[s.schoology_uid] || '',
      exception: exceptionMap[s.schoology_uid] || 0,
      comment_status: commentStatusMap[s.schoology_uid] ?? null,
      has_grade_row: hasGradeRowMap[s.schoology_uid] === true,
    })),
```

- [ ] **Step 3: Verify server still parses**

Run: `node --check server/routes/mastery.js`
Expected: no output, exit 0.

- [ ] **Step 4: Verify the response shape end-to-end**

Start the dev server (`npm run dev:server`) and curl the route for any course/assignment you have data for, e.g.:

```bash
curl -s http://localhost:3001/api/mastery/<courseId>/assignment/<assignmentId> | jq '.students[0] | {schoology_uid, grade_comment, comment_status, has_grade_row}'
```

Expected: an object containing `comment_status` (number or null) and `has_grade_row` (boolean). Two cases must hold across the response:
- A student known to have a grade synced shows `has_grade_row: true` and a non-undefined `comment_status`.
- A student with no grade record (e.g. just enrolled, never graded) shows `has_grade_row: false` and `comment_status: null`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/mastery.js
git commit -m "feat(#34): expose comment_status and has_grade_row on assessment GET"
```

---

## Task 2: Extend `/write-comment` route to accept and persist `commentStatus`

**Files:**
- Modify: `server/routes/mastery.js:397-459`

- [ ] **Step 1: Pull `commentStatus` from the request body and validate**

In the route handler at `server/routes/mastery.js:397-459`, change the destructure on line 400 to also pick up `commentStatus`:

```javascript
  const { enrollmentId, assignmentId, comment, commentStatus } = req.body;
```

Just below the existing `if (!enrollmentId || !assignmentId)` validation, normalize the value to a strict integer for the public-API form. Treat anything other than the literal boolean `false` as visible (default-on for backward compat with any other caller):

```javascript
  // Public OAuth API uses integer 1 = visible, null = hidden.
  // Map the boolean from the client; default to 1 when omitted so existing
  // callers (none today) keep their current behaviour.
  const commentStatusInt = commentStatus === false ? null : 1;
```

- [ ] **Step 2: Use `commentStatusInt` in the PUT payload**

Replace the `payload` object construction in the `/write-comment` handler so `comment_status` is the new derived value rather than the implicit hardcoded `1`:

```javascript
  const payload = {
    assignment_id: String(assignmentId),
    enrollment_id: String(enrollmentId),
    comment: comment || '',
    comment_status: commentStatusInt,
  };
  if (fresh && fresh.grade != null) payload.grade = String(fresh.grade);
  if (fresh && fresh.exception != null) payload.exception = fresh.exception;
```

(The fresh-grade-fetch above this block, added in #46, stays exactly as-is.)

- [ ] **Step 3: Persist the new `comment_status` to local DB after the PUT succeeds**

Replace the post-success local-DB update block (the `db.prepare(\`UPDATE grades ...\`).run(...)` call) so it writes the new value of `comment_status` instead of hardcoding `1`:

```javascript
    db.prepare(`
      UPDATE grades
      SET grade_comment = ?, comment_status = ?
      WHERE student_id = (
        SELECT s.id FROM students s
        JOIN enrolments e ON e.student_id = s.id
        WHERE e.schoology_enrolment_id = ?
      )
      AND assignment_id = (
        SELECT id FROM assignments WHERE schoology_assignment_id = ?
      )
    `).run(comment || '', commentStatusInt, String(enrollmentId), String(assignmentId));
```

- [ ] **Step 4: Verify server still parses**

Run: `node --check server/routes/mastery.js`
Expected: no output, exit 0.

- [ ] **Step 5: Smoke-test the route with curl**

With the dev server running, exercise the route in both modes against a real (student, assignment) pair you control. (Pick one whose visibility flip you can verify in Schoology's UI.)

```bash
# Hide the comment
curl -s -X POST http://localhost:3001/api/mastery/<courseId>/write-comment \
  -H 'Content-Type: application/json' \
  -d '{"enrollmentId":"<enr>","assignmentId":"<asg>","comment":"test hide","commentStatus":false}'

# Then verify in Schoology that "Display to student" is unticked for that row.

# Re-publish
curl -s -X POST http://localhost:3001/api/mastery/<courseId>/write-comment \
  -H 'Content-Type: application/json' \
  -d '{"enrollmentId":"<enr>","assignmentId":"<asg>","comment":"test show","commentStatus":true}'

# Verify "Display to student" is ticked.
```

Then check local DB caught up:

```bash
sqlite3 server/db/students.db "SELECT grade_comment, comment_status FROM grades WHERE assignment_id = (SELECT id FROM assignments WHERE schoology_assignment_id = '<asg>') LIMIT 5;"
```

Expected: rows show the just-written `comment_status` (1 after the second curl, NULL after the first).

- [ ] **Step 6: Commit**

```bash
git add server/routes/mastery.js
git commit -m "feat(#34): forward commentStatus through /write-comment to Schoology and DB"
```

---

## Task 3: Update the client API helper

**Files:**
- Modify: `client/src/services/api.js:110`

- [ ] **Step 1: Confirm current signature**

The current line at `client/src/services/api.js:110`:

```javascript
export const writeMasteryComment = (courseId, data) => request(`/mastery/${courseId}/write-comment`, { method: 'POST', body: JSON.stringify(data) });
```

The helper already passes the entire `data` object through verbatim. Adding a new field on the caller side is sufficient; no helper change is required.

- [ ] **Step 2: No commit yet**

This task is documentation only — there's nothing to change here. The next task adds the `commentStatus` field at the call site.

---

## Task 4: Component state — load `display` and arm auto-flip

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx:29-44`

- [ ] **Step 1: Initialise display state from the loaded student row**

The current `StudentRubricCard` declaration block at `client/src/pages/AssessmentSummaryPage.jsx:29-44`:

```javascript
function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, onSaved }) {
  // pending: { [topicId]: 'ED'|'EX'|'D'|'EM'|'IE' }
  const [pending, setPending] = useState({});
  const [comment, setComment] = useState(student.grade_comment || '');
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
```

Replace it with a version that also tracks the toggle's loaded value, current value, and whether auto-flip is still armed:

```javascript
function StudentRubricCard({ student, topics, courseId, assignmentId, assignmentRow, onSaved }) {
  // pending: { [topicId]: 'ED'|'EX'|'D'|'EM'|'IE' }
  const [pending, setPending] = useState({});
  const [comment, setComment] = useState(student.grade_comment || '');
  // Display-to-student toggle (#34). Loaded from grades.comment_status:
  // 1 → ON, anything else → OFF. For virgin records (no grade row synced
  // from Schoology) we arm auto-flip so the toggle flips ON the first time
  // the teacher types a comment or selects a rubric cell. Once the user has
  // touched the toggle (auto or manual) we disarm.
  const loadedDisplay = student.comment_status === 1;
  const [display, setDisplay] = useState(loadedDisplay);
  const [autoFlipArmed, setAutoFlipArmed] = useState(student.has_grade_row !== true);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
```

- [ ] **Step 2: Extend `hasPendingChanges` to include toggle changes**

Replace the existing `hasPendingChanges` line:

```javascript
  const hasPendingChanges = !isLocked && (Object.keys(pending).length > 0 || comment !== (student.grade_comment || ''));
```

with:

```javascript
  const hasPendingChanges = !isLocked && (
    Object.keys(pending).length > 0 ||
    comment !== (student.grade_comment || '') ||
    display !== loadedDisplay
  );
```

- [ ] **Step 3: Verify the client builds**

Run: `npm run build`
Expected: Vite build completes without TypeScript or syntax errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx
git commit -m "feat(#34): load display-to-student state and track pending change"
```

---

## Task 5: Auto-flip wiring on first comment keystroke or first rubric click

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` — the `selectLevel` function (around line 46) and the comment `onChange` (around line 244).

- [ ] **Step 1: Auto-flip when a rubric cell is clicked**

The current `selectLevel` (around `client/src/pages/AssessmentSummaryPage.jsx:46-55`):

```javascript
  function selectLevel(topicId, level) {
    if (isLocked) return;
    const currentGrade = student.scores[topicId]?.grade;
    if (level === currentGrade) {
      // Clicking current — deselect pending
      setPending(p => { const n = { ...p }; delete n[topicId]; return n; });
    } else {
      setPending(p => ({ ...p, [topicId]: level }));
    }
  }
```

Replace with:

```javascript
  function selectLevel(topicId, level) {
    if (isLocked) return;
    if (autoFlipArmed) {
      setDisplay(true);
      setAutoFlipArmed(false);
    }
    const currentGrade = student.scores[topicId]?.grade;
    if (level === currentGrade) {
      // Clicking current — deselect pending
      setPending(p => { const n = { ...p }; delete n[topicId]; return n; });
    } else {
      setPending(p => ({ ...p, [topicId]: level }));
    }
  }
```

- [ ] **Step 2: Auto-flip when the comment goes from empty to non-empty**

Find the existing comment `<textarea>` `onChange` at around `client/src/pages/AssessmentSummaryPage.jsx:244`:

```javascript
          onChange={e => setComment(e.target.value)}
```

Replace with:

```javascript
          onChange={e => {
            const next = e.target.value;
            // Auto-flip ON the first time the comment goes empty → non-empty
            // for a virgin record. After firing once, autoFlipArmed is cleared
            // so subsequent edits don't re-flip the toggle.
            if (autoFlipArmed && comment === '' && next !== '') {
              setDisplay(true);
              setAutoFlipArmed(false);
            }
            setComment(next);
          }}
```

- [ ] **Step 3: Verify the client builds**

Run: `npm run build`
Expected: completes cleanly.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx
git commit -m "feat(#34): auto-flip display toggle on first comment or rubric edit"
```

---

## Task 6: Render the slide toggle

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` — the comment + update block at lines 237-266.

- [ ] **Step 1: Add the toggle to the button row**

Find the action row (around `client/src/pages/AssessmentSummaryPage.jsx:249-265`):

```javascript
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem', alignItems: 'center' }}>
          <button
            className="primary"
            onClick={handleSave}
            disabled={saving || !hasPendingChanges}
          >
            {saving ? 'Saving...' : 'Update Schoology'}
          </button>
          {hasPendingChanges && !saving && (
            <button className="ghost" onClick={() => { setPending({}); setComment(student.grade_comment || ''); }}>
              Discard Changes
            </button>
          )}
          {!hasPendingChanges && (
            <span className="text-sm text-muted">No changes</span>
          )}
        </div>
```

Replace with:

```javascript
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem', alignItems: 'center' }}>
          <button
            className="primary"
            onClick={handleSave}
            disabled={saving || !hasPendingChanges}
          >
            {saving ? 'Saving...' : 'Update Schoology'}
          </button>
          {hasPendingChanges && !saving && (
            <button className="ghost" onClick={() => {
              setPending({});
              setComment(student.grade_comment || '');
              setDisplay(loadedDisplay);
            }}>
              Discard Changes
            </button>
          )}
          {!hasPendingChanges && (
            <span className="text-sm text-muted">No changes</span>
          )}
          <label
            style={{
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center',
              gap: '0.5rem', fontSize: '0.78rem', color: 'var(--text-muted)',
              cursor: isLocked ? 'not-allowed' : 'pointer', userSelect: 'none',
              opacity: isLocked ? 0.45 : 1,
            }}
            title="When ON, the student sees this assignment's grade, comment, and proficiencies on Schoology."
          >
            Display to student
            <span
              role="switch"
              aria-checked={display}
              aria-label="Display to student"
              onClick={() => {
                if (isLocked) return;
                setDisplay(d => !d);
                setAutoFlipArmed(false);
              }}
              style={{
                position: 'relative', width: 36, height: 20,
                background: display ? 'var(--accent)' : 'var(--bg-subtle)',
                border: '1px solid var(--border)', borderRadius: 999,
                transition: 'background 0.15s',
                pointerEvents: isLocked ? 'none' : 'auto',
              }}
            >
              <span style={{
                position: 'absolute', top: 1, left: display ? 17 : 1,
                width: 16, height: 16, borderRadius: '50%',
                background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                transition: 'left 0.15s',
              }} />
            </span>
          </label>
        </div>
```

`Discard Changes` is updated above to also reset the toggle to its loaded value, matching the existing reset semantics for `pending` and `comment`.

- [ ] **Step 2: Verify the client builds**

Run: `npm run build`
Expected: completes cleanly.

- [ ] **Step 3: Spot-check the page in dev**

Start `npm run dev` and open any aligned assessment page in the browser. The toggle should be:
- Right-aligned on the button row
- Visually reflecting `loadedDisplay` (ON when the student already has `comment_status: 1`, OFF otherwise)
- Disabled-looking and unresponsive when the student row shows the "rubric locked" exception badge

Don't save yet — Task 7 wires the toggle's value into the save call.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx
git commit -m "feat(#34): render Display-to-student slide toggle on assessment card"
```

---

## Task 7: Send the toggle's value on save and gate the comment write on it

**Files:**
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` — `handleSave` at lines 57-107.

- [ ] **Step 1: Extend the comment-write gate and payload**

The current `handleSave` block at `client/src/pages/AssessmentSummaryPage.jsx:79-101`:

```javascript
      const hasScoreChanges = Object.keys(pending).length > 0;
      const hasCommentChange = comment !== (student.grade_comment || '');

      if (hasScoreChanges && assignmentRow) {
        await writeMasteryScores(courseId, {
          enrollmentId: student.enrollment_id,
          assignmentId,
          gradeInfo,
          gradingPeriodId: assignmentRow.mastery_grading_period_id,
          gradingCategoryId: assignmentRow.mastery_grading_category_id,
        });
      }

      if (hasCommentChange) {
        await writeMasteryComment(courseId, {
          enrollmentId: student.enrollment_id,
          assignmentId,
          comment,
        });
      }
      setSaveResult('saved');
      setPending({});
      onSaved?.();
```

Replace with:

```javascript
      const hasScoreChanges = Object.keys(pending).length > 0;
      const hasCommentChange = comment !== (student.grade_comment || '');
      const hasDisplayChange = display !== loadedDisplay;

      if (hasScoreChanges && assignmentRow) {
        await writeMasteryScores(courseId, {
          enrollmentId: student.enrollment_id,
          assignmentId,
          gradeInfo,
          gradingPeriodId: assignmentRow.mastery_grading_period_id,
          gradingCategoryId: assignmentRow.mastery_grading_category_id,
        });
      }

      if (hasCommentChange || hasDisplayChange) {
        await writeMasteryComment(courseId, {
          enrollmentId: student.enrollment_id,
          assignmentId,
          comment,
          commentStatus: display,
        });
      }
      setSaveResult('saved');
      setPending({});
      onSaved?.();
```

`commentStatus` is sent as the boolean from component state; the server route maps it to the public-API integer (`true → 1`, `false → null`).

- [ ] **Step 2: Verify the client builds**

Run: `npm run build`
Expected: completes cleanly.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/AssessmentSummaryPage.jsx
git commit -m "feat(#34): send commentStatus on save; trigger comment write on toggle change"
```

---

## Task 8: End-to-end manual verification

**Files:** none — exercises every flow listed in the spec's Verification section.

- [ ] **Step 1: Start the app**

Run: `npm run dev`
Then open the assessment page for any course/assignment with an aligned rubric in the browser.

- [ ] **Step 2: Virgin record — type a comment auto-flips ON**

Pick a student who has no grade row yet for this assignment (no rubric scores, no comment). Confirm via DB:

```bash
sqlite3 server/db/students.db "SELECT g.id FROM grades g JOIN assignments a ON a.id = g.assignment_id JOIN students s ON s.id = g.student_id WHERE a.schoology_assignment_id = '<asg>' AND s.schoology_uid = '<uid>';"
```

Expected: empty result.

In the UI: their toggle should render OFF. Type any character into the comment box. The toggle should flip to ON. Click Update Schoology. Open Schoology's gradebook for that assignment, open the student's comment popup — "Display to student" should be ticked.

- [ ] **Step 3: Virgin record — first rubric click auto-flips ON**

Pick another student with no grade row. Their toggle is OFF. Without typing anything in the comment field, click any rubric cell. Toggle flips to ON. Click Update Schoology. Confirm in Schoology that proficiencies are visible to the student (Display to student ticked).

- [ ] **Step 4: Synced row with `comment_status: null` — typing does NOT auto-flip**

Pick a student whose `grades` row exists but has `comment_status` null/0 (verify via sqlite3 if unsure). Their toggle should render OFF on page load. Type a comment in the box. The toggle stays OFF (Schoology's existing state respected). Save. Confirm in Schoology the comment was saved but Display-to-student remains unticked for that row.

- [ ] **Step 5: Synced row with `comment_status: 1` — manual flip OFF hides feedback**

Pick a student whose `grades` row has `comment_status: 1`. Their toggle renders ON. Click the toggle to flip it OFF. Click Update Schoology. Confirm in Schoology Display-to-student is now unticked for that row.

- [ ] **Step 6: Refresh-from-Schoology pulls toggle state back**

Following Step 5, click "Refresh from Schoology" on the assessment page. The toggle remains OFF (matching Schoology). Now in Schoology directly tick Display-to-student again, then re-click "Refresh from Schoology" in Prism. Toggle flips back to ON without a page reload.

- [ ] **Step 7: Locked rubric is uninteractive**

Pick a student with an active exception (Excused/Incomplete/Missing/Late). Confirm the rubric grid is dimmed and locked. The toggle should be visually dimmed and clicks should not change its state.

- [ ] **Step 8: Discard reverts the toggle**

For any student, change the toggle (and optionally the comment). Click Discard Changes. The toggle returns to its loaded state.

- [ ] **Step 9: Close the loop on the issue**

If all eight previous steps passed, post a brief verification summary on issue #34 noting which scenarios were exercised, then close the issue with a link to the merged commit (or PR if you opened one).

```bash
gh issue comment 34 --body "Verified:
- Virgin record: comment-typing and rubric-click both auto-flip ON
- Synced null record: typing does not auto-flip; Schoology state respected
- Synced visible record: manual flip OFF hides on Schoology
- Refresh pulls toggle state back from Schoology
- Locked rubric is uninteractive
- Discard reverts the toggle

Implemented in <commit-sha>."
gh issue close 34
```

---

## Self-Review Notes

- **Spec coverage** — every acceptance criterion in the spec maps to a task: UI placement (Task 6), initial state from `comment_status` (Tasks 1+4), auto-flip (Task 5), Update/Discard wiring (Tasks 4+6+7), server PUT and local DB persist (Task 2), refresh-from-Schoology already wired by #46 (verified in Task 8 Step 6), exception lock (Task 6 + Task 8 Step 7).
- **No placeholders** — every code step shows the exact code; every command shows expected output.
- **Type/name consistency** — `display` (boolean) on the client, `commentStatus` (boolean) on the wire, `commentStatusInt` (1 / null) inside the server route, `comment_status` (column / Schoology field). Each name is used consistently in its layer.
