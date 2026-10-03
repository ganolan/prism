# Triage: resubmissions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 4th triage list, "Resubmissions", that chases students asked to resubmit (Waiting) and surfaces resubmissions that have arrived (Arrived) — native and LTI alike — backed by a new `resubmissions` table, plus row links that open the student's card on the assessment page.

**Architecture:** Pure state rules in `server/lib/resubmission.js`; persistence + list/actions in a new `server/services/resubmissions.js`; `getTriage` (shared by the web API and PrisMCP) calls `resubmissionRows`. The LTI sync stops overwriting the REST grade time so `latest_revision_at > submitted_at` works for OneDrive work. Client adds `ResubmissionsPanel`, a `ResubmitControl` on the assessment card, a Settings field, and a `?student=` deep link.

**Tech Stack:** Node ESM, Express, better-sqlite3, Vitest; React 18 + React Router + React Testing Library (client Vitest); PrisMCP (`@modelcontextprotocol/sdk`, zod).

**Spec:** `docs/superpowers/specs/2026-10-03-triage-resubmissions-design.md` (Phase 1 only — Phase 2 Schoology writes are NOT in this plan).

## Global Constraints

- **Prod is this machine.** Never kill by port. Dev only as `PORT=3002 DB_PATH=/tmp/prism-dev.db npm run dev` (make the DB with `sqlite3 -readonly ~/prism/data/students.db ".backup /tmp/prism-dev.db"`); stop with `PORT=3002 npm run dev:stop`. Never write to `~/prism/data/students.db`.
- Columns/tables go in `server/db/schema.sql` **and** (for existing DBs) `server/db/index.js` (`MIGRATIONS` or a migrate step).
- All colours via CSS variables in `client/src/app.css`; button classes `.primary/.secondary/.ghost`; phone rules only in the `PHONE LAYOUT` block at the end of `app.css`.
- Dates shown as DD/MM/YYYY via `formatDate` (`client/src/lib/formatDate.js`).
- Day numbering: a clock's start date is **day 1**; `day = cal.between(start, today).days + 1`; a limit is the **last allowed day**; `toneFor(days, limit, warnLeadDays)` takes the internal count (`day − 1`).
- Default resubmission deadline **3 lessons** (setting `triage.resubmitLessonsDefault`, 1–60).
- Request deadline date `until = cal.addSchoolDays(requestedOn, lessons).date`; Waiting is red once today is after `until` ⇒ last allowed day = `lessons + 1`.
- Arrived uses `feedbackLimitDays` (default 10) from the resubmission's local date.
- "Feedback given" = score not null, OR exception > 0, OR non-empty trimmed comment.
- Server tests: `npx vitest run <path>` from the repo root; client tests: `cd client && npx vitest run <path>`. Full suites: `npm test` (root) and `cd client && npm test`.
- Commit after every task with the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A request on a pair with no grades row** (asked before any submission/grade) — must list as Waiting, not crash or vanish (`grade` is `{}`). Test in Task 3.
2. **Ask after a resubmission already arrived** — the ask means "another round": the pair is Waiting at once (the pre-ask arrival is not shown again, and Reviewed on it is rejected); only a revision after the ask can arrive. Test in Task 3.
3. **A newer resubmission after a Reviewed mark** — must reappear as Arrived. Test in Task 3.
4. **LTI student graded 0 without ever submitting, now in progress** — must NOT be auto-added. Test in Task 5.
5. **Student dropped / course archived with an open request** — row disappears from triage, record stays in history. Test in Task 4.

---

### Task 1: Feedback-given rule + pure resubmission state

**Files:**
- Modify: `server/lib/resubmission.js`
- Test: `server/lib/resubmission.test.js`

**Interfaces:**
- Produces:
  - `hasFeedback(grade) → boolean`
  - `isResubmitted(grade) → boolean` (widened guard)
  - `sqliteUtcToEpoch(text) → number` ('YYYY-MM-DD HH:MM:SS' UTC → epoch seconds; 0 for falsy)
  - `resubmissionState(grade, { requestedAt = 0, reviewedThrough = 0 }) → 'arrived' | 'waiting' | 'fulfilled' | null` (`requestedAt` epoch s of an OPEN request, 0 = none)

- [ ] **Step 1: Write the failing tests** — append to `server/lib/resubmission.test.js`:

```js
import { hasFeedback, isResubmitted, resubmissionState, sqliteUtcToEpoch } from './resubmission.js';

describe('hasFeedback', () => {
  test('score, exception or a non-empty comment', () => {
    expect(hasFeedback({ score: 0 })).toBe(true);
    expect(hasFeedback({ score: null, exception: 3 })).toBe(true);
    expect(hasFeedback({ score: null, exception: 0, grade_comment: ' Fix the intro ' })).toBe(true);
    expect(hasFeedback({ score: null, exception: 0, grade_comment: '   ' })).toBe(false);
    expect(hasFeedback(null)).toBe(false);
  });
});

describe('isResubmitted — comment-only feedback counts', () => {
  test('a revision after a comment-only grade time is a resubmission', () => {
    expect(isResubmitted({ score: null, exception: 0, grade_comment: 'Redo Q2', submitted_at: 100, latest_revision_at: 200 })).toBe(true);
  });
  test('no feedback at all is never a resubmission', () => {
    expect(isResubmitted({ score: null, exception: 0, grade_comment: '', submitted_at: 100, latest_revision_at: 200 })).toBe(false);
  });
});

describe('sqliteUtcToEpoch', () => {
  test('reads SQLite UTC datetimes', () => {
    expect(sqliteUtcToEpoch('2026-10-12 04:00:00')).toBe(Date.parse('2026-10-12T04:00:00Z') / 1000);
    expect(sqliteUtcToEpoch(null)).toBe(0);
  });
});

describe('resubmissionState', () => {
  const graded = { score: 80, exception: 0, grade_comment: '', submitted_at: 1000 };
  test('unrequested: arrived when the revision is newer than the grade time', () => {
    expect(resubmissionState({ ...graded, latest_revision_at: 2000 })).toBe('arrived');
    expect(resubmissionState({ ...graded, latest_revision_at: 900 })).toBe(null);
  });
  test('unrequested: a review covering the revision hides it; a newer one reappears', () => {
    expect(resubmissionState({ ...graded, latest_revision_at: 2000 }, { reviewedThrough: 2000 })).toBe(null);
    expect(resubmissionState({ ...graded, latest_revision_at: 3000 }, { reviewedThrough: 2000 })).toBe('arrived');
  });
  test('request: waiting until a revision newer than both the grade time and the ask', () => {
    expect(resubmissionState({ ...graded, latest_revision_at: 900 }, { requestedAt: 1500 })).toBe('waiting');
    expect(resubmissionState({ ...graded, latest_revision_at: 1200 }, { requestedAt: 1500 })).toBe('waiting');
    expect(resubmissionState({ ...graded, latest_revision_at: 1600 }, { requestedAt: 1500 })).toBe('arrived');
  });
  test('request: works with no grades row and no feedback (baseline = the ask)', () => {
    expect(resubmissionState({}, { requestedAt: 1500 })).toBe('waiting');
    expect(resubmissionState({ latest_revision_at: 1600 }, { requestedAt: 1500 })).toBe('arrived');
  });
  test('request: fulfilled once regraded after the post-ask revision', () => {
    expect(resubmissionState({ ...graded, submitted_at: 1700, latest_revision_at: 1600 }, { requestedAt: 1500 })).toBe('fulfilled');
  });
  test('request: reviewed post-ask revision is fulfilled; reviewed pre-ask revision is still waiting', () => {
    expect(resubmissionState({ ...graded, latest_revision_at: 1600 }, { requestedAt: 1500, reviewedThrough: 1600 })).toBe('fulfilled');
    expect(resubmissionState({ ...graded, latest_revision_at: 1200 }, { requestedAt: 1500, reviewedThrough: 1200 })).toBe('waiting');
  });
});
```

(Keep the file's existing imports/tests; merge the import line with the existing one.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/lib/resubmission.test.js`
Expected: FAIL — `hasFeedback` / `resubmissionState` / `sqliteUtcToEpoch` not exported.

- [ ] **Step 3: Implement** — replace `server/lib/resubmission.js` with:

```js
// Resubmission detection (#49 Part B; triage resubmissions 2026-10-03).
// Grade time = grades.submitted_at (the REST grade timestamp; a teacher write —
// score, exception OR comment — sets it, a submission alone never does).
// Resubmission time = grades.latest_revision_at (native: newest non-draft
// revision; LTI: the grader's submissionDate).

// Feedback given = a score, an exception, or a non-empty comment.
export function hasFeedback(grade) {
  if (!grade) return false;
  if (grade.score != null) return true;
  if ((Number(grade.exception) || 0) > 0) return true;
  return String(grade.grade_comment ?? '').trim().length > 0;
}

// "Resubmitted since last feedback": feedback exists and the latest revision is newer.
export function isResubmitted(grade) {
  if (!hasFeedback(grade)) return false;
  const submittedAt = Number(grade.submitted_at) || 0;
  const latestRevisionAt = Number(grade.latest_revision_at) || 0;
  if (submittedAt <= 0 || latestRevisionAt <= 0) return false;
  return latestRevisionAt > submittedAt;
}

// SQLite datetime('now') text (UTC, 'YYYY-MM-DD HH:MM:SS') → epoch seconds.
export function sqliteUtcToEpoch(text) {
  if (!text) return 0;
  const ms = Date.parse(`${String(text).replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

// One student × assessment. requestedAt = epoch of an OPEN request (0 = none);
// reviewedThrough = the newest revision a "Reviewed" mark covered (0 = none).
//   'arrived'   — a resubmission to look at
//   'waiting'   — asked, nothing new yet
//   'fulfilled' — asked, resubmitted after the ask, and regraded/reviewed since (hide; settle → done)
//   null        — nothing to show
export function resubmissionState(grade, { requestedAt = 0, reviewedThrough = 0 } = {}) {
  const g = grade || {};
  const latest = Number(g.latest_revision_at) || 0;
  const gradedAt = Number(g.submitted_at) || 0;
  const reviewed = latest > 0 && latest <= reviewedThrough;
  if (requestedAt > 0) {
    if (latest > requestedAt && (gradedAt >= latest || reviewed)) return 'fulfilled';
    if (latest > Math.max(gradedAt, requestedAt) && !reviewed) return 'arrived';
    return 'waiting';
  }
  return isResubmitted(g) && !reviewed ? 'arrived' : null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/lib/resubmission.test.js`
Expected: PASS (existing tests too — the old score/exception cases still hold).

- [ ] **Step 5: Check every `isResubmitted` caller selects `grade_comment`** — `server/routes/courses.js` (grades SELECT ~line 228), `server/services/assessmentContext.js` `getGradeMetaRows`, `server/routes/students.js` (the grades query feeding line ~131). Add `g.grade_comment` to any SELECT lacking it. Run `npx vitest run server/routes server/services/assessmentContext.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server/lib/resubmission.js server/lib/resubmission.test.js server/routes server/services/assessmentContext.js
git commit -m "feat(resubmission): comment-only feedback counts; pure resubmissionState

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `resubmissions` table, flag migration, default-lessons setting

**Files:**
- Modify: `server/db/schema.sql` (after the `extensions` table), `server/db/index.js` (new `migrateResubmitFlags`, called in `migrate`), `server/services/settings.js` (`TRIAGE_KEYS`)
- Test: `server/db/index.test.js`, `server/services/settings.test.js` (create if absent — check `ls server/services/settings*`; settings route tests live in `server/routes/settings.test.js`)

**Interfaces:**
- Produces: table `resubmissions` (columns per spec), `migrateResubmitFlags(database)`, setting `resubmitLessonsDefault` in `getTriageSettings` output (default 3, 1–60).

- [ ] **Step 1: Failing tests** — in `server/db/index.test.js` add:

```js
import Database from 'better-sqlite3';
import { migrate, migrateResubmitFlags } from './index.js';

describe('migrateResubmitFlags', () => {
  test('turns open resubmit_requested flags into open requests and removes the flags', () => {
    const db = new Database(':memory:');
    migrate(db);
    const c = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('s', 'C')`).run().lastInsertRowid;
    const s = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u', 'A', 'B')`).run().lastInsertRowid;
    const a = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title) VALUES (?, 'x', 'T')`).run(c).lastInsertRowid;
    db.prepare(`INSERT INTO flags (student_id, assignment_id, flag_type, created_at) VALUES (?, ?, 'resubmit_requested', '2026-06-02 04:50:08')`).run(s, a);
    db.prepare(`INSERT INTO flags (student_id, assignment_id, flag_type, flag_reason) VALUES (?, ?, 'review_needed', 'why')`).run(s, a);

    migrateResubmitFlags(db);
    migrateResubmitFlags(db); // idempotent

    const reqs = db.prepare(`SELECT * FROM resubmissions`).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ student_id: s, assignment_id: a, course_id: c, kind: 'request', status: 'open', lessons: 3, source: 'app', requested_at: '2026-06-02 04:50:08' });
    expect(db.prepare(`SELECT flag_type FROM flags`).all()).toEqual([{ flag_type: 'review_needed' }]);
  });

  test('one open request per pair is enforced', () => {
    const db = new Database(':memory:');
    migrate(db);
    const ins = `INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons) VALUES (1, 1, 1, 'request', 'open', '2026-10-01 00:00:00', 3)`;
    db.pragma('foreign_keys = OFF');
    db.exec(ins);
    expect(() => db.exec(ins)).toThrow(/UNIQUE/);
  });
});
```

And for settings (in whichever settings test file exists — `server/routes/settings.test.js` hits `GET /api/settings`; add a direct service test there or a new `server/services/settings.test.js`):

```js
import { getTriageSettings, updateTriageSettings } from './settings.js';
test('resubmitLessonsDefault defaults to 3 and clamps to 1–60', () => {
  const db = new Database(':memory:'); migrate(db);
  expect(getTriageSettings(db).resubmitLessonsDefault).toBe(3);
  updateTriageSettings(db, { resubmitLessonsDefault: 99 });
  expect(getTriageSettings(db).resubmitLessonsDefault).toBe(60);
});
```

- [ ] **Step 2: Run** `npx vitest run server/db/index.test.js server/services/settings.test.js` → FAIL (no table / export / key).

- [ ] **Step 3: Implement**

`server/db/schema.sql` — after the `extensions` table:

```sql
-- Triage resubmissions (2026-10-03 spec). One row per round: a 'request' (asked to
-- resubmit, with a deadline in lessons) or a 'review' ("Reviewed" — the arrival
-- at revision_at was looked at, grade stands). At most one open request per pair.
CREATE TABLE IF NOT EXISTS resubmissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  kind TEXT NOT NULL CHECK (kind IN ('request', 'review')),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'done')),
  requested_at TEXT,                    -- request: asked / first seen unsubmitted (UTC 'YYYY-MM-DD HH:MM:SS')
  lessons INTEGER,                      -- request: deadline = requested date + N school days
  note TEXT,
  source TEXT NOT NULL DEFAULT 'app',   -- 'app' | 'mcp' | 'schoology_unsubmit'
  revision_at INTEGER,                  -- review: the latest_revision_at it covered (epoch s)
  closed_at TEXT,
  close_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resubmissions_one_open
  ON resubmissions(student_id, assignment_id) WHERE kind = 'request' AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_resubmissions_course ON resubmissions(course_id);
```

`server/db/index.js` — add after `backfillFirstSubmittedAt`:

```js
// Triage resubmissions (2026-10-03): the #49 'resubmit_requested' flag toggle
// becomes an open request (default 3 lessons from when it was set). Idempotent:
// only runs while such flags exist, and the flags are removed after the copy.
export function migrateResubmitFlags(database) {
  const flags = database.prepare(`
    SELECT f.id, f.student_id, f.assignment_id, f.created_at, a.course_id
    FROM flags f JOIN assignments a ON a.id = f.assignment_id
    WHERE f.flag_type = 'resubmit_requested' AND f.resolved = 0
  `).all();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons, source)
    VALUES (?, ?, ?, 'request', 'open', ?, 3, 'app')
  `);
  database.transaction(() => {
    for (const f of flags) insert.run(f.student_id, f.assignment_id, f.course_id, f.created_at);
    database.exec(`DELETE FROM flags WHERE flag_type = 'resubmit_requested'`);
  })();
}
```

and in `migrate(database)` after `backfillFirstSubmittedAt(database);` add `migrateResubmitFlags(database);`. (The partial unique index makes `INSERT OR IGNORE` skip a second open request for the same pair.)

`server/services/settings.js` — add to `TRIAGE_KEYS`:

```js
  // Resubmissions: default deadline (lessons = school days) when asking a student to resubmit.
  resubmitLessonsDefault: { def: 3, min: 1, max: 60 },
```

- [ ] **Step 4: Run** the same tests → PASS. Then `npx vitest run server` → PASS (a test that asserted the exact settings object may need `resubmitLessonsDefault: 3` added — update it).

- [ ] **Step 5: Commit** — `feat(db): resubmissions table, migrate resubmit flags, default-lessons setting`.

---

### Task 3: `resubmissions` service — actions, history, settle, per-pair lookups

**Files:**
- Create: `server/services/triageCommon.js` (moved helpers), `server/services/resubmissions.js`, `server/services/resubmissions.test.js`
- Modify: `server/services/triage.js` (import the moved helpers from `triageCommon.js` and re-export `TriageError`, `toneFor`, `makeUpTone`, `MAX_EXTENSION_LESSONS` so existing imports keep working)

**Interfaces:**
- Consumes: `resubmissionState`, `sqliteUtcToEpoch` (Task 1); table + `getTriageSettings().resubmitLessonsDefault` (Task 2); `loadCalendar(db)` → `{ between(from,to) → {days, approx}, addSchoolDays(date, n) → {date, approx} }`; `epochToLocalDate`, `todayLocal` from `server/lib/schoolDays.js`.
- Produces (`server/services/triageCommon.js`): `TriageError`, `toneFor`, `makeUpTone`, `currentCourses(db, courseId)`, `roster(db, courseId)`, `ALIGNED_SQL`, `fullName(st)`, `MAX_EXTENSION_LESSONS` — byte-for-byte moves from `triage.js`.
- Produces (`server/services/resubmissions.js`):
  - `requestResubmission(db, { studentId, assignmentId, lessons = null, note = null, source = 'app', requestedAt = null }) → historyRow`
  - `extendResubmission(db, id, lessons) → historyRow`
  - `closeResubmission(db, id, note = null) → historyRow`
  - `markResubmissionReviewed(db, { studentId, assignmentId, source = 'app' }) → historyRow` (the review row)
  - `undoResubmission(db, id) → { deleted: boolean }`
  - `listResubmissions(db, { courseId = null, studentId = null, since = null, id = null }) → historyRow[]` newest first
  - `settleResubmissions(db, { assignmentId = null } = {}) → number` (requests marked done)
  - `pairContext(db, studentId, assignmentId) → { grade, request, reviewedThrough }`
  - `resubmissionByStudent(db, assignmentId) → Map<studentId, { state, request: historyRow|null }>`
  - `openRequestKeys(db, courseId) → Set<'studentId:assignmentId'>`
  - historyRow = `{ id, kind, status, outcome ('asked'|'closed'|'done'|'reviewed'), studentId, studentName, assignmentId, schoologyAssignmentId, title, dueDate, courseId, courseName, blockNumber, requestedAt, requestedOn, lessons, until, note, source, revisionAt, closedAt, closeNote, createdAt, updatedAt }`
  - Errors (`TriageError` codes): `NOT_FOUND`, `NOT_ELIGIBLE`, `ALREADY_OPEN`, `BAD_LESSONS`, `NOT_ON_LIST`.

- [ ] **Step 1: Move helpers.** Create `server/services/triageCommon.js` containing, moved verbatim from `triage.js`: `TriageError`, `toneFor`, `makeUpTone`, `currentCourses`, `roster`, `ALIGNED_SQL`, `fullName`, `MAX_EXTENSION_LESSONS` (all `export`ed; `fullName` needs `import { preferredFirstName } from './studentNames.js'`). In `triage.js` replace them with:

```js
import { TriageError, toneFor, makeUpTone, currentCourses, roster, ALIGNED_SQL, fullName, MAX_EXTENSION_LESSONS } from './triageCommon.js';
export { TriageError, toneFor, makeUpTone, MAX_EXTENSION_LESSONS };
```

Run `npx vitest run server mcp` → PASS (pure refactor). Commit `refactor(triage): shared helpers in triageCommon.js`.

- [ ] **Step 2: Failing tests** — create `server/services/resubmissions.test.js` (fixture style copied from `triage.test.js`):

```js
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { addDays, isWeekday } from '../lib/schoolDays.js';
import { storeSchoolDays } from './schoolCalendar.js';
import { TriageError } from './triageCommon.js';
import {
  requestResubmission, extendResubmission, closeResubmission, markResubmissionReviewed, undoResubmission,
  listResubmissions, settleResubmissions, resubmissionByStudent, openRequestKeys,
} from './resubmissions.js';

const at = (iso) => Date.parse(`${iso}T04:00:00Z`) / 1000; // noon HKT
const sql = (iso) => `${iso} 04:00:00`;                     // same instant as SQLite UTC text

let db, courseId;
function seedCalendar() {
  const days = [];
  for (let d = '2026-09-01'; d <= '2026-10-30'; d = addDays(d, 1)) days.push({ date: d, inSession: isWeekday(d), cycleLetter: null, raw: '{}' });
  storeSchoolDays(db, days, '2026-10-01T00:00:00Z');
}
function student(uid, first, last) {
  const id = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, ?, ?)`).run(uid, first, last).lastInsertRowid;
  db.prepare(`INSERT INTO enrolments (student_id, course_id) VALUES (?, ?)`).run(id, courseId);
  return id;
}
function assignment(sid, title) {
  return db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, due_date, published) VALUES (?, ?, ?, '2026-10-05 15:30:00', 1)`)
    .run(courseId, sid, title).lastInsertRowid;
}
function grade(studentId, assignmentId, cols) {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(studentId, assignmentId, ...keys.map((k) => cols[k]));
}

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM resubmissions; DELETE FROM settings; DELETE FROM school_days; DELETE FROM grades; DELETE FROM assignment_assignees; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AIML')`).run().lastInsertRowid;
  seedCalendar();
});

describe('requestResubmission', () => {
  test('defaults to the settings lessons and returns the history row', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, note: 'redo the eval', requestedAt: sql('2026-10-12') });
    expect(r).toMatchObject({ kind: 'request', status: 'open', outcome: 'asked', lessons: 3, requestedOn: '2026-10-12', until: '2026-10-15', note: 'redo the eval', studentName: 'Maya Chen', title: 'Project' });
  });
  test('works on an ungraded pair (no grades row)', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    expect(() => requestResubmission(db, { studentId: s, assignmentId: a })).not.toThrow();
  });
  test('rejects a second open request, bad lessons, an untargeted student, an archived course', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    requestResubmission(db, { studentId: s, assignmentId: a });
    expect(() => requestResubmission(db, { studentId: s, assignmentId: a })).toThrow(expect.objectContaining({ code: 'ALREADY_OPEN' }));
    const a2 = assignment('a2', 'Other');
    expect(() => requestResubmission(db, { studentId: s, assignmentId: a2, lessons: 0 })).toThrow(expect.objectContaining({ code: 'BAD_LESSONS' }));
    const outsider = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES ('u9', 'No', 'One')`).run().lastInsertRowid;
    expect(() => requestResubmission(db, { studentId: outsider, assignmentId: a2 })).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    db.prepare('UPDATE courses SET archived = 1').run();
    expect(() => requestResubmission(db, { studentId: s, assignmentId: a2 })).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
  });
});

describe('extend / close / undo', () => {
  test('extend sets lessons; close records the note; undo deletes', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(extendResubmission(db, r.id, 5)).toMatchObject({ lessons: 5, until: '2026-10-19' });
    expect(closeResubmission(db, r.id, 'grade stands')).toMatchObject({ status: 'closed', outcome: 'closed', closeNote: 'grade stands' });
    expect(() => extendResubmission(db, r.id, 2)).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(undoResubmission(db, r.id)).toEqual({ deleted: true });
    expect(listResubmissions(db, {})).toEqual([]);
  });
});

describe('markResubmissionReviewed', () => {
  test('only for an arrived pair; marks a post-ask open request done', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, submitted_at: at('2026-10-08'), latest_revision_at: at('2026-10-06') });
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(() => markResubmissionReviewed(db, { studentId: s, assignmentId: a })).toThrow(expect.objectContaining({ code: 'NOT_ON_LIST' }));
    db.prepare('UPDATE grades SET latest_revision_at = ?').run(at('2026-10-14'));
    const review = markResubmissionReviewed(db, { studentId: s, assignmentId: a });
    expect(review).toMatchObject({ kind: 'review', outcome: 'reviewed', revisionAt: at('2026-10-14') });
    expect(listResubmissions(db, { id: r.id })[0].status).toBe('done');
  });
  test('Review Focus 2: an ask after an arrival is Waiting at once; only a post-ask revision arrives', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-08') }); // arrived
    expect(resubmissionByStudent(db, a).get(s).state).toBe('arrived');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(resubmissionByStudent(db, a).get(s).state).toBe('waiting');
    expect(() => markResubmissionReviewed(db, { studentId: s, assignmentId: a })).toThrow(expect.objectContaining({ code: 'NOT_ON_LIST' }));
    db.prepare('UPDATE grades SET latest_revision_at = ?').run(at('2026-10-13'));
    expect(resubmissionByStudent(db, a).get(s).state).toBe('arrived');
    expect(listResubmissions(db, { id: r.id })[0].status).toBe('open');
  });
  test('Review Focus 3: a newer revision after a review shows as arrived again', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, submitted_at: at('2026-10-06'), latest_revision_at: at('2026-10-08') });
    markResubmissionReviewed(db, { studentId: s, assignmentId: a });
    expect(resubmissionByStudent(db, a).get(s)?.state ?? null).toBe(null);
    db.prepare('UPDATE grades SET latest_revision_at = ?').run(at('2026-10-13'));
    expect(resubmissionByStudent(db, a).get(s).state).toBe('arrived');
  });
});

describe('settleResubmissions', () => {
  test('marks fulfilled requests done, leaves waiting ones', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 90, submitted_at: at('2026-10-15'), latest_revision_at: at('2026-10-14') });
    grade(s2, a, { score: 60, submitted_at: at('2026-10-08'), latest_revision_at: at('2026-10-06') });
    const r1 = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    const r2 = requestResubmission(db, { studentId: s2, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(settleResubmissions(db, { assignmentId: a })).toBe(1);
    expect(listResubmissions(db, { id: r1.id })[0]).toMatchObject({ status: 'done', outcome: 'done' });
    expect(listResubmissions(db, { id: r2.id })[0].status).toBe('open');
  });
});

describe('lookups', () => {
  test('openRequestKeys and resubmissionByStudent', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    const r = requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sql('2026-10-12') });
    expect(openRequestKeys(db, courseId)).toEqual(new Set([`${s}:${a}`]));
    expect(resubmissionByStudent(db, a).get(s)).toMatchObject({ state: 'waiting', request: { id: r.id, lessons: 3 } });
  });
});
```

- [ ] **Step 3: Run** `npx vitest run server/services/resubmissions.test.js` → FAIL (module missing).

- [ ] **Step 4: Implement** `server/services/resubmissions.js`:

```js
// Triage resubmissions (docs/superpowers/specs/2026-10-03-triage-resubmissions-design.md).
// Persistence + actions for asks ('request') and "Reviewed" marks ('review'), and
// the per-pair lookups the gradebook / assessment page / PrisMCP read. State rules
// live in server/lib/resubmission.js; the triage list rows in resubmissionRows().
import { loadCalendar } from './schoolCalendar.js';
import { getTriageSettings } from './settings.js';
import { preferredFirstName } from './studentNames.js';
import { TriageError, MAX_EXTENSION_LESSONS } from './triageCommon.js';
import { resubmissionState, sqliteUtcToEpoch } from '../lib/resubmission.js';
import { epochToLocalDate } from '../lib/schoolDays.js';

const OPEN_REQUEST = `kind = 'request' AND status = 'open'`;

function checkLessons(lessons) {
  const n = Number(lessons);
  if (!Number.isInteger(n) || n < 1 || n > MAX_EXTENSION_LESSONS) {
    throw new TriageError('BAD_LESSONS', `lessons must be a whole number from 1 to ${MAX_EXTENSION_LESSONS}`);
  }
  return n;
}

// A current-course assignment that targets an enrolled student.
function eligiblePair(db, studentId, assignmentId) {
  const st = db.prepare('SELECT id, schoology_uid FROM students WHERE id = ?').get(Number(studentId));
  if (!st) throw new TriageError('NOT_FOUND', `No student with id ${studentId}`);
  const a = db.prepare(`
    SELECT a.id, a.course_id, a.num_assignees, c.archived, c.excluded
    FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ?
  `).get(Number(assignmentId));
  if (!a) throw new TriageError('NOT_FOUND', `No assignment with id ${assignmentId}`);
  if (a.archived || a.excluded) throw new TriageError('NOT_ELIGIBLE', 'That assignment is not in a current course');
  const enrolled = db.prepare('SELECT 1 FROM enrolments WHERE student_id = ? AND course_id = ? AND dropped_at IS NULL').get(st.id, a.course_id);
  const assigned = !(a.num_assignees > 0)
    || db.prepare('SELECT 1 FROM assignment_assignees WHERE assignment_id = ? AND schoology_uid = ?').get(a.id, st.schoology_uid);
  if (!enrolled || !assigned) throw new TriageError('NOT_ELIGIBLE', 'That assignment does not target that student');
  return { student: st, assignment: a };
}

// The grade row, open request and newest review for one pair.
export function pairContext(db, studentId, assignmentId) {
  const grade = db.prepare(`
    SELECT score, exception, grade_comment, submitted_at, latest_revision_at, first_submitted_at, lti_submission_state
    FROM grades WHERE student_id = ? AND assignment_id = ?
  `).get(studentId, assignmentId) || {};
  const request = db.prepare(`SELECT * FROM resubmissions WHERE student_id = ? AND assignment_id = ? AND ${OPEN_REQUEST}`).get(studentId, assignmentId) || null;
  const reviewedThrough = db.prepare(`
    SELECT COALESCE(MAX(revision_at), 0) AS t FROM resubmissions WHERE student_id = ? AND assignment_id = ? AND kind = 'review'
  `).get(studentId, assignmentId).t;
  return { grade, request, reviewedThrough };
}

const stateOf = ({ grade, request, reviewedThrough }) =>
  resubmissionState(grade, { requestedAt: request ? sqliteUtcToEpoch(request.requested_at) : 0, reviewedThrough });

function outcomeOf(r) {
  if (r.kind === 'review') return 'reviewed';
  return { open: 'asked', closed: 'closed', done: 'done' }[r.status];
}

export function listResubmissions(db, { courseId = null, studentId = null, since = null, id = null } = {}) {
  const cal = loadCalendar(db);
  return db.prepare(`
    SELECT r.*, s.first_name, s.last_name, s.preferred_name, s.preferred_name_teacher,
           a.schoology_assignment_id, a.title, substr(a.due_date, 1, 10) AS due_date_only,
           c.course_name, c.block_number
    FROM resubmissions r
    JOIN students s ON s.id = r.student_id
    JOIN assignments a ON a.id = r.assignment_id
    JOIN courses c ON c.id = r.course_id
    WHERE (? IS NULL OR r.id = ?) AND (? IS NULL OR r.course_id = ?) AND (? IS NULL OR r.student_id = ?)
      AND (? IS NULL OR date(COALESCE(r.updated_at, r.closed_at, r.created_at), 'localtime') >= ?)
    ORDER BY COALESCE(r.updated_at, r.closed_at, r.created_at) DESC, r.id DESC
  `).all(id, id, courseId, courseId, studentId, studentId, since, since).map((r) => {
    const requestedOn = r.requested_at ? epochToLocalDate(sqliteUtcToEpoch(r.requested_at)) : null;
    return {
      id: r.id, kind: r.kind, status: r.status, outcome: outcomeOf(r),
      studentId: r.student_id,
      studentName: `${preferredFirstName(r)} ${r.last_name}`,
      assignmentId: r.assignment_id, schoologyAssignmentId: r.schoology_assignment_id, title: r.title,
      dueDate: r.due_date_only, courseId: r.course_id, courseName: r.course_name, blockNumber: r.block_number ?? null,
      requestedAt: r.requested_at, requestedOn, lessons: r.lessons,
      until: requestedOn && r.lessons ? cal.addSchoolDays(requestedOn, r.lessons).date : null,
      note: r.note, source: r.source, revisionAt: r.revision_at,
      closedAt: r.closed_at, closeNote: r.close_note, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  });
}

export function requestResubmission(db, { studentId, assignmentId, lessons = null, note = null, source = 'app', requestedAt = null } = {}) {
  const { student, assignment } = eligiblePair(db, studentId, assignmentId);
  const n = lessons == null || lessons === '' ? getTriageSettings(db).resubmitLessonsDefault : checkLessons(lessons);
  try {
    const id = db.prepare(`
      INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons, note, source)
      VALUES (?, ?, ?, 'request', 'open', COALESCE(?, datetime('now')), ?, ?, ?)
    `).run(student.id, assignment.id, assignment.course_id, requestedAt, n, note || null, source).lastInsertRowid;
    return listResubmissions(db, { id })[0];
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      throw new TriageError('ALREADY_OPEN', 'That student already has an open resubmission request for this assessment');
    }
    throw err;
  }
}

function openRequest(db, id) {
  const r = db.prepare('SELECT * FROM resubmissions WHERE id = ?').get(Number(id));
  if (!r) throw new TriageError('NOT_FOUND', `No resubmission record with id ${id}`);
  if (r.kind !== 'request' || r.status !== 'open') throw new TriageError('NOT_ELIGIBLE', 'Only an open request can be changed');
  return r;
}

export function extendResubmission(db, id, lessons) {
  const r = openRequest(db, id);
  db.prepare(`UPDATE resubmissions SET lessons = ?, updated_at = datetime('now') WHERE id = ?`).run(checkLessons(lessons), r.id);
  return listResubmissions(db, { id: r.id })[0];
}

export function closeResubmission(db, id, note = null) {
  const r = openRequest(db, id);
  db.prepare(`UPDATE resubmissions SET status = 'closed', closed_at = datetime('now'), close_note = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(note || null, r.id);
  return listResubmissions(db, { id: r.id })[0];
}

export function markResubmissionReviewed(db, { studentId, assignmentId, source = 'app' } = {}) {
  const { student, assignment } = eligiblePair(db, studentId, assignmentId);
  const ctx = pairContext(db, student.id, assignment.id);
  if (stateOf(ctx) !== 'arrived') throw new TriageError('NOT_ON_LIST', 'No resubmission has arrived for that student and assessment');
  const revisionAt = Number(ctx.grade.latest_revision_at) || 0;
  const id = db.transaction(() => {
    const newId = db.prepare(`
      INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, revision_at, source, closed_at)
      VALUES (?, ?, ?, 'review', 'done', ?, ?, datetime('now'))
    `).run(student.id, assignment.id, assignment.course_id, revisionAt, source).lastInsertRowid;
    // The arrival answered the ask only if it came in after the ask.
    if (ctx.request && revisionAt > sqliteUtcToEpoch(ctx.request.requested_at)) {
      db.prepare(`UPDATE resubmissions SET status = 'done', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(ctx.request.id);
    }
    return newId;
  })();
  return listResubmissions(db, { id })[0];
}

export function undoResubmission(db, id) {
  return { deleted: db.prepare('DELETE FROM resubmissions WHERE id = ?').run(Number(id)).changes > 0 };
}

// Mark open requests whose resubmission has been regraded/reviewed as done.
export function settleResubmissions(db, { assignmentId = null } = {}) {
  const open = db.prepare(`SELECT id, student_id, assignment_id FROM resubmissions WHERE ${OPEN_REQUEST} AND (? IS NULL OR assignment_id = ?)`)
    .all(assignmentId, assignmentId);
  const done = db.prepare(`UPDATE resubmissions SET status = 'done', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`);
  let n = 0;
  for (const r of open) {
    if (stateOf(pairContext(db, r.student_id, r.assignment_id)) === 'fulfilled') { done.run(r.id); n++; }
  }
  return n;
}

// student id → { state, request } for one assessment (local id) — the assessment
// page, get_assignment_context. Students with nothing to show are absent.
export function resubmissionByStudent(db, assignmentId) {
  const ids = db.prepare(`
    SELECT student_id FROM grades WHERE assignment_id = ? AND latest_revision_at > 0
    UNION SELECT student_id FROM resubmissions WHERE assignment_id = ?
  `).all(assignmentId, assignmentId).map((r) => r.student_id);
  const out = new Map();
  for (const sid of ids) {
    const ctx = pairContext(db, sid, assignmentId);
    const state = stateOf(ctx);
    if (state === null || state === 'fulfilled') continue;
    out.set(sid, { state, request: ctx.request ? listResubmissions(db, { id: ctx.request.id })[0] : null });
  }
  return out;
}

// 'studentId:assignmentId' pairs with an open request in a course — the gradebook tint.
export function openRequestKeys(db, courseId) {
  return new Set(db.prepare(`SELECT student_id, assignment_id FROM resubmissions WHERE course_id = ? AND ${OPEN_REQUEST}`)
    .all(courseId).map((r) => `${r.student_id}:${r.assignment_id}`));
}
```

Note `preferredFirstName(r)` reads `first_name`, `preferred_name`, `preferred_name_teacher` from the joined row (same as `listReferrals`).

- [ ] **Step 5: Run** `npx vitest run server/services/resubmissions.test.js` → PASS. Run `npx vitest run server` → PASS.

- [ ] **Step 6: Commit** — `feat(triage): resubmissions service — ask, extend, close, review, settle, lookups`.

---

### Task 4: `getTriage` — the Resubmissions list

**Files:**
- Modify: `server/services/resubmissions.js` (add `resubmissionRows`), `server/services/triage.js` (call it per course; output `resubmissions`, `counts.resubmissionsOverdue`, `resubmissionHistoryCount`)
- Test: `server/services/triage.test.js` (new `describe('resubmissions')`; add `DELETE FROM resubmissions;` to its `beforeEach`)

**Interfaces:**
- Consumes: Task 1 `resubmissionState`, `sqliteUtcToEpoch`; Task 3 `pairContext` pattern; `triageCommon` `toneFor`, `ALIGNED_SQL`, `fullName`.
- Produces:
  - `resubmissionRows(db, { course, students, cal, today, settings, formative, studentId }) → row[]` where `course = { id, course_name, block_number }`, `students` = `roster()` rows.
  - Triage row: `{ id (request id|null), state: 'waiting'|'arrived', studentId, studentUid, studentName, courseId, courseName, blockNumber, assignmentId, schoologyAssignmentId, title, aligned, day, limit, tone, approx, lessons, until, requestedOn, arrivedOn, source, afterDeadline, note }`
  - `getTriage(...)` adds `resubmissions` (arrived first by `day` desc, then waiting by `day` desc, then name), `counts.resubmissionsOverdue` (red rows), `resubmissionHistoryCount` (non-open records in scope).

- [ ] **Step 1: Failing tests** — in `server/services/triage.test.js`:

```js
import { requestResubmission, markResubmissionReviewed, closeResubmission } from './resubmissions.js';

describe('resubmissions list', () => {
  const sqlAt = (iso) => `${iso} 04:00:00`;
  test('waiting: day 1 = ask day, red after the lessons deadline', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'CP1', '2026-09-21');
    grade(s, a, { score: 60, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-09-21') });
    requestResubmission(db, { studentId: s, assignmentId: a, lessons: 3, requestedAt: sqlAt('2026-10-09') }); // Fri
    const t = getTriage(db, { today: TODAY }); // Fri 16/10: Mon 12 … Fri 16 = 5 school days after the ask
    expect(t.resubmissions).toHaveLength(1);
    expect(t.resubmissions[0]).toMatchObject({ state: 'waiting', day: 6, limit: 4, tone: 'red', until: '2026-10-14', requestedOn: '2026-10-09', lessons: 3 });
    expect(t.counts.resubmissionsOverdue).toBe(1);
  });
  test('arrived (unrequested, summative): clock from the resubmission date, feedback limit', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'CP1', '2026-09-21');
    grade(s, a, { score: 60, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-10-14') });
    const r = getTriage(db, { today: TODAY }).resubmissions[0];
    expect(r).toMatchObject({ state: 'arrived', id: null, arrivedOn: '2026-10-14', day: 3, limit: 10, tone: 'green', afterDeadline: false });
  });
  test('arrived after a red deadline is tagged afterDeadline; arrived sorts before waiting', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const a = assignment('a1', 'CP1', '2026-09-21');
    grade(s, a, { score: 60, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-10-15') });
    requestResubmission(db, { studentId: s, assignmentId: a, lessons: 1, requestedAt: sqlAt('2026-10-09') });
    requestResubmission(db, { studentId: s2, assignmentId: a, lessons: 3, requestedAt: sqlAt('2026-10-09') });
    const rows = getTriage(db, { today: TODAY }).resubmissions;
    expect(rows.map((r) => [r.studentName, r.state])).toEqual([['Maya Chen', 'arrived'], ['Ethan Wong', 'waiting']]);
    expect(rows[0].afterDeadline).toBe(true);
  });
  test('formative: unrequested arrivals only with includeFormative; asks always', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong');
    const f = assignment('f1', 'Warm-up', '2026-09-21', { summative: false });
    grade(s, f, { score: null, grade_comment: 'try again', submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-10-14') });
    requestResubmission(db, { studentId: s2, assignmentId: f, requestedAt: sqlAt('2026-10-15') });
    expect(getTriage(db, { today: TODAY, includeFormative: false }).resubmissions.map((r) => r.studentName)).toEqual(['Ethan Wong']);
    expect(getTriage(db, { today: TODAY, includeFormative: true }).resubmissions).toHaveLength(2);
  });
  test('reviewed / closed / excused rows do not show', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const s3 = student('u3', 'Zoe', 'Tan');
    const a = assignment('a1', 'CP1', '2026-09-21');
    grade(s, a, { score: 60, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-10-14') });
    markResubmissionReviewed(db, { studentId: s, assignmentId: a });
    const r2 = requestResubmission(db, { studentId: s2, assignmentId: a, requestedAt: sqlAt('2026-10-12') });
    closeResubmission(db, r2.id);
    grade(s3, a, { score: null, exception: 1, submitted_at: epoch('2026-09-25'), latest_revision_at: epoch('2026-10-14') });
    const t = getTriage(db, { today: TODAY });
    expect(t.resubmissions).toEqual([]);
    expect(t.resubmissionHistoryCount).toBe(2);
  });
  test('Review Focus 5: a dropped student or an archived course drops the row; history keeps it', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'CP1', '2026-09-21');
    requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sqlAt('2026-10-12') });
    db.prepare(`UPDATE enrolments SET dropped_at = '2026-10-13' WHERE student_id = ?`).run(s);
    expect(getTriage(db, { today: TODAY }).resubmissions).toEqual([]);
    db.prepare(`UPDATE enrolments SET dropped_at = NULL`).run();
    db.prepare(`UPDATE courses SET archived = 1`).run();
    expect(getTriage(db, { today: TODAY }).resubmissions).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM resubmissions').get().n).toBe(1);
  });
  test('studentId filter', () => {
    const s = student('u1', 'Maya', 'Chen'); const s2 = student('u2', 'Ethan', 'Wong'); const a = assignment('a1', 'CP1', '2026-09-21');
    requestResubmission(db, { studentId: s, assignmentId: a, requestedAt: sqlAt('2026-10-12') });
    requestResubmission(db, { studentId: s2, assignmentId: a, requestedAt: sqlAt('2026-10-12') });
    expect(getTriage(db, { today: TODAY, studentId: s2 }).resubmissions.map((r) => r.studentId)).toEqual([s2]);
  });
});
```

(Check `assignment()`'s `summative: false` option exists in this file's helper — it does: `{ summative = true, ... }`. The calendar in this file has 01/10 and 02/10 off; the ask on Fri 09/10 + 3 school days = Wed 14/10.)

- [ ] **Step 2: Run** `npx vitest run server/services/triage.test.js -t "resubmissions list"` → FAIL.

- [ ] **Step 3: Implement.** Add to `server/services/resubmissions.js`:

```js
import { toneFor, ALIGNED_SQL, fullName } from './triageCommon.js';

// Triage rows for one current course. Requests show whatever the alignment;
// unrequested arrivals follow Feedback owed (summative, or formative when shown).
export function resubmissionRows(db, { course, students, cal, today, settings, formative, studentId = null }) {
  const { feedbackLimitDays, warnLeadDays } = settings;
  const assignments = new Map(db.prepare(`
    SELECT a.id, a.schoology_assignment_id, a.title, a.num_assignees, ${ALIGNED_SQL} AS aligned
    FROM assignments a WHERE a.course_id = ? AND a.published = 1
  `).all(course.id).map((a) => [a.id, a]));
  const grades = new Map(db.prepare(`
    SELECT g.student_id, g.assignment_id, g.score, g.exception, g.grade_comment, g.submitted_at, g.latest_revision_at
    FROM grades g JOIN assignments a ON a.id = g.assignment_id WHERE a.course_id = ?
  `).all(course.id).map((g) => [`${g.student_id}:${g.assignment_id}`, g]));
  const requests = new Map(db.prepare(`SELECT * FROM resubmissions WHERE course_id = ? AND ${OPEN_REQUEST}`)
    .all(course.id).map((r) => [`${r.student_id}:${r.assignment_id}`, r]));
  const reviewed = new Map(db.prepare(`
    SELECT student_id, assignment_id, MAX(revision_at) AS t FROM resubmissions WHERE course_id = ? AND kind = 'review' GROUP BY 1, 2
  `).all(course.id).map((r) => [`${r.student_id}:${r.assignment_id}`, r.t]));
  const assigneesOf = (a) => (a.num_assignees > 0
    ? new Set(db.prepare('SELECT schoology_uid FROM assignment_assignees WHERE assignment_id = ?').all(a.id).map((r) => r.schoology_uid))
    : null);
  const assigneeCache = new Map();

  const rows = [];
  for (const st of students) {
    if (studentId != null && st.id !== Number(studentId)) continue;
    for (const a of assignments.values()) {
      const key = `${st.id}:${a.id}`;
      const grade = grades.get(key);
      const request = requests.get(key) || null;
      if (!request && !(grade?.latest_revision_at > 0)) continue;
      if (Number(grade?.exception) === 1) continue; // excused
      if (!request && !a.aligned && !formative) continue;
      if (!assigneeCache.has(a.id)) assigneeCache.set(a.id, assigneesOf(a));
      const assignees = assigneeCache.get(a.id);
      if (assignees && !assignees.has(st.schoology_uid)) continue;
      const requestedAt = request ? sqliteUtcToEpoch(request.requested_at) : 0;
      const state = resubmissionState(grade, { requestedAt, reviewedThrough: reviewed.get(key) || 0 });
      if (state !== 'waiting' && state !== 'arrived') continue;

      const requestedOn = request ? epochToLocalDate(requestedAt) : null;
      const until = request ? cal.addSchoolDays(requestedOn, request.lessons) : null;
      const arrivedOn = state === 'arrived' ? epochToLocalDate(grade.latest_revision_at) : null;
      const start = state === 'arrived' ? arrivedOn : requestedOn;
      const { days, approx } = cal.between(start, today);
      // Waiting: the deadline `until` is the last allowed date → last allowed day = lessons + 1.
      const limit = state === 'arrived' ? feedbackLimitDays : request.lessons + 1;
      rows.push({
        id: request?.id ?? null, state,
        studentId: st.id, studentUid: st.schoology_uid, studentName: fullName(st),
        courseId: course.id, courseName: course.course_name, blockNumber: course.block_number ?? null,
        assignmentId: a.id, schoologyAssignmentId: a.schoology_assignment_id, title: a.title, aligned: !!a.aligned,
        day: days + 1, limit, tone: toneFor(days, limit, warnLeadDays), approx: approx || !!until?.approx,
        lessons: request?.lessons ?? null, until: until?.date ?? null, requestedOn, arrivedOn,
        source: request?.source ?? null, note: request?.note ?? null,
        afterDeadline: !!(request && arrivedOn && arrivedOn > until.date),
      });
    }
  }
  return rows;
}
```

In `server/services/triage.js` `getTriage`: add `const resubmissions = [];` beside the other lists; inside the course loop after `const students = roster(db, c.id);` add:

```js
    resubmissions.push(...resubmissionRows(db, { course: c, students, cal, today, settings, formative, studentId }));
```

After the existing sorts:

```js
  // Arrived (to regrade) before waiting; then the longest clock; then name.
  resubmissions.sort((x, y) => (x.state === y.state ? 0 : x.state === 'arrived' ? -1 : 1)
    || y.day - x.day || x.studentName.localeCompare(y.studentName));
```

Compute the history count with the existing `courseIds`/`inScope`:

```js
  const resubmissionHistoryCount = courseIds.length
    ? db.prepare(`SELECT COUNT(*) AS n FROM resubmissions WHERE course_id IN (${inScope}) AND NOT (kind = 'request' AND status = 'open')`).get(...courseIds).n
    : 0;
```

and in the returned object add `resubmissions`, `resubmissionHistoryCount`, `counts.resubmissionsOverdue: resubmissions.filter((r) => r.tone === 'red').length`, and include `resubmissions` in the `approx` `.some` list. Import `resubmissionRows` from `./resubmissions.js`.

- [ ] **Step 4: Run** `npx vitest run server/services/triage.test.js` → PASS (all, including existing tests).

- [ ] **Step 5: Commit** — `feat(triage): Resubmissions list in getTriage`.

---

### Task 5: Sync — keep the REST grade time for LTI; auto-add unsubmits; settle

**Files:**
- Modify: `server/services/sync.js` (`upsertLtiStateWithTime`, the LTI write loop, end of `fullSync`), `server/services/resubmissions.js` (add `recordSchoologyUnsubmit`), `server/services/assessmentContext.js` (LTI `submitted_at` output + comment), `server/routes/mastery.js` (settle after `write-comment` and `send-all` local grade upserts)
- Test: `server/services/sync.test.js`, `server/services/resubmissions.test.js`, `server/services/assessmentContext.test.js`

**Interfaces:**
- Consumes: Task 3 `settleResubmissions`, `pairContext`; Task 2 setting.
- Produces: `recordSchoologyUnsubmit(db, { studentId, assignmentId, requestedAt = null }) → boolean` (true = inserted).

- [ ] **Step 1: Failing tests.**

`server/services/sync.test.js` — **change** the existing `'#125: a submitted lti student persists …'` test's expectations to:

```js
    const submitted = getGradeRow('701', 'L1');
    expect(submitted.submitted_at).toBe(0);                // REST grade time owns submitted_at (no REST grade here)
    expect(submitted.latest_revision_at).toBe(1747895340); // the grader submissionDate
    expect(submitted.first_submitted_at).toBe(1747895340);
    expect(submitted.late).toBe(1);
```

and add, in the same `describe`:

```js
  test('resubmissions: an LTI resubmission after grading is detectable (grade time kept)', async () => {
    getSectionEnrollments.mockResolvedValue([{ id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' }]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);
    getSectionGrades.mockResolvedValue([{ enrollment_id: '801', assignment_id: 'L1', grade: 80, exception: 0, timestamp: 2000, comment: '' }]);
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => ({ states: new Map([['701', 'submitted']]), details: new Map([['701', { submittedAt: 3000, late: 1 }]]) }),
    });
    const row = getGradeRow('701', 'L1');
    expect(row.submitted_at).toBe(2000);
    expect(row.latest_revision_at).toBe(3000);
  });

  test('resubmissions: graded LTI work seen back in progress is auto-added as an open request', async () => {
    getSectionEnrollments.mockResolvedValue([
      { id: '801', uid: '701', name_first: 'Ada', name_last: 'L', admin: '0' },
      { id: '802', uid: '702', name_first: 'Bo', name_last: 'M', admin: '0' },
    ]);
    getSectionAssignments.mockResolvedValue([
      { id: 'L1', title: 'OneDrive Essay', published: 1, allow_dropbox: '1', assignment_type: 'lti_submission' },
    ]);
    getSectionGrades.mockResolvedValue([
      { enrollment_id: '801', assignment_id: 'L1', grade: 80, exception: 0, timestamp: 2000, comment: '' },
      { enrollment_id: '802', assignment_id: 'L1', grade: 0, exception: 0, timestamp: 2000, comment: '' },
    ]);
    // Sync 1: Ada submitted (seeds first_submitted_at); Bo never submitted.
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => ({ states: new Map([['701', 'submitted'], ['702', 'in_progress']]), details: new Map([['701', { submittedAt: 1500, late: 0 }]]) }),
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM resubmissions').get().n).toBe(0);
    // Sync 2: the teacher unsubmitted Ada in Schoology.
    await syncSectionData(db, 'sec-G', courseId, new Date().toISOString(), {
      fetchDocuments: async () => ({ states: new Map([['701', 'in_progress'], ['702', 'in_progress']]), details: new Map() }),
    });
    const reqs = db.prepare(`SELECT r.*, s.schoology_uid FROM resubmissions r JOIN students s ON s.id = r.student_id`).all();
    expect(reqs).toHaveLength(1); // Review Focus 4: Bo (graded 0, never submitted) is not added
    expect(reqs[0]).toMatchObject({ schoology_uid: '701', kind: 'request', status: 'open', source: 'schoology_unsubmit', lessons: 3 });
  });
```

`server/services/resubmissions.test.js` — add:

```js
describe('recordSchoologyUnsubmit', () => {
  test('needs graded + earlier submission + in progress + no open request + current course', () => {
    const s = student('u1', 'Maya', 'Chen'); const a = assignment('a1', 'Project');
    grade(s, a, { score: 80, exception: 0, first_submitted_at: 100, lti_submission_state: 'in_progress' });
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a })).toBe(true);
    expect(recordSchoologyUnsubmit(db, { studentId: s, assignmentId: a })).toBe(false); // already open
    const s2 = student('u2', 'Ethan', 'Wong');
    grade(s2, a, { score: 0, exception: 0, first_submitted_at: 0, lti_submission_state: 'in_progress' });
    expect(recordSchoologyUnsubmit(db, { studentId: s2, assignmentId: a })).toBe(false);
  });
});
```

`server/services/assessmentContext.test.js` — add a case: an LTI assignment whose grade row has `submitted_at` 2000 and `latest_revision_at` 3000 returns the student's `submitted_at` as the ISO of 3000 (the submission time) and `latest_revision_at` ISO of 3000. (Follow the file's existing fixture helpers for building an assignment context.)

- [ ] **Step 2: Run** `npx vitest run server/services/sync.test.js server/services/resubmissions.test.js server/services/assessmentContext.test.js` → FAIL.

- [ ] **Step 3: Implement.**

`server/services/resubmissions.js`:

```js
// Sync (LTI pass): graded work Prism saw submitted that is back "in progress" was
// unsubmitted in Schoology → an open request (deadline = the default lessons from
// now). Students graded without ever submitting are skipped (first_submitted_at = 0).
export function recordSchoologyUnsubmit(db, { studentId, assignmentId, requestedAt = null }) {
  const live = db.prepare(`
    SELECT 1 FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ? AND c.archived = 0 AND c.excluded = 0
  `).get(assignmentId);
  if (!live) return false;
  const { grade, request } = pairContext(db, studentId, assignmentId);
  if (request) return false;
  if (grade.lti_submission_state !== 'in_progress') return false;
  if (grade.score == null || (Number(grade.exception) || 0) !== 0) return false;
  if (!(Number(grade.first_submitted_at) > 0)) return false;
  const courseId = db.prepare('SELECT course_id FROM assignments WHERE id = ?').get(assignmentId).course_id;
  db.prepare(`
    INSERT OR IGNORE INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons, source)
    VALUES (?, ?, ?, 'request', 'open', COALESCE(?, datetime('now')), ?, 'schoology_unsubmit')
  `).run(studentId, assignmentId, courseId, requestedAt, getTriageSettings(db).resubmitLessonsDefault);
  return true;
}
```

`server/services/sync.js`:
1. `upsertLtiStateWithTime` — change the INSERT column list to `(student_id, assignment_id, enrolment_id, score, max_score, lti_submission_state, latest_revision_at, first_submitted_at, late, synced_at)` with `VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`, and remove `submitted_at = excluded.submitted_at,` from its `DO UPDATE SET`. Replace its comment with: `// #125 + triage resubmissions: the grader submissionDate is the LATEST submission → latest_revision_at (+ earliest kept in first_submitted_at). submitted_at stays the REST grade time written by upsertGrade above, so latest_revision_at > submitted_at = resubmitted since graded (verified 2026-10-03, .claude/schoology-api-reference.md).`
2. Its `.run(...)` call — drop one `detail.submittedAt ?? 0` argument so the values are `studentRow.id, assignRow.id, String(e.id), assignRow.max_points ?? null, state, detail.submittedAt ?? 0, detail.submittedAt ?? 0, detail.late ?? 0, now`.
3. After `writeStates();` add:

```js
      // A graded student back in progress was unsubmitted in Schoology → chase the resubmission.
      for (const [uid, state] of stateMap) {
        if (state !== 'in_progress') continue;
        const studentRow = selectStudentByUid.get(String(uid));
        if (studentRow) recordSchoologyUnsubmit(db, { studentId: studentRow.id, assignmentId: assignRow.id });
      }
```

4. In `fullSync`, right after the `UPDATE sync_log SET status = 'completed'` statement: `settleResubmissions(db);`
5. Imports: `import { recordSchoologyUnsubmit, settleResubmissions } from './resubmissions.js';`

`server/services/assessmentContext.js` — where it emits `submitted_at: epochToIso(meta.submitted_at)`, use the submission time for LTI:

```js
      // Submission time (ISO). Native: the REST timestamp (submission/grade-entry).
      // LTI: the grader's submissionDate, stored in latest_revision_at — submitted_at
      // holds the REST grade time there (triage resubmissions, 2026-10-03).
      submitted_at: epochToIso(isLti ? meta.latest_revision_at : meta.submitted_at),
```

(`isLti` is already defined in that scope — it's emitted as `is_lti`; if it is defined after this line, move its declaration up.) Replace the stale comment block above it.

`server/routes/mastery.js` — import `settleResubmissions` from `../services/resubmissions.js`; at the end of the `write-comment` handler's successful local upsert and after `send-all`'s loop of local upserts, call `settleResubmissions(db, { assignmentId: assignmentRow.id })` (use the local assignment id variable each handler already resolves).

- [ ] **Step 4: Run** `npx vitest run server` → PASS.

- [ ] **Step 5: Commit** — `fix(sync): keep the REST grade time for LTI so resubmissions show; auto-add Schoology unsubmits`.

---

### Task 6: HTTP routes + readers move from `flags`

**Files:**
- Modify: `server/routes/triage.js`, `server/routes/flags.js`, `server/routes/courses.js`, `server/routes/mastery.js` (GET `/:courseId/assignment/:assignmentId`), `server/routes/students.js`, `server/services/assessmentContext.js` (`getFlagsByStudent` + per-student `resubmission`)
- Test: `server/routes/triage.test.js`, `server/routes/flags.test.js`, `server/routes/courses.test.js`, `server/routes/mastery.test.js`, `server/services/assessmentContext.test.js`

**Interfaces:**
- Consumes: Task 3 functions.
- Produces (HTTP):
  - `GET /api/triage/resubmissions?courseId=` → historyRow[]
  - `POST /api/triage/resubmissions` `{ studentId, assignmentId, lessons?, note? }` → 201 historyRow
  - `PUT /api/triage/resubmissions/:id` `{ lessons }` → extend, or `{ close: true, note? }` → close; 200 historyRow
  - `POST /api/triage/resubmissions/review` `{ studentId, assignmentId }` → 201 review historyRow
  - `DELETE /api/triage/resubmissions/:id` → `{ deleted }`
  - `STATUS` map gains `ALREADY_OPEN: 409`.
  - `POST /api/flags` with `flag_type: 'resubmit_requested'` → 201 with the request historyRow (no flag row written).
  - Mastery assignment payload per student: `resubmit_flag: { id } | null` (open request id), new `resubmission: { state, request } | null`.
  - Gradebook grade cells: `resubmit_requested` from `openRequestKeys`.
  - Student page `flags`: open requests appended as `{ id: 'resubmission-<id>', student_id, assignment_id, flag_type: 'resubmit_requested', resolved: 0, created_at }`.
  - `get_assignment_context` students: `flags.resubmit_requested` from open requests; new `resubmission: { state, deadline, source } | null`.

- [ ] **Step 1: Failing tests** (supertest pattern as in `server/routes/triage.test.js`):

```js
describe('resubmission routes', () => {
  test('ask → list → extend → close → undo', async () => {
    const { s, a } = seedPair(); // use the file's existing fixture helpers to make an enrolled student + current-course assignment
    const asked = await request(app).post('/api/triage/resubmissions').send({ studentId: s, assignmentId: a, lessons: 2, note: 'redo' });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ outcome: 'asked', lessons: 2, note: 'redo' });
    expect((await request(app).post('/api/triage/resubmissions').send({ studentId: s, assignmentId: a })).status).toBe(409);
    expect((await request(app).put(`/api/triage/resubmissions/${asked.body.id}`).send({ lessons: 4 })).body.lessons).toBe(4);
    expect((await request(app).put(`/api/triage/resubmissions/${asked.body.id}`).send({ close: true, note: 'stands' })).body.outcome).toBe('closed');
    expect((await request(app).get('/api/triage/resubmissions')).body).toHaveLength(1);
    expect((await request(app).delete(`/api/triage/resubmissions/${asked.body.id}`)).body).toEqual({ deleted: true });
  });
  test('review rejects a pair with nothing arrived (409)', async () => {
    const { s, a } = seedPair();
    expect((await request(app).post('/api/triage/resubmissions/review').send({ studentId: s, assignmentId: a })).status).toBe(409);
  });
});
```

`server/routes/flags.test.js`: `POST /api/flags { student_id, assignment_id, flag_type: 'resubmit_requested' }` → 201, `body.outcome === 'asked'`, and `SELECT COUNT(*) FROM flags WHERE flag_type='resubmit_requested'` is 0, `SELECT COUNT(*) FROM resubmissions` is 1. Update any existing test that expected a flag row for `resubmit_requested`.

`server/routes/courses.test.js` / `mastery.test.js`: an open request makes the gradebook cell `resubmit_requested: true` and the assessment student `resubmit_flag: { id }` + `resubmission.state === 'waiting'`. Update existing tests that seeded a `resubmit_requested` flag to seed `requestResubmission(db, …)` instead.

`server/services/assessmentContext.test.js`: open request → `flags.resubmit_requested === true` and `resubmission: { state: 'waiting', deadline: <until>, source: 'app' }`.

- [ ] **Step 2: Run** `npx vitest run server/routes server/services/assessmentContext.test.js` → FAIL.

- [ ] **Step 3: Implement.**

`server/routes/triage.js` — import `listResubmissions, requestResubmission, extendResubmission, closeResubmission, markResubmissionReviewed, undoResubmission` from `../services/resubmissions.js`; add `ALREADY_OPEN: 409` to `STATUS`; add:

```js
// Resubmissions (asks + "Reviewed" marks). GET = history, newest first.
router.get('/resubmissions', (req, res) => {
  res.json(listResubmissions(getDb(), { courseId: req.query.courseId ?? null }));
});

// POST /api/triage/resubmissions — { studentId, assignmentId, lessons?, note? } (lessons default: settings)
router.post('/resubmissions', (req, res) => {
  const { studentId, assignmentId, lessons, note } = req.body || {};
  write(res, () => requestResubmission(getDb(), { studentId, assignmentId, lessons, note, source: 'app' }));
});

// POST /api/triage/resubmissions/review — { studentId, assignmentId }: looked at, grade stands.
router.post('/resubmissions/review', (req, res) => {
  const { studentId, assignmentId } = req.body || {};
  write(res, () => markResubmissionReviewed(getDb(), { studentId, assignmentId, source: 'app' }));
});

// PUT /api/triage/resubmissions/:id — { lessons } extends; { close: true, note? } closes.
router.put('/resubmissions/:id', (req, res) => {
  const { lessons, close, note } = req.body || {};
  write(res, () => (close
    ? closeResubmission(getDb(), req.params.id, note)
    : extendResubmission(getDb(), req.params.id, lessons)), 200);
});

// DELETE /api/triage/resubmissions/:id — undo an ask or a review.
router.delete('/resubmissions/:id', (req, res) => {
  res.json(undoResubmission(getDb(), req.params.id));
});
```

`server/routes/flags.js` — at the top of `POST`, after computing `type`:

```js
  // #49's toggle is now a triage resubmission request (default lessons).
  if (type === 'resubmit_requested') {
    if (!assignment_id) return res.status(400).json({ error: 'assignment_id is required for resubmit_requested flags' });
    try {
      return res.status(201).json(requestResubmission(db, { studentId: student_id, assignmentId: assignment_id, source: 'app' }));
    } catch (err) {
      if (err instanceof TriageError) return res.status(err.code === 'NOT_FOUND' ? 404 : 409).json({ error: err.message, code: err.code });
      throw err;
    }
  }
```

(imports: `requestResubmission` from `../services/resubmissions.js`, `TriageError` from `../services/triageCommon.js`; remove the old `resubmit_requested` assignment_id check further down.)

`server/routes/courses.js` — replace the `resubmitFlags` query + `resubmitSet` with `const resubmitSet = openRequestKeys(db, Number(req.params.id));`.

`server/routes/mastery.js` (GET assignment) — replace the `resubmitFlagRows`/`resubmitFlagMap` block with:

```js
  // Triage resubmissions: open request (the card's pill) + derived state.
  const resubmissionMap = assignmentRow ? resubmissionByStudent(db, assignmentRow.id) : new Map();
```

and in the student mapping: `resubmit_flag: resubmissionMap.get(s.id)?.request ? { id: resubmissionMap.get(s.id).request.id } : null,` plus `resubmission: resubmissionMap.get(s.id) || null,`.

`server/routes/students.js` — after loading `flags`, append open requests:

```js
  // Open resubmission requests (triage) still read as 'resubmit_requested' badges.
  const requests = db.prepare(`
    SELECT id, student_id, assignment_id, created_at FROM resubmissions
    WHERE student_id = ? AND kind = 'request' AND status = 'open'
  `).all(req.params.id).map((r) => ({ id: `resubmission-${r.id}`, student_id: r.student_id, assignment_id: r.assignment_id, flag_type: 'resubmit_requested', flag_reason: null, resolved: 0, created_at: r.created_at }));
```

and return `flags: [...flags, ...requests]` (match the variable the handler already returns).

`server/services/assessmentContext.js` — `getFlagsByStudent`: query only `review_needed` from `flags`, then set `resubmit_requested = true` for students with an open request (`SELECT student_id FROM resubmissions WHERE assignment_id = ? AND kind='request' AND status='open'`). In the per-student object add:

```js
      resubmission: (() => {
        const r = resubmissions.get(st.id);
        return r ? { state: r.state, deadline: r.request?.until ?? null, source: r.request?.source ?? null } : null;
      })(),
```

with `const resubmissions = resubmissionByStudent(db, assignmentRow.id);` computed once next to `flagsByStudent`.

- [ ] **Step 4: Run** `npx vitest run server mcp` → PASS.

- [ ] **Step 5: Commit** — `feat(triage): resubmission routes; gradebook/assessment/student readers use the new table`.

---

### Task 7: PrisMCP tools

**Files:**
- Modify: `mcp/handlers.js`, `mcp/server.js`
- Test: `mcp/handlers.test.js`, `mcp/server.test.js`

**Interfaces:**
- Consumes: Task 3/4.
- Produces handlers: `requestResubmissionTool(db, { student_id, assignment_id, lessons, note })`, `closeResubmissionTool(db, { id, note })`, `markResubmissionReviewedTool(db, { student_id, assignment_id })`, `listResubmissionsTool(db, { course, student, since, state })`; `extendDeadlineTool` accepts `resubmission_id`; `getTriageTool` filters `resubmissions` by `student` and recomputes `counts.resubmissionsOverdue`.

- [ ] **Step 1: Failing tests** — `mcp/handlers.test.js`:

```js
describe('resubmission tools', () => {
  test('request → list → extend via extend_deadline → close', () => {
    const { studentId, assignmentId } = seedTriagePair(db); // reuse/extend the file's triage fixture: enrolled student + current-course assignment
    const r = requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId, lessons: 2, note: 'fix tests' });
    expect(r).toMatchObject({ outcome: 'asked', source: 'mcp', lessons: 2 });
    expect(listResubmissionsTool(db, { state: 'asked' })).toHaveLength(1);
    expect(extendDeadlineTool(db, { resubmission_id: r.id, lessons: 5 })).toMatchObject({ lessons: 5 });
    expect(closeResubmissionTool(db, { id: r.id, note: 'grade stands' })).toMatchObject({ outcome: 'closed' });
  });
  test('get_triage student filter applies to resubmissions', () => {
    const { studentId, assignmentId } = seedTriagePair(db);
    requestResubmissionTool(db, { student_id: studentId, assignment_id: assignmentId });
    expect(getTriageTool(db, { student: 'nobody-matches' }).resubmissions).toEqual([]);
  });
});
```

`mcp/server.test.js`: `listTools()` includes `request_resubmission`, `close_resubmission`, `mark_resubmission_reviewed`, `list_resubmissions`.

- [ ] **Step 2: Run** `npx vitest run mcp` → FAIL.

- [ ] **Step 3: Implement** in `mcp/handlers.js`:

```js
import {
  requestResubmission, extendResubmission, closeResubmission, markResubmissionReviewed, listResubmissions,
} from '../server/services/resubmissions.js';

export function requestResubmissionTool(db, { student_id, assignment_id, lessons, note } = {}) {
  return requestResubmission(db, { studentId: student_id, assignmentId: assignment_id, lessons: lessons ?? null, note, source: 'mcp' });
}
export function closeResubmissionTool(db, { id, note } = {}) {
  return closeResubmission(db, id, note);
}
export function markResubmissionReviewedTool(db, { student_id, assignment_id } = {}) {
  return markResubmissionReviewed(db, { studentId: student_id, assignmentId: assignment_id, source: 'mcp' });
}
// state: 'asked' (open) | 'closed' | 'done' | 'reviewed'
export function listResubmissionsTool(db, { course, student, since, state } = {}) {
  const rows = listResubmissions(db, { courseId: resolveCourseRef(db, course), since: since || null });
  return rows.filter((r) => (state ? r.outcome === state : true))
    .filter((r) => (student != null && student !== '' ? matchesStudent(r, student) : true));
}
```

Change `extendDeadlineTool`:

```js
export function extendDeadlineTool(db, { student_id, assignment_id, lessons, note, resubmission_id } = {}) {
  if (resubmission_id != null) return extendResubmission(db, resubmission_id, lessons);
  return recordExtension(db, { studentId: student_id, assignmentId: assignment_id, lessons, note, source: 'mcp' });
}
```

In `getTriageTool`'s student branch add `t.resubmissions = t.resubmissions.filter((r) => matchesStudent(r, student));` and `t.counts.resubmissionsOverdue = t.resubmissions.filter((r) => r.tone === 'red').length;`.

`mcp/server.js` — register (after `undo_extension`), each wrapping the handler with `text(...)`:

```js
  server.registerTool(
    'request_resubmission',
    {
      description: "Ask a student to resubmit one assessment, with a deadline in lessons (SCHOOL days; default = the teacher's setting, 3). ONLY when the teacher explicitly asks. Works on graded, comment-only or ungraded work. The pair then shows in get_triage resubmissions as 'waiting' (day 1 = the ask day, red after the deadline `until`) until a resubmission arrives ('arrived'), then clears when it is regraded or marked reviewed. Rejects a second open request (ALREADY_OPEN). Prism-only: nothing is written to Schoology.",
      inputSchema: {
        student_id: z.number().describe('Student id (list_students / get_triage rows)'),
        assignment_id: z.number().describe('Assignment id (list_assignments / get_triage rows)'),
        lessons: z.number().int().min(1).max(60).optional().describe('Deadline in lessons (school days) from today'),
        note: z.string().optional().describe('What to fix, e.g. "add the evaluation section"'),
      },
    },
    async (args) => text(requestResubmissionTool(getDb(), args))
  );

  server.registerTool(
    'close_resubmission',
    {
      description: 'Close an open resubmission request (the original grade stands), e.g. a no-show past its deadline. Only when the teacher asks. id from get_triage resubmissions[].id or list_resubmissions.',
      inputSchema: { id: z.number().describe('Resubmission request id'), note: z.string().optional().describe('Optional reason') },
    },
    async (args) => text(closeResubmissionTool(getDb(), args))
  );

  server.registerTool(
    'mark_resubmission_reviewed',
    {
      description: "Mark an arrived resubmission as reviewed with the grade standing (no regrade needed). Only when the teacher says so. Clears the 'arrived' row; a later resubmission shows again. Rejects pairs with nothing arrived (NOT_ON_LIST).",
      inputSchema: { student_id: z.number(), assignment_id: z.number() },
    },
    async (args) => text(markResubmissionReviewedTool(getDb(), args))
  );

  server.registerTool(
    'list_resubmissions',
    {
      description: "Resubmission history, newest first: asks ('asked' = open, with lessons/until/note; 'closed' = grade stood; 'done' = resubmitted and regraded/reviewed) and 'reviewed' marks. source 'schoology_unsubmit' = auto-added because the teacher unsubmitted graded OneDrive work in Schoology.",
      inputSchema: {
        course: z.union([z.number(), z.string()]).optional(),
        student: z.union([z.number(), z.string()]).optional(),
        since: z.string().optional().describe("'YYYY-MM-DD'"),
        state: z.enum(['asked', 'closed', 'done', 'reviewed']).optional(),
      },
    },
    async (args) => text(listResubmissionsTool(getDb(), args))
  );
```

Extend `extend_deadline`'s `inputSchema` with `resubmission_id: z.number().optional().describe('Extend an open resubmission request (get_triage resubmissions[].id) instead of an assignment deadline; then only lessons is used')`, make `student_id`/`assignment_id` `.optional()`, and append to its description: ' With resubmission_id: moves that request\'s deadline to N lessons after the ask.' Append to `get_triage`'s description: `'resubmissions: per student × assessment — state "waiting" (asked to resubmit; day 1 = the ask day; limit = lessons + 1, red after `until`; source schoology_unsubmit = the teacher unsubmitted OneDrive work) or "arrived" (a resubmission newer than the last feedback; day 1 = the resubmission date, overdue after day {feedbackLimitDays}; afterDeadline = came in after the ask deadline). Explicit asks show for any alignment; unrequested arrivals follow include_formative. '`. Update the handlers' import list in `server.js`.

- [ ] **Step 4: Run** `npx vitest run mcp` → PASS.

- [ ] **Step 5: Commit** — `feat(prismcp): resubmission tools`.

---

### Task 8: Client — Resubmissions panel, history, rail wiring

**Files:**
- Modify: `client/src/services/api.js`, `client/src/components/triage/TriageSection.jsx`, `client/src/components/triage/ReferralHistory.jsx`, `client/src/app.css` (only if a new class is needed — reuse `.triage-row*` first)
- Create: `client/src/components/triage/ResubmissionsPanel.jsx`
- Test: `client/src/components/triage/TriageSection.test.jsx`

**Interfaces:**
- Consumes: Task 6 routes; Task 4 row shape.
- Produces (api.js): `getResubmissions({ courseId })`, `requestResubmission(body)`, `updateResubmission(id, body)`, `reviewResubmission(body)`, `undoResubmission(id)`. `ReferralHistory` gains prop `mode = 'late' | 'resubmissions'`.

- [ ] **Step 1: api.js** — after the extensions block:

```js
// Resubmissions (asks + "Reviewed" marks).
export const getResubmissions = ({ courseId } = {}) =>
  request(`/triage/resubmissions${courseId != null ? `?courseId=${courseId}` : ''}`);
export const requestResubmission = (body) => request('/triage/resubmissions', { method: 'POST', body: JSON.stringify(body) });
export const updateResubmission = (id, body) => request(`/triage/resubmissions/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const reviewResubmission = (body) => request('/triage/resubmissions/review', { method: 'POST', body: JSON.stringify(body) });
export const undoResubmission = (id) => request(`/triage/resubmissions/${id}`, { method: 'DELETE' });
```

- [ ] **Step 2: Failing tests** — in `TriageSection.test.jsx` add the new api fns to the `vi.mock` factory (`getResubmissions, updateResubmission, reviewResubmission, undoResubmission`), and:

```js
const RESUB = [
  { id: null, state: 'arrived', studentId: 11, studentName: 'Lena Ho', courseId: 5, courseName: 'AIML', assignmentId: 30, schoologyAssignmentId: 'r30', title: 'Launch - Design', day: 3, limit: 10, tone: 'green', approx: false, lessons: null, until: null, requestedOn: null, arrivedOn: '2026-10-14', source: null, afterDeadline: false, note: null },
  { id: 41, state: 'waiting', studentId: 12, studentName: 'Ravi Shah', courseId: 5, courseName: 'AIML', assignmentId: 30, schoologyAssignmentId: 'r30', title: 'Launch - Design', day: 6, limit: 4, tone: 'red', approx: false, lessons: 3, until: '2026-10-14', requestedOn: '2026-10-09', arrivedOn: null, source: 'schoology_unsubmit', afterDeadline: false, note: null },
];

describe('Resubmissions panel', () => {
  it('is hidden when there are no resubmission rows', async () => {
    renderSection();
    await latePanel();
    expect(screen.queryByLabelText('Resubmissions')).toBeNull();
  });
  it('lists arrived then waiting, with tags, and wires Reviewed / Close / Extend', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, resubmissions: RESUB, resubmissionHistoryCount: 2, counts: { resubmissionsOverdue: 1 } });
    api.reviewResubmission.mockResolvedValue({}); api.updateResubmission.mockResolvedValue({});
    renderSection();
    const panel = await screen.findByLabelText('Resubmissions');
    const names = within(panel).getAllByRole('link').map((l) => l.textContent);
    expect(names).toEqual(['Lena Ho', 'Ravi Shah']);
    expect(within(panel).getByText('↩ arrived')).toBeTruthy();
    expect(within(panel).getByText('unsubmitted in Schoology')).toBeTruthy();
    expect(within(panel).getByText('1 overdue')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Reviewed' }));
    await waitFor(() => expect(api.reviewResubmission).toHaveBeenCalledWith({ studentId: 11, assignmentId: 30 }));

    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    fireEvent.change(within(panel).getByLabelText('Close note'), { target: { value: 'grade stands' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm close' }));
    await waitFor(() => expect(api.updateResubmission).toHaveBeenCalledWith(41, { close: true, note: 'grade stands' }));
  });
  it('row names link to the student card on the assessment page', async () => {
    api.getTriage.mockResolvedValue({ ...PAYLOAD, resubmissions: RESUB, counts: {} });
    renderSection();
    const panel = await screen.findByLabelText('Resubmissions');
    expect(within(panel).getByRole('link', { name: 'Lena Ho' }).getAttribute('href')).toBe('/course/5/assessment/r30?student=11');
  });
});
```

- [ ] **Step 3: Run** `cd client && npx vitest run src/components/triage/TriageSection.test.jsx` → FAIL.

- [ ] **Step 4: Implement** `client/src/components/triage/ResubmissionsPanel.jsx`:

```jsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyRing from './UrgencyRing.jsx';
import CourseLine from './CourseLine.jsx';
import ExtendEditor from './ExtendEditor.jsx';
import { PanelHead, ShowAllToggle, useShowAll, limitRows } from './panelParts.jsx';
import ReferralHistory from './ReferralHistory.jsx';
import { formatDate } from '../../lib/formatDate.js';

// Resubmissions: per student × assessment. "arrived" = a resubmission newer than
// the last feedback (day 1 = its date, regrade by day feedbackLimitDays); "waiting"
// = asked to resubmit (day 1 = the ask, deadline `until`). Arrived rows: Reviewed
// (grade stands). Waiting rows: Close (grade stands, optional note) + Extend.
// Hidden when empty. Row names open the student's card on the assessment page.
export const cardLink = (r) => `/course/${r.courseId}/assessment/${r.schoologyAssignmentId}?student=${r.studentId}`;
const left = (r) => (r.limit - r.day > 0 ? `${r.limit - r.day} left` : 'last day');

export default function ResubmissionsPanel({
  rows, settings, showCourse, scope, onReview, onClose, onExtend, historyCount,
  historyOpen, onToggleHistory, courseId, historyVersion, onCloseHistory, onHistoryChanged,
}) {
  const [open, setOpen] = useState(null); // { key, mode: 'extend' | 'close' }
  const [closeNote, setCloseNote] = useState('');
  const [showAll, toggleShowAll] = useShowAll(`resub.${scope}`);
  if (rows.length === 0 && !historyOpen) return null;
  const overdue = rows.filter((r) => r.tone === 'red').length;
  const key = (r) => `${r.studentId}:${r.assignmentId}`;

  return (
    <section className="card triage-panel" aria-label="Resubmissions">
      <PanelHead title="Resubmissions" badge={overdue > 0 && <span className="badge badge-red">{overdue} overdue</span>}>
        <ShowAllToggle total={rows.length} showAll={showAll} onToggle={toggleShowAll} />
      </PanelHead>
      <p className="triage-panel__sub">asked = day 1 · regrade by day {settings.feedbackLimitDays}</p>
      {limitRows(rows, showAll).map((r) => {
        const k = key(r);
        const mode = open?.key === k ? open.mode : null;
        return (
          <div key={k} className="triage-row">
            <UrgencyRing day={r.day} limit={r.limit} tone={r.tone} approx={r.approx} size={28} />
            <div className="triage-row__text">
              <div className="triage-row__line">
                <Link to={cardLink(r)} className="triage-row__name" title={r.studentName}>{r.studentName}</Link>
                {r.state === 'arrived'
                  ? <span className="badge badge-resubmitted triage-row__tag">↩ arrived</span>
                  : <span className="badge badge-resubmit triage-row__tag" title={r.note || undefined}>⟳ by {formatDate(`${r.until}T00:00:00`)}</span>}
                {r.source === 'schoology_unsubmit' && <span className="badge badge-gray triage-row__tag">unsubmitted in Schoology</span>}
                {r.afterDeadline && <span className="badge badge-amber triage-row__tag">after deadline</span>}
              </div>
              {showCourse && <CourseLine row={r} />}
              <div className="triage-row__task" title={r.title}>{r.title}</div>
            </div>
            <div className="triage-row__actions">
              {r.state === 'arrived' ? (
                <button className="primary btn-sm" onClick={() => onReview(r)}>Reviewed</button>
              ) : (
                <>
                  {r.tone === 'red'
                    ? <button className="primary btn-sm" onClick={() => { setCloseNote(''); setOpen({ key: k, mode: 'close' }); }}>Close</button>
                    : <span className="text-sm text-muted">{left(r)}</span>}
                  <button className="secondary btn-sm" onClick={() => setOpen(mode === 'extend' ? null : { key: k, mode: 'extend' })}>Extend</button>
                  {r.tone !== 'red' && (
                    <button className="ghost btn-sm" onClick={() => { setCloseNote(''); setOpen({ key: k, mode: 'close' }); }}>Close</button>
                  )}
                </>
              )}
            </div>
            {mode === 'extend' && (
              <div className="triage-row__more">
                <ExtendEditor
                  extension={{ lessons: r.lessons, note: '' }}
                  onSave={(lessons) => { onExtend(r, lessons); setOpen(null); }}
                  onCancel={() => setOpen(null)}
                />
              </div>
            )}
            {mode === 'close' && (
              <div className="triage-row__more">
                <input className="triage-note" placeholder="Note (optional)" aria-label="Close note" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
                <button className="secondary btn-sm" aria-label="Confirm close" onClick={() => { onClose(r, closeNote); setOpen(null); }}>Close request</button>
                <button className="ghost" onClick={() => setOpen(null)}>Cancel</button>
              </div>
            )}
          </div>
        );
      })}
      <button className="ghost triage-panel__history" aria-expanded={historyOpen} onClick={onToggleHistory}>
        Closed / reviewed ({historyCount}) ›
      </button>
      {historyOpen && (
        <ReferralHistory mode="resubmissions" courseId={courseId} version={historyVersion} onClose={onCloseHistory} onChanged={onHistoryChanged} />
      )}
    </section>
  );
}
```

Note: the Extend editor saves `lessons` counted from the **ask day** (same meaning as the server's `extendResubmission`); `ExtendEditor`'s note field is ignored here.

`ReferralHistory.jsx` — add `mode = 'late'` prop. When `mode === 'resubmissions'`: load `getResubmissions({ courseId })` only (rows tagged `kind: 'resubmission'`), title "Resubmissions", empty text "No resubmission records yet.", aria-label "Resubmission history", undo via `undoResubmission(r.id)`, and the badge:

```jsx
const RESUB_LABEL = { asked: 'Asked', closed: 'Closed', done: 'Resubmitted', reviewed: 'Reviewed' };
// …
: r.kind === 'resubmission'
  ? <span className="badge badge-resubmit">{RESUB_LABEL[r.outcome]}{r.outcome === 'asked' && r.until ? ` · by ${formatDate(`${r.until}T00:00:00`)}` : ''}</span>
```

Use `const recordedAt = (r) => r.updatedAt || r.closedAt || r.createdAt;` for sorting/dates (covers both shapes), and show `r.closeNote || r.note` after the date.

`TriageSection.jsx` — import the panel and api fns; add state `const [showResubHistory, setShowResubHistory] = useState(false);`; handlers:

```js
  const handleReview = (row) => write(() => reviewResubmission({ studentId: row.studentId, assignmentId: row.assignmentId }));
  const handleCloseResub = (row, note) => write(() => updateResubmission(row.id, { close: true, note }));
  const handleExtendResub = (row, lessons) => write(() => updateResubmission(row.id, { lessons }));
```

and render between `LateWorkPanel` and `FeedbackOwedPanel`:

```jsx
      <ResubmissionsPanel
        rows={data.resubmissions ?? []} settings={data.settings} showCourse={showCourse} scope={scope}
        onReview={handleReview} onClose={handleCloseResub} onExtend={handleExtendResub}
        historyCount={data.resubmissionHistoryCount ?? 0}
        historyOpen={showResubHistory} onToggleHistory={() => setShowResubHistory((v) => !v)}
        courseId={courseId} historyVersion={historyVersion}
        onCloseHistory={() => setShowResubHistory(false)} onHistoryChanged={load}
      />
```

Update the rail comment at the top of `TriageSection.jsx` to name the 4th panel. If `.badge-resubmit` / `.badge-resubmitted` classes don't exist in `app.css` (check `grep -n "badge-resubmit" client/src/app.css`), add them using `var(--badge-resubmit-bg)` / `var(--badge-resubmit-text)` / `var(--resubmit-ring)`.

- [ ] **Step 5: Run** `cd client && npx vitest run src/components/triage` → PASS.

- [ ] **Step 6: Commit** — `feat(triage-ui): Resubmissions panel and history`.

---

### Task 8b: Client — Dashboard chip + course-page Triage count include resubmissions

**Files:**
- Modify: `client/src/lib/triage.js`, `client/src/pages/Dashboard.jsx`
- Test: `client/src/lib/triage.test.js`

**Interfaces:**
- Produces: `courseTriageSummary(...)` gains `resubmissions` (count) and `resubmissionTone` (worst tone); `redCount` includes `resubmissions`.

- [ ] **Step 1: Failing tests** — in `client/src/lib/triage.test.js`:

```js
it('counts resubmissions per course and in the red total', () => {
  const t = { lateWork: [], feedbackOwed: [], makeUps: [], resubmissions: [
    { courseId: 5, tone: 'red' }, { courseId: 5, tone: 'green' }, { courseId: 6, tone: 'amber' },
  ] };
  expect(courseTriageSummary(t, 5)).toMatchObject({ resubmissions: 2, resubmissionTone: 'red' });
  expect(redCount(t)).toBe(1);
});
```

- [ ] **Step 2: Run** `cd client && npx vitest run src/lib/triage.test.js` → FAIL.

- [ ] **Step 3: Implement** — in `courseTriageSummary` add `const resubs = (triage?.resubmissions || []).filter((r) => r.courseId === courseId);` and return `resubmissions: resubs.length, resubmissionTone: worstTone(resubs)`; in `redCount` change the list array to `['makeUps', 'lateWork', 'resubmissions', 'feedbackOwed']` and its comment to "all four lists". In `Dashboard.jsx` after the late chip:

```jsx
                  {t.resubmissions > 0 && (
                    <span className={`badge ${TONE_BADGE[t.resubmissionTone]}`}>{t.resubmissions} resubmission{t.resubmissions === 1 ? '' : 's'}</span>
                  )}
```

- [ ] **Step 4: Run** `cd client && npm test` → PASS.

- [ ] **Step 5: Commit** — `feat(dashboard): resubmission chip; course Triage count includes resubmissions`.

---

### Task 9: Client — Ask/Extend/Close/Reviewed on the assessment card; Settings field

**Files:**
- Create: `client/src/components/ResubmitControl.jsx`, `client/src/components/ResubmitControl.test.jsx`
- Modify: `client/src/pages/AssessmentSummaryPage.jsx` (replace the `HeaderPill` resubmit block + `handleRequestResubmit`/`handleClearResubmit`/`resubmitFlag` state with `<ResubmitControl>`), `client/src/pages/SettingsPage.jsx`
- Test: `client/src/pages/SettingsPage.test.jsx` (create if absent, else extend)

**Interfaces:**
- Consumes: Task 8 api fns; mastery payload `student.resubmission` (`{ state, request }` | null), `student.resubmitted`.
- Produces: `<ResubmitControl student assignmentId defaultLessons onChange />` — `onChange(nextResubmission)` patches the card (`handleCardSaved(uid, { resubmission, resubmit_flag })`).

- [ ] **Step 1: Failing tests** — `client/src/components/ResubmitControl.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ResubmitControl from './ResubmitControl.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js', () => ({
  requestResubmission: vi.fn(), updateResubmission: vi.fn(), reviewResubmission: vi.fn(), undoResubmission: vi.fn(),
}));
const student = (resubmission = null) => ({ id: 7, schoology_uid: 'u7', resubmission });
beforeEach(() => vi.clearAllMocks());

describe('ResubmitControl', () => {
  it('asks with the default lessons and a note', async () => {
    api.requestResubmission.mockResolvedValue({ id: 3, lessons: 3, until: '2026-10-15', outcome: 'asked' });
    const onChange = vi.fn();
    render(<ResubmitControl student={student()} assignmentId={30} defaultLessons={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Ask to resubmit/ }));
    fireEvent.change(screen.getByLabelText('Resubmission note'), { target: { value: 'add tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(api.requestResubmission).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30, lessons: 3, note: 'add tests' }));
    expect(onChange).toHaveBeenCalledWith({ state: 'waiting', request: { id: 3, lessons: 3, until: '2026-10-15', outcome: 'asked' } });
  });
  it('an open request shows "Resubmit by DD/MM/YYYY" with Extend / Close / Undo', async () => {
    api.updateResubmission.mockResolvedValue({ id: 3, lessons: 5, until: '2026-10-19' });
    const onChange = vi.fn();
    render(<ResubmitControl student={student({ state: 'waiting', request: { id: 3, lessons: 3, until: '2026-10-15' } })} assignmentId={30} defaultLessons={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Resubmit by 15\/10\/2026/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close request' }));
    await waitFor(() => expect(api.updateResubmission).toHaveBeenCalledWith(3, { close: true, note: '' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
  it('an arrived resubmission offers Reviewed', async () => {
    api.reviewResubmission.mockResolvedValue({ id: 9, outcome: 'reviewed' });
    const onChange = vi.fn();
    render(<ResubmitControl student={student({ state: 'arrived', request: null })} assignmentId={30} defaultLessons={3} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    await waitFor(() => expect(api.reviewResubmission).toHaveBeenCalledWith({ studentId: 7, assignmentId: 30 }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
```

Settings test: rendering `SettingsPage` with mocked `getSettings` returning `triage: { …, resubmitLessonsDefault: 3 }` shows a stepper labelled "Resubmission deadline (lessons)"; incrementing calls the save api with `{ resubmitLessonsDefault: 4 }` (mirror the existing settings save mock).

- [ ] **Step 2: Run** `cd client && npx vitest run src/components/ResubmitControl.test.jsx src/pages/SettingsPage.test.jsx` → FAIL.

- [ ] **Step 3: Implement** `client/src/components/ResubmitControl.jsx`:

```jsx
import { useState } from 'react';
import NumberStepper from './NumberStepper.jsx';
import { formatDate } from '../lib/formatDate.js';
import { requestResubmission, updateResubmission, reviewResubmission, undoResubmission } from '../services/api.js';

// The assessment card's resubmission control (triage resubmissions, 2026-10-03).
// No request: "⟳ Ask to resubmit" → lessons (default from Settings) + note → Ask.
// Open request: "⟳ Resubmit by DD/MM/YYYY" → Extend / Close / Undo.
// Arrived: "Reviewed" (grade stands). Prism-only — nothing is written to Schoology.
export default function ResubmitControl({ student, assignmentId, defaultLessons = 3, onChange }) {
  const r = student.resubmission;
  const [panel, setPanel] = useState(false);
  const [lessons, setLessons] = useState(r?.request?.lessons ?? defaultLessons);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run(fn) {
    setBusy(true); setError(null);
    try { await fn(); setPanel(false); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const ask = () => run(async () => {
    const req = await requestResubmission({ studentId: student.id, assignmentId, lessons, note });
    onChange?.({ state: 'waiting', request: req });
  });
  const extend = () => run(async () => {
    const req = await updateResubmission(r.request.id, { lessons });
    onChange?.({ ...r, request: req });
  });
  const close = () => run(async () => { await updateResubmission(r.request.id, { close: true, note }); onChange?.(null); });
  const undo = () => run(async () => { await undoResubmission(r.request.id); onChange?.(null); });
  const reviewed = () => run(async () => { await reviewResubmission({ studentId: student.id, assignmentId }); onChange?.(null); });

  if (r?.state === 'arrived') {
    return (
      <span className="resubmit-control">
        <button type="button" className="secondary btn-sm" disabled={busy} onClick={reviewed}>Reviewed</button>
        {error && <span className="text-sm badge badge-red">{error}</span>}
      </span>
    );
  }
  const open = r?.state === 'waiting' && r.request;
  return (
    <span className="resubmit-control">
      <button
        type="button" className={`resubmit-pill${open ? ' resubmit-pill--active' : ''}`}
        aria-expanded={panel} disabled={busy} onClick={() => setPanel((v) => !v)}
      >
        <span aria-hidden="true">⟳</span>{' '}
        {open ? `Resubmit by ${formatDate(`${r.request.until}T00:00:00`)}` : 'Ask to resubmit'}
      </button>
      {panel && (
        <span className="resubmit-control__panel">
          <NumberStepper value={lessons} min={1} max={60} onChange={setLessons} aria-label="Resubmission deadline (lessons)" />
          <input className="triage-note" placeholder="Note (optional)" aria-label="Resubmission note" value={note} onChange={(e) => setNote(e.target.value)} />
          {open ? (
            <>
              <button type="button" className="secondary btn-sm" disabled={busy} onClick={extend}>Extend</button>
              <button type="button" className="secondary btn-sm" disabled={busy} onClick={close}>Close request</button>
              <button type="button" className="ghost danger" disabled={busy} onClick={undo}>Undo</button>
            </>
          ) : (
            <button type="button" className="primary btn-sm" disabled={busy} onClick={ask}>Ask</button>
          )}
        </span>
      )}
      {error && <span className="text-sm badge badge-red">{error}</span>}
    </span>
  );
}
```

Add to `client/src/app.css` (outside the phone block; colours via existing variables):

```css
/* Assessment card: resubmission control (triage resubmissions). */
.resubmit-control { display: inline-flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.resubmit-control__panel { display: inline-flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.resubmit-pill {
  display: inline-flex; align-items: center; gap: 0.35rem; height: 1.8rem; box-sizing: border-box;
  border-radius: 999px; padding: 0 0.7rem; font-size: 0.85rem; font-weight: 600; white-space: nowrap;
  border: 1.5px solid var(--resubmit-ring); background: var(--card-bg); color: var(--text-muted); cursor: pointer;
}
.resubmit-pill--active { border-width: 2.5px; background: var(--badge-resubmit-bg); color: var(--badge-resubmit-text); }
```

In `AssessmentSummaryPage.jsx` `StudentRubricCard`: remove `resubmitFlag`/`resubmitBusy` state and the two handlers; replace the `{resubmitFlag ? (<HeaderPill …/>) : (<HeaderPill …/>)}` block with:

```jsx
        {/* Resubmission (triage) — ask with a deadline in lessons; Prism-only. */}
        <ResubmitControl
          student={student}
          assignmentId={assignmentRow?.id}
          defaultLessons={resubmitLessonsDefault}
          onChange={(resubmission) => onSaved?.(student.schoology_uid, {
            resubmission, resubmit_flag: resubmission?.request ? { id: resubmission.request.id } : null,
          })}
        />
```

`bothSignals` becomes `const bothSignals = !!student.resubmit_flag && !!student.resubmitted;`. Thread a `resubmitLessonsDefault` prop into `StudentRubricCard` from the page: the page loads it once with `getSettings()` (already used by SettingsPage — reuse that api fn) into state, default 3. `onSaved` is the page's `handleCardSaved(uid, patch)` (already patches a student in place). Leave `HeaderPill` in place for the review flag.

`SettingsPage.jsx` — after the make-up row:

```jsx
        <div className="settings-row">
          <span>Resubmission deadline (default)</span>
          <NumberStepper value={triage.resubmitLessonsDefault} min={1} max={60} onChange={(v) => save({ resubmitLessonsDefault: v })} aria-label="Resubmission deadline (lessons)" />
          <span className="text-sm text-muted">lessons after asking</span>
        </div>
```

- [ ] **Step 4: Run** `cd client && npm test` → PASS (fix any `AssessmentSummaryPage` test that looked for the old "Ask to resubmit" HeaderPill — it now lives in `ResubmitControl` with the same label).

- [ ] **Step 5: Commit** — `feat(assessment): ask/extend/close/reviewed resubmission control; settings default`.

---

### Task 10: Deep link — rows open the student's card

**Files:**
- Modify: `client/src/components/triage/LateWorkPanel.jsx`, `client/src/components/triage/MakeUpPanel.jsx` (link via `cardLink` from `ResubmissionsPanel.jsx`), `client/src/pages/AssessmentSummaryPage.jsx` (read `?student=`, scroll, highlight), `client/src/app.css` (highlight)
- Test: `client/src/components/triage/TriageSection.test.jsx`, `client/src/pages/AssessmentSummaryPage.test.jsx` (or the closest existing page test file — `ls client/src/pages/AssessmentSummaryPage*`)

**Interfaces:**
- Consumes: `cardLink(row)` (Task 8). Card wrapper gets `id="student-card-<prism id>"`.

- [ ] **Step 1: Failing tests.**

TriageSection test:

```js
it('late work and make-up names link to the student card', async () => {
  renderSection();
  const late = await latePanel();
  expect(within(late).getByRole('link', { name: 'Maya Chen' }).getAttribute('href')).toBe('/course/5/assessment/a9?student=1');
  const mk = await makeUpPanel();
  expect(within(mk).getByRole('link', { name: 'Noah Park' }).getAttribute('href')).toBe('/course/8/assessment/q20?student=7');
});
```

Assessment page test (render at `/course/5/assessment/a9?student=12` inside `MemoryRouter initialEntries` + `Routes`, mocking `getMasteryForAssignment` to return two students with ids 11 and 12): stub `Element.prototype.scrollIntoView = vi.fn()`; expect it called on the element with id `student-card-12`, and that element has class `student-card--highlight`.

- [ ] **Step 2: Run** the two test files → FAIL.

- [ ] **Step 3: Implement.**
- `LateWorkPanel.jsx` / `MakeUpPanel.jsx`: `import { cardLink } from './ResubmissionsPanel.jsx';` and change each name `Link to={`/student/${r.studentId}`}` → `to={cardLink(r)}`.
- `AssessmentSummaryPage.jsx`: `import { useSearchParams } from 'react-router-dom';` In the page: 

```js
  // Triage rows link here with ?student=<id>: show that card (clear a filter
  // hiding it), scroll to it, and pulse a highlight ring for ~2 s.
  const [searchParams] = useSearchParams();
  const focusStudentId = Number(searchParams.get('student')) || null;
  const [highlightId, setHighlightId] = useState(null);
  useEffect(() => {
    if (!focusStudentId || !data) return;
    const s = data.students.find((x) => x.id === focusStudentId);
    if (!s) return;
    if (!passesFilters(s, activeFilters, { assignment: data.assignment, topics: alignedTopics })) setActiveFilters(new Set());
    setHighlightId(focusStudentId);
    requestAnimationFrame(() => document.getElementById(`student-card-${focusStudentId}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }));
    const t = setTimeout(() => setHighlightId(null), 2200);
    return () => clearTimeout(t);
  }, [focusStudentId, data]); // eslint-disable-line react-hooks/exhaustive-deps
```

(place it after `alignedTopics` is defined; if `alignedTopics` is derived later in render, compute the filter check inside the effect from the same inputs the page uses for `visibleStudents`). Pass `highlight={highlightId === student.id}` to `StudentRubricCard`; on its outer `<div>` add `id={`student-card-${student.id}`}` and `className={highlight ? 'student-card--highlight' : undefined}`.
- `app.css`: 

```css
/* Deep link from a triage row: pulse the target card's ring. */
.student-card--highlight { animation: student-card-pulse 2s ease-out; }
@keyframes student-card-pulse {
  0%, 60% { box-shadow: 0 0 0 3px var(--accent); }
  100% { box-shadow: 0 0 0 0 transparent; }
}
```

(If the card's inline `boxShadow` would override the animation, apply the animation via `outline` instead: `0%,60% { outline: 3px solid var(--accent); } 100% { outline: 3px solid transparent; }`.)

- [ ] **Step 4: Run** `cd client && npm test` → PASS.

- [ ] **Step 5: Commit** — `feat(triage-ui): student rows open their card on the assessment page`.

---

### Task 11: Live parity probe, docs, visual check

**Files:**
- Create: `scripts/parity-lti-resubmission.js`
- Modify: `docs/design-language.md`, `.claude/build-progress.md` (Triage section), `docs/superpowers/specs/2026-10-03-triage-resubmissions-design.md` (add "Implementation notes" if anything changed)

- [ ] **Step 1: Parity probe** — `scripts/parity-lti-resubmission.js` (read-only against a `/tmp` DB copy): opens `DB_PATH` with `{ readonly: true }`, and reports (a) for archived LTI graded rows, the count where `isResubmitted` is true (expected: 9 on the 2026-10-03 snapshot), (b) for current LTI submitted rows, how many have `submitted_at == latest_revision_at` (expected after a post-fix sync: only rows with no REST grade), (c) `getTriage(db).resubmissions` grouped by state. Usage header: `DB_PATH=/tmp/prism-dev.db node scripts/parity-lti-resubmission.js`.

```js
// Parity (triage resubmissions): after the LTI timestamp fix, check stored data
// against the 2026-10-03 probe. READ-ONLY. Usage: DB_PATH=/tmp/prism-dev.db node scripts/parity-lti-resubmission.js
import Database from 'better-sqlite3';
import { isResubmitted } from '../server/lib/resubmission.js';
import { getTriage } from '../server/services/triage.js';

const db = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
const rows = (archived) => db.prepare(`
  SELECT g.*, a.title FROM grades g JOIN assignments a ON a.id = g.assignment_id JOIN courses c ON c.id = a.course_id
  WHERE a.is_lti_submission = 1 AND c.archived = ?`).all(archived);
const archived = rows(1).filter(isResubmitted);
console.log(`archived LTI resubmitted-since-feedback: ${archived.length} (probe: 9)`);
for (const r of archived) console.log(`  ${r.title}`);
const current = rows(0).filter((r) => r.lti_submission_state === 'submitted');
console.log(`current LTI submitted: ${current.length}; submitted_at == latest_revision_at: ${current.filter((r) => r.submitted_at === r.latest_revision_at).length}`);
const t = getTriage(db, {});
console.log('triage resubmissions by state:', t.resubmissions.reduce((m, r) => ({ ...m, [r.state]: (m[r.state] || 0) + 1 }), {}));
```

(`getTriage` only reads — `settleResubmissions` is not called.) Run it on a fresh `/tmp/prism-dev.db` backup **before** a sync (expect current rows mostly equal), then start dev (`PORT=3002 DB_PATH=/tmp/prism-dev.db npm run dev`), run a sync from the dev UI with PowerSchool unticked, stop dev (`PORT=3002 npm run dev:stop`), and re-run — current equal-timestamp rows should drop to those with no REST grade. Record both outputs in the spec's "Implementation notes".

- [ ] **Step 2: Docs** — `docs/design-language.md`: append an entry "Resubmissions panel (2026-10-03)": hidden-when-empty 4th panel, tags (`↩ arrived` uses `.badge-resubmitted`; `⟳ by DD/MM` uses `.badge-resubmit`; `unsubmitted in Schoology` gray; `after deadline` amber), the card `ResubmitControl` pill, and the deep-link highlight pulse. `.claude/build-progress.md` Triage section: a dated bullet summarising the shipped feature, the LTI timestamp fix, the new MCP tools, and "Phase 2 (Schoology unsubmit + comment line) pending a write probe".

- [ ] **Step 3: Visual check** — with dev running on 3002 against `/tmp/prism-dev.db`, render screenshots at 390 px and 1280 px of the Dashboard rail and one assessment page reached via a Resubmissions row link (Playwright script under `scripts/`, or `npm run check:mobile http://127.0.0.1:3002` plus a screenshot). Save PNGs to `/tmp` and open them with the Read tool so the teacher can see them. Stop dev with `PORT=3002 npm run dev:stop` and confirm `lsof -nP -iTCP:3002 -sTCP:LISTEN` is empty.

- [ ] **Step 4: Full suites** — `npm test` and `cd client && npm test && npm run build` → all PASS.

- [ ] **Step 5: Commit** — `docs(triage): resubmissions parity probe, design language, build progress`.

---

## Ship (after the final whole-branch review)

```bash
git checkout main && git merge --ff-only feat/triage-resubmissions && git push origin main
```

Wait for CI green → deploy; confirm with `curl -s 127.0.0.1:3001/api/version` (shows the new commit). Then run one prod sync from the UI and check Settings → Recent syncs for errors.
