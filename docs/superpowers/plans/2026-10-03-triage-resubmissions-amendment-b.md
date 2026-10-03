# Triage resubmissions — Amendment B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every submission gets visible, documented feedback: remove "Reviewed", turn Close into "Grade stands" (deadline passed only), publish a status line to the student's Schoology comment (after a confirm modal) for ask / extend / grade stands / undo / late-work & make-up extensions, and decide "answered" from visible-feedback snapshots instead of the grade timestamp.

**Architecture:** Pure helpers (`server/lib/statusLines.js`, `server/lib/feedbackFingerprint.js`, updated `server/lib/resubmission.js`) → two Prism-owned tables (`status_lines`, `feedback_snapshots`) → a snapshot service run at sync end and after Prism saves → the resubmissions service derives state from snapshots → a comment-publish service (fresh Schoology read, echo-every-field PUT) wrapped by async action endpoints → client `StatusLineModal` used by every action. Builds on branch `feat/triage-resubmissions` (Phase 1 already implemented; this plan changes it).

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest; React 18 + RTL; PrisMCP (zod).

**Spec:** `docs/superpowers/specs/2026-10-03-triage-resubmissions-design.md` — **"Amendment B"** (end of file) is binding and supersedes conflicting earlier text.

## Global Constraints

- **Prod is this machine** (127.0.0.1:3001, `~/prism/data/students.db`). Never kill by port, never touch `~/prism/`. Dev only via `PORT=3002 DB_PATH=/tmp/<copy>.db npm run dev`, stop with `PORT=3002 npm run dev:stop`. Tests never call real Schoology: mock `server/services/schoology.js`.
- Schema: `server/db/schema.sql` **and** `MIGRATIONS`/migrate steps in `server/db/index.js`.
- Comment writes: always read the grade **fresh** from Schoology (`getSectionGrades(sectionId)`), echo `grade` and `exception`, send `comment_status: 1` (publishing a status line always makes the comment visible), via `pushGradeComments(sectionId, [payload])` — the same rules as `server/routes/mastery.js` write-comment (#46). If the fresh read fails → do not write; error `SCHOOLOGY_READ_FAILED` (HTTP 502).
- Status-line date format: `{Ddd DD/MM}` = `new Date(\`${iso}T00:00:00\`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' })` with the comma removed (e.g. `Thu 09/10`). Received-line date `{DD/MM}`.
- Status-line templates (exact; `{note}` omitted with its leading space when empty):
  - Ask: `⟳ Resubmission requested — due {Ddd DD/MM}. {note}`
  - Extend resubmission: `⟳ Resubmission requested — now due {Ddd DD/MM}. {note}`
  - Grade stands: `⟳ Resubmission deadline ({Ddd DD/MM}) passed — your grade stands.`
  - Late-work extension: `⟳ Extension — now due {Ddd DD/MM} ({n} lessons). {note}`
  - Make-up extension: `⟳ Make-up — sit by {Ddd DD/MM}. {note}`
  - Received (card chip): `⟳ Resubmission received {DD/MM} — regraded.`
- Composition: `composeComment(current, storedLine, newLine)` = remove `storedLine` from the start of `current` only if it matches verbatim — the whole comment, or followed by a newline (then strip leading blank lines), then `newLine + (rest ? '\n\n' + rest : '')`. Removing a line = `composeComment(current, storedLine, '')` → `rest`.
- Fingerprint comment part = `teacherText(comment, storedLine)` only when `comment_status === 1`, else `''`.
- Write order for every action with a line: validate the Prism action → publish → record in Prism. A failed publish changes nothing in Prism.
- "Grade stands" only when the Waiting row is red (today after `until`); otherwise `NOT_AT_DEADLINE` (409).
- Colours via CSS variables; buttons `.primary/.secondary/.ghost`; dates DD/MM/YYYY via `formatDate` in the UI.
- Server tests `npx vitest run <path>`; client `cd client && npx vitest run <path>`; full: `npx vitest run` and `cd client && npm test`. Commit per task with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Hidden comment edited after a resubmission** — must stay Arrived (fingerprint ignores hidden text). Test in Task 3.
2. **Teacher edits the line in the confirm** — the stored line is the edited text; the next action replaces it exactly. Test in Task 1/4.
3. **Line hand-edited in Schoology** — not removed by the next action; counted as teacher text in the fingerprint. Test in Task 1/3.
4. **Fresh Schoology read fails** — nothing published, nothing recorded, clear error. Test in Task 4.
5. **First deploy** — pairs the old rule called resubmitted are Arrived; nothing else changes. Test in Task 3.

---

### Task 1: Pure helpers — status lines, fingerprint, snapshot-based state

**Files:**
- Create: `server/lib/statusLines.js`, `server/lib/statusLines.test.js`, `server/lib/feedbackFingerprint.js`, `server/lib/feedbackFingerprint.test.js`
- Modify: `server/lib/resubmission.js` (+ test)

**Interfaces (Produces):**
- `statusLines.js`: `lineDate(iso) → 'Thu 09/10'`; `shortDate(iso) → '09/10'`; `askLine({ until, note })`, `extendResubmissionLine({ until, note })`, `gradeStandsLine({ until })`, `extensionLine({ until, lessons, note })`, `makeUpLine({ until, note })`, `receivedLine({ on })`; `composeComment(current, storedLine, newLine) → string`; `teacherText(comment, storedLine) → string` (= `composeComment(comment, storedLine, '')`, trimmed).
- `feedbackFingerprint.js`: `fingerprint({ score, exception, comment, commentStatus, levels, storedLine }) → string` (stable JSON: `{"s":score|null,"e":exception|0,"l":[sorted "topic:grade"],"c":visibleTeacherText}`); `hasPriorFeedback(fingerprintString) → boolean` (s≠null, e>0, l non-empty, or c≠'').
- `resubmission.js`: replace `resubmissionState` with `resubmissionStateFromSnapshot({ snapshot, currentFingerprint, requestedAt = 0 }) → 'arrived'|'waiting'|'fulfilled'|null` where `snapshot = { arrival_revision_at, arrival_baseline } | null`:
  - with request (`requestedAt > 0`): arrival after ask (`arrival_revision_at > requestedAt`) → `currentFingerprint === arrival_baseline ? 'arrived' : 'fulfilled'`; else `'waiting'`.
  - without: arrival exists && `hasPriorFeedback(arrival_baseline)` && `currentFingerprint === arrival_baseline` → `'arrived'`; else `null`.
  Keep `hasFeedback`, `isResubmitted` (used for first-deploy seeding) and `sqliteUtcToEpoch`.

- [ ] **Step 1: Failing tests** (`statusLines.test.js`):

```js
import { describe, test, expect } from 'vitest';
import { lineDate, askLine, gradeStandsLine, extensionLine, makeUpLine, receivedLine, extendResubmissionLine, composeComment, teacherText } from './statusLines.js';

describe('status lines', () => {
  test('templates', () => {
    expect(lineDate('2026-10-08')).toBe('Thu 08/10');
    expect(askLine({ until: '2026-10-08', note: 'add tests' })).toBe('⟳ Resubmission requested — due Thu 08/10. add tests');
    expect(askLine({ until: '2026-10-08', note: '' })).toBe('⟳ Resubmission requested — due Thu 08/10.');
    expect(extendResubmissionLine({ until: '2026-10-13', note: null })).toBe('⟳ Resubmission requested — now due Tue 13/10.');
    expect(gradeStandsLine({ until: '2026-10-08' })).toBe('⟳ Resubmission deadline (Thu 08/10) passed — your grade stands.');
    expect(extensionLine({ until: '2026-10-09', lessons: 3, note: 'sick' })).toBe('⟳ Extension — now due Fri 09/10 (3 lessons). sick');
    expect(makeUpLine({ until: '2026-10-09', note: '' })).toBe('⟳ Make-up — sit by Fri 09/10.');
    expect(receivedLine({ on: '2026-10-14' })).toBe('⟳ Resubmission received 14/10 — regraded.');
  });
  test('composeComment replaces only an exact stored line at the start', () => {
    expect(composeComment('Great work.', null, 'L1')).toBe('L1\n\nGreat work.');
    expect(composeComment('L1\n\nGreat work.', 'L1', 'L2')).toBe('L2\n\nGreat work.');
    expect(composeComment('L1', 'L1', 'L2')).toBe('L2');
    expect(composeComment('L1 (edited)\n\nGreat work.', 'L1', 'L2')).toBe('L2\n\nL1 (edited)\n\nGreat work.');
    expect(composeComment('', null, 'L1')).toBe('L1');
    expect(composeComment('L1\n\nGreat work.', 'L1', '')).toBe('Great work.');
  });
  test('teacherText strips the stored line only', () => {
    expect(teacherText('L1\n\nGreat work.', 'L1')).toBe('Great work.');
    expect(teacherText('L1', 'L1')).toBe('');
    expect(teacherText('L1 edited', 'L1')).toBe('L1 edited');
    expect(teacherText('  ', null)).toBe('');
  });
});
```

(`feedbackFingerprint.test.js`): fingerprint ignores hidden comment (`commentStatus` null/0 → `c:''`), strips the stored line, sorts levels, is stable; `hasPriorFeedback` true for score 0 / exception 3 / levels / visible text, false for all-empty. (`resubmission.test.js`): replace the old `resubmissionState` cases with `resubmissionStateFromSnapshot` cases covering: unrequested arrived / acknowledged / first submission (baseline without feedback → null) / no arrival; requested waiting (no arrival after ask) / arrived / fulfilled; pre-ask arrival + ask → waiting.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**:

```js
// server/lib/statusLines.js — Prism's status lines in a student's Schoology comment
// (spec Amendment B). One line, always first; replaced by exact stored text, never by pattern.
export function lineDate(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace(',', '');
}
export const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
const withNote = (text, note) => (note && String(note).trim() ? `${text} ${String(note).trim()}` : text);
export const askLine = ({ until, note }) => withNote(`⟳ Resubmission requested — due ${lineDate(until)}.`, note);
export const extendResubmissionLine = ({ until, note }) => withNote(`⟳ Resubmission requested — now due ${lineDate(until)}.`, note);
export const gradeStandsLine = ({ until }) => `⟳ Resubmission deadline (${lineDate(until)}) passed — your grade stands.`;
export const extensionLine = ({ until, lessons, note }) => withNote(`⟳ Extension — now due ${lineDate(until)} (${lessons} lessons).`, note);
export const makeUpLine = ({ until, note }) => withNote(`⟳ Make-up — sit by ${lineDate(until)}.`, note);
export const receivedLine = ({ on }) => `⟳ Resubmission received ${shortDate(on)} — regraded.`;

// Remove the exact stored line from the start (if still there verbatim), then prepend newLine.
export function composeComment(current, storedLine, newLine) {
  let rest = String(current ?? '');
  // Verbatim match only: the whole comment, or the stored line followed by a newline
  // (so a hand-edited "L1 (edited)" is never mistaken for "L1").
  if (storedLine && (rest === storedLine || rest.startsWith(`${storedLine}\n`))) rest = rest.slice(storedLine.length).replace(/^\n+/, '');
  rest = rest.replace(/^\s+$/, '');
  if (!newLine) return rest;
  return rest ? `${newLine}\n\n${rest}` : newLine;
}
export const teacherText = (comment, storedLine) => composeComment(comment, storedLine, '').trim();
```

`feedbackFingerprint.js` and the new `resubmissionStateFromSnapshot` per the interface above.

- [ ] **Step 4: Run** → PASS (`npx vitest run server/lib`). **Step 5: Commit** — `feat(resubmissions): status-line and visible-feedback fingerprint helpers`.

---

### Task 2: Tables — `status_lines`, `feedback_snapshots`; drop `closes_request_id`

**Files:** `server/db/schema.sql`, `server/db/index.js`, `server/db/index.test.js`

**Interfaces (Produces):**
```sql
CREATE TABLE IF NOT EXISTS status_lines (
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  line TEXT NOT NULL,                 -- the exact text Prism published (after the teacher's edits)
  kind TEXT NOT NULL,                 -- 'ask' | 'extend_resubmission' | 'grade_stands' | 'extension' | 'make_up' | 'received'
  written_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (student_id, assignment_id)
);
CREATE TABLE IF NOT EXISTS feedback_snapshots (
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  fingerprint TEXT NOT NULL,          -- last seen visible feedback (feedbackFingerprint.js)
  revision_at INTEGER NOT NULL DEFAULT 0,      -- last seen grades.latest_revision_at
  arrival_revision_at INTEGER NOT NULL DEFAULT 0,  -- the resubmission being answered (0 = none)
  arrival_baseline TEXT,              -- visible feedback just before that resubmission
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (student_id, assignment_id)
);
```
Remove `closes_request_id` from the `resubmissions` CREATE TABLE and its `ALTER` from `MIGRATIONS` (not in prod; dev DBs may keep an unused column). Both new tables are new → CREATE only.

- [ ] Steps: failing test that `migrate()` creates both tables with these columns/PKs (PRAGMA table_info) → implement → `npx vitest run server/db` PASS → commit `feat(db): status_lines and feedback_snapshots tables`.

---

### Task 3: Snapshot service + snapshot-based state; remove Reviewed

**Files:**
- Create: `server/services/feedbackSnapshots.js` (+ test)
- Modify: `server/services/resubmissions.js` (+ test), `server/services/triage.js` (+ test), `server/services/sync.js` (+ test), `server/routes/mastery.js`, `server/routes/courses.js`, `server/routes/students.js`, `server/services/assessmentContext.js`, `server/routes/triage.js`, `mcp/handlers.js`, `mcp/server.js` (+ tests)

**Interfaces:**
- `feedbackSnapshots.js`:
  - `currentFingerprints(db, { assignmentId = null, courseId = null }) → Map<'sid:aid', { fingerprint, latestRevisionAt, grade }>` — from `grades` (score, exception, grade_comment, comment_status, latest_revision_at, submitted_at) + `mastery_scores` levels (join students.schoology_uid / assignments.schoology_assignment_id) + `status_lines.line`.
  - `captureFeedbackSnapshots(db, { assignmentId = null, courseId = null }) → { arrivals: number }` — per pair: no snapshot → insert (`fingerprint`, `revision_at = latest`; **seed** an arrival with `arrival_baseline = fingerprint` iff `isResubmitted(grade)` and the comment counts as visible feedback — first-deploy rule); `latest > snapshot.revision_at` → set `arrival_revision_at = latest`, `arrival_baseline = snapshot.fingerprint`; always update `fingerprint`, `revision_at`, `updated_at`. One transaction.
  - `snapshotMap(db, { assignmentId = null, courseId = null }) → Map<'sid:aid', snapshotRow>`.
- `resubmissions.js`: `pairContext` returns `{ grade, request, snapshot, currentFingerprint }`; `stateOf` uses `resubmissionStateFromSnapshot`. **Remove** `markResubmissionReviewed`, `reviewedThroughMap`, `isResubmittedSinceReview`, all `kind='review'` handling and the `closes_request_id` logic in undo. Add `arrivedKeys(db, { courseId | studentId | assignmentId }) → Set<'sid:aid'>` (state 'arrived', requested or not) for the ↩/⚠ badge. `closeResubmission` → renamed `gradeStands(db, id, { today })`: open request only, `NOT_AT_DEADLINE` unless today > `until`; sets `status='closed'`, `close_note='grade stands'`. `outcomeOf`: closed → `'grade_stands'`.
- Routes/readers: replace `isResubmittedSinceReview`/`reviewedThroughMap` with `arrivedKeys` in mastery.js, courses.js, students.js (`resubmitted` = key in set). Remove `POST /api/triage/resubmissions/review`; PUT `{ close: true }` → `gradeStands` (409 `NOT_AT_DEADLINE`). Remove `mark_resubmission_reviewed` (handler, registration, tests); rename `close_resubmission` → `grade_stands` (description: only after the deadline; publishes nothing yet — Task 5 adds the line).
- Capture points: end of `fullSync` (before `settleResubmissions`, best-effort try/catch, after the completed sync_log update); after the local mirror in mastery `write-comment`, `send-all`, and `POST /:courseId/write` (rubric save — capture for that assignment so a rubric regrade is seen at once). `settleResubmissions` uses the new state (fulfilled → done).

- [ ] **Tests (must include):**
  - Review Focus 1: graded + visible comment; capture; new revision; capture (arrival baseline = old fp); edit **hidden** comment (comment_status null) → still `arrived`; change score → `null`/fulfilled.
  - Review Focus 3: comment with a hand-edited line counts as teacher text.
  - Review Focus 5: first capture on a pair with `latest_revision_at > submitted_at` and visible feedback → arrived; a pair without → no arrival.
  - Requested: ask on ungraded pair; revision after ask → arrived; visible comment added → fulfilled; settle → done.
  - Pre-ask arrival then ask → waiting.
  - `gradeStands` before the deadline → `NOT_AT_DEADLINE`; after → closed, outcome `grade_stands`.
  - Gradebook/mastery/student `resubmitted` follow `arrivedKeys`.
  - Sync: `fullSync` captures snapshots (mock as existing sync tests do).
- [ ] Run `npx vitest run server mcp` → PASS; commit `feat(resubmissions): answered = visible feedback changed (snapshots); Grade stands replaces Close; remove Reviewed`.

---

### Task 4: Comment publishing + action endpoints

**Files:**
- Create: `server/services/statusLinePublisher.js` (+ test, mocking `./schoology.js`)
- Modify: `server/routes/triage.js` (+ test), `server/services/triage.js` (extension helpers if needed), `server/routes/mastery.js` (write-comment accepts optional `statusLine`, `statusLineKind`)

**Interfaces (Produces):**
- `previewStatusLine(db, { studentId, assignmentId, line }) → Promise<{ currentComment, visible, storedLine, resultingComment, hiddenWarning }>` — fresh read; `hiddenWarning = !visible && teacherText(currentComment, storedLine) !== ''`.
- `publishStatusLine(db, { studentId, assignmentId, line, kind }) → Promise<{ comment }>` — fresh read (fail → `TriageError('SCHOOLOGY_READ_FAILED')`), `comment = composeComment(fresh.comment, storedLine, line)`, PUT echoing grade/exception with `comment_status: 1`, mirror local `grades` (grade_comment, comment_status=1, score/exception from fresh), upsert `status_lines` (`line`, `kind`), then `captureFeedbackSnapshots(db, { assignmentId })`.
- `removeStatusLine(db, { studentId, assignmentId }) → Promise<{ comment }>` — same but `composeComment(fresh.comment, storedLine, '')`, keep `comment_status` as fresh, delete the `status_lines` row.
- HTTP (all JSON; `TriageError` → status map + `SCHOOLOGY_READ_FAILED: 502`, `NOT_AT_DEADLINE: 409`):
  - `GET /api/triage/status-line/preview?studentId&assignmentId&line` → preview.
  - `POST /api/triage/resubmissions` body adds `commentLine?` — validate (eligibility + no open request) → publish (`kind:'ask'`) if `commentLine` → record.
  - `PUT /api/triage/resubmissions/:id` `{ lessons, commentLine? }` (extend, `kind:'extend_resubmission'`) or `{ gradeStands: true, commentLine? }` (`kind:'grade_stands'`; validate deadline first).
  - `DELETE /api/triage/resubmissions/:id?removeLine=1` — undo; if `removeLine` → `removeStatusLine` first.
  - `POST /api/triage/extensions` body adds `commentLine?` (`kind`: `'make_up'` when the assignment `is_test = 1`, else `'extension'`); `DELETE /api/triage/extensions/:id?removeLine=1`.
  - write-comment: when body has `statusLine`, upsert `status_lines` (`kind` from `statusLineKind`, default `'received'`) after a successful PUT, then capture snapshots for that assignment.
- Validation helpers exported from the services so routes can check before publishing: `assertCanRequest(db, {studentId, assignmentId})`, `assertCanExtendRequest(db, id, lessons)`, `assertCanGradeStand(db, id, today)`, `assertCanExtend(db, {studentId, assignmentId, lessons})` (reuse `recordExtension`'s checks, refactored into an assert function).

- [ ] **Tests (must include):** Review Focus 2 (edited line stored + replaced exactly next time); Review Focus 4 (fresh read throws → no PUT, no Prism record, 502); publish echoes grade/exception and sets comment_status 1; hidden comment → preview `hiddenWarning`; undo with `removeLine` removes only the stored line; extension endpoint picks `make_up` for a test; ALREADY_OPEN checked **before** any PUT (mock asserts `pushGradeComments` not called).
- [ ] Run `npx vitest run server mcp` → PASS; commit `feat(triage): publish status lines to the student's comment on ask/extend/grade stands/undo`.

---

### Task 5: PrisMCP — comment lines

**Files:** `mcp/handlers.js`, `mcp/server.js` (+ tests)

- Handlers become async where they publish: `request_resubmission`, `extend_deadline` (both paths), `grade_stands`, `undo_extension` gain `comment_line?: string` (and undo gains `remove_line?: boolean`). Descriptions: *"If the teacher wants the student told (normally yes), pass comment_line — show the teacher the exact line first; it is published to the student's Schoology comment (visible to the student and parents), replacing Prism's previous status line."* Templates in the description so the agent drafts them consistently. Add read tool `preview_status_line(student_id, assignment_id, line)` returning the preview.
- Tests: handler publishes via the mocked publisher when `comment_line` given; not when omitted.
- Commit `feat(prismcp): status lines on resubmission/extension tools`.

---

### Task 6: Client — `StatusLineModal` and wiring

**Files:**
- Create: `client/src/components/StatusLineModal.jsx` (+ test)
- Modify: `client/src/services/api.js`, `client/src/components/ResubmitControl.jsx`, `client/src/components/triage/{ResubmissionsPanel,LateWorkPanel,MakeUpPanel,ReferralHistory,TriageSection}.jsx`, `client/src/app.css` (+ tests)

**Interfaces:**
- api: `previewStatusLine({ studentId, assignmentId, line })`; existing `requestResubmission(body)` / `updateResubmission(id, body)` / `recordExtension(body)` send `commentLine`; `undoResubmission(id, { removeLine })`, `undoExtension(id, { removeLine })` add `?removeLine=1`. Remove `reviewResubmission`.
- `<StatusLineModal studentName assignmentId studentId title consequence defaultLine confirmLabel removeMode={false} onConfirm={(line) => Promise} onCancel />`:
  - Header `Publish to {studentName}'s Schoology comment`; sub *Visible to the student (and parents) as soon as you publish.*; consequence line; `textarea` (aria-label "Status line") pre-filled with `defaultLine`; "Their comment will read:" preview (fetched via `previewStatusLine`, re-fetched debounced as the line changes; new line highlighted with `var(--badge-resubmit-bg)`); hidden warning (`.alert.alert-warning`) when `hiddenWarning`; primary button `confirmLabel`, ghost Cancel; busy + error states; Escape/Cancel closes. `removeMode`: shows a checkbox "Remove Prism's line from their comment" (default checked) and the preview of the comment without the line; `onConfirm(removeChecked)`.
  - Uses a fixed overlay like `RubricModal`, but classes in `app.css` (no inline colours); phone: full-width sheet (rule in the PHONE LAYOUT block).
- Wiring (each opens the modal; `defaultLine` built client-side with the same templates — add `client/src/lib/statusLines.js` mirroring the server templates, with a parity test against fixed inputs):
  - ResubmitControl: Ask (`Publish & ask`), Extend (`Publish new due date`), Grade stands (only when `request.until < today`, `Publish & close request`), Undo (removeMode). Remove Reviewed; Arrived shows text *Awaiting your feedback — regrade or comment (visible)*.
  - ResubmissionsPanel: red Waiting → button **Grade stands** (opens modal, consequence *Ends the resubmission request: missed deadline, grade stands.*); non-red Waiting → "N left" + Extend (no Close); Arrived → no button, tag `↩ arrived · awaiting feedback`. History labels: asked → `Asked · by DD/MM/YYYY`, grade_stands → `Missed deadline · grade stands`, done → `Resubmitted · feedback given`.
  - LateWorkPanel / MakeUpPanel Extend: ExtendEditor Save opens the modal (`Publish new due date`) with `extensionLine`/`makeUpLine`.
  - ReferralHistory Undo for extensions and resubmission asks/grade-stands: removeMode modal.
- Tests: modal renders header/consequence/preview/hidden warning, edits flow to `onConfirm`, Cancel never calls APIs; Grade stands only on red rows; Extend publishes `commentLine`; Undo sends `removeLine`; no Reviewed button anywhere.
- Commit `feat(triage-ui): confirm modal publishes status lines; Grade stands; no Reviewed`.

---

### Task 7: Card — "resubmission received" chip

**Files:** `client/src/pages/AssessmentSummaryPage.jsx` (+ test), `server/routes/mastery.js` (+ test)

- Mastery GET assignment payload adds per student `status_line: { line, kind } | null` (from `status_lines`).
- On a card whose `student.resubmission?.state === 'arrived'`, show a small chip button **Insert "resubmission received" line**. Clicking replaces the stored line at the top of the comment draft with `receivedLine({ on: arrival date })` via the client `composeComment` (visible, editable, not saved until the teacher publishes). The card's save sends `statusLine` (the exact line still at the top of the draft, if it equals what was inserted) and `statusLineKind: 'received'` to write-comment.
- After a successful save with a changed visible comment or grade, the existing client patch clears Arrived (keep Task 9/final-fix behaviour).
- Tests: chip only on arrived; inserting replaces the stored line; save passes `statusLine`.
- Commit `feat(assessment): insert a 'resubmission received' line when regrading`.

---

### Task 8: Docs, parity, visual check

- Spec: add "Implementation notes (Amendment B)". `docs/design-language.md`: the StatusLineModal (significance pattern), *missed deadline · grade stands* labelling, *awaiting feedback* tag. `.claude/build-progress.md`: dated bullet. PrisMCP tool list in docs if listed.
- Parity: extend `scripts/parity-lti-resubmission.js` (read-only) to report snapshot counts and Arrived count after `captureFeedbackSnapshots` **on an in-memory copy** (`db.serialize()` → new Database(buffer)) so the probe stays read-only.
- Visual: with dev on 3002 against a `/tmp` copy seeded with an open red request + an arrival + an extension row, screenshot (390 / 1280) the rail and the open StatusLineModal for Grade stands; save to `/tmp/amendb-*.png`. **Do not publish** from the dev UI (it would write to real Schoology) — screenshot the modal only, then Cancel.
- Full suites + client build. Commit `docs(triage): amendment B notes, design language, build progress`.
