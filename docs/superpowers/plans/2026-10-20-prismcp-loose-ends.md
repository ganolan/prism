# PrisMCP Loose Ends (#170) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every loose end left by #131: #170's four items, the deferred review minors, and the grader passing back the data it graded from.

**Architecture:** Each grading read gets a recorded serve (`context_serves` row) whose id the grader passes back on write, so a suggestion's data time is exact. The queue, grading sync and run history get the remaining correctness fixes; then tidying and tests. The assessment-grader plugin is released after Prism deploys.

**Tech Stack:** Node ESM, Express, better-sqlite3, `@modelcontextprotocol/sdk` 1.29, Vitest, React.

**Spec:** `docs/superpowers/specs/2026-10-20-prismcp-over-http-design.md` (the parent design), issue #170, and Graham's decision of 20/10/2026: "Grader passes it back" (the grader passes back what it graded from; without it the server falls back to the oldest read in the last 3 hours).

## Global Constraints

- Tool names stay the same. New optional inputs only: `write_student_suggestions` gains `context_id` (integer).
- `get_assignment_context` returns `context_id` (integer) on every successful answer (fresh, synced, stored).
- Fallback window when no `context_id` is given: the OLDEST serve of that assignment in the last **3 hours** (`CONTEXT_FALLBACK_MS = 3 * 60 * 60 * 1000`); with no serve in that window: `task_synced_at ?? 'never'` and now, as before #131's I-1 fix.
- Staleness rule unchanged: stale when `suggested_at - data_as_of > SYNC_FRESH_MS` (10 minutes); `'never'` is stale; nulls are not judged.
- `context_serves` rows older than **30 days** are pruned.
- Run history keeps **30** full (unified) runs and **30** task and quiz runs, counted separately.
- New columns and tables go in `server/db/schema.sql` AND the `MIGRATIONS` array in `server/db/index.js`.
- Tests at the end of every task: root `npx vitest run` and `cd client && npx vitest run`, gated on exit codes; `npm run build` when client code changes.
- No em dashes or middots in UI copy or docs; docs in plain international English, American spelling.

## Review Focus

- **A suggestion written with a `context_id` from another assignment:** refused for that student (error in its result), nothing written.
- **An unknown or pruned `context_id`:** the write falls back to the 3-hour rule and its result notes the fallback.
- **Two grading sessions on one task, one stored and one fresh:** each session's suggestions carry its own serve's times.
- **A server restart between the read and the write:** `context_serves` is in the database, so the id still resolves.
- **Quiz overall suggestions (`write_quiz_overall_suggestions`):** no serve exists; the fallback rule applies and never copies a serve older than 3 hours.

---

### Task 1: Suggestions carry the serve they were graded from

**Files:** `server/db/schema.sql`, `server/db/index.js`, `server/services/contextServes.js` (create, with test), `mcp/handlers.js` (`getAssignmentContextTool`), `mcp/server.js` (`get_assignment_context` and `write_student_suggestions` descriptions and schema), `server/services/suggestions.js` (`writeStudentSuggestions`, `upsertStudentSuggestion`), tests beside each.

**Interfaces:**
- Produces: table `context_serves (id INTEGER PRIMARY KEY, assignment_id INTEGER NOT NULL, data_as_of TEXT NOT NULL, served_at TEXT NOT NULL)`; `recordServe(db, { assignmentId, dataAsOf }) → id`; `serveFor(db, { assignmentId, contextId, now }) → { dataAsOf, servedAt, source: 'context_id' | 'fallback' | 'none' }`; `pruneServes(db, { now })`.
- `get_assignment_context` answer gains `context_id`. The assignment columns `context_data_as_of` / `context_served_at` from #131 are no longer read (keep the columns; stop writing them).
- `writeStudentSuggestions(db, { assignmentId, students, contextId })`.

- [ ] **Step 1: Failing tests:** `recordServe` then `serveFor` by id returns that serve; a `contextId` of another assignment → error result for each student, nothing written; an unknown id → fallback, result `message` notes it; fallback picks the OLDEST serve in 3 h; a serve 4 h old is ignored (then `task_synced_at ?? 'never'`, now); two sessions (stored serve, fresh serve) each write with their own id → each row carries its own times; `pruneServes` deletes rows older than 30 days; `get_assignment_context` answers carry `context_id` (fresh, synced, stored) and failures record nothing.
- [ ] **Step 2:** Run them, see them fail.
- [ ] **Step 3:** Implement. Prune on each `recordServe` (cheap DELETE by `served_at`).
- [ ] **Step 4:** Tests pass; both suites.
- [ ] **Step 5:** Commit `feat(prismcp): suggestions carry the serve they were graded from (#170)`.

### Task 2: Grading sync and queue correctness

**Files:** `server/services/syncQueue.js`, `server/services/gradingSync.js`, `server/services/taskSyncRun.js`, `server/services/submissionComments.js`, `server/services/submissionFiles.js`, `mcp/handlers.js`, tests beside each.

- [ ] **Step 1: Failing tests**, one per item:
  1. A grading request upgrades a QUEUED plain task run of the same task (sets `grading: true` on it, joins it, lifts it as a button); a RUNNING plain run is not joined (existing rule).
  2. Freshness: a grading run that joins an in-flight comment or file read (started with a larger `maxAgeSec`) waits for it, then reads the students whose read is older than the grading run's start. Covered for both comments and files.
  3. After a failed submissions read or a lost sign-in, a grading run reads no threads or files (it is already failing).
  4. A comment job with no `done` is an error (fails closed), not a success.
  5. `get_assignment_context` with a `course_id` that does not own the assignment → NOT_FOUND before any sync.
  6. One session check per call: `gradingSync` passes `sessionCheckedAt`; `runOne` skips its own preflight when that is under 60 s old.
  7. A held grading run with an `unknown` session check is resumed (it then runs and fails visibly), not left held.
  8. `lastFailedRun` for a course scope ignores task and quiz runs.
  9. `whenDone` waiters are removed when the caller times out (no pile-up after SYNC_PENDING / PENDING).
  10. The files source note: feature-off wins over the OneDrive note.
- [ ] **Step 2:** See them fail. **Step 3:** Implement (`contextSources` reuses the task row `gradingSync` already resolved). **Step 4:** Tests and both suites pass.
- [ ] **Step 5:** Commit `fix(sync): grading sync and queue loose ends (#170)`.

### Task 3: Run history keeps full syncs

**Files:** `server/services/syncRuns.js` (`pruneRuns`), its test, `client/src/components/RecentSyncs.jsx` only if a label is needed.

- [ ] **Step 1: Failing test:** with 40 task and quiz runs and 35 full runs, `pruneRuns` keeps the newest 30 full runs and the newest 30 task/quiz runs; active rows are never deleted.
- [ ] **Steps 2-4:** fail, implement, pass, both suites. **Step 5:** Commit `fix(sync): run history keeps full syncs apart from task and quiz runs (#170)`.

### Task 4: Tidying and missing tests

**Files:** `server/services/syncQueue.js`, `server/services/quizRun.js`, a leaf module for shared constants (e.g. `server/lib/toolWait.js` for `TOOL_WAIT_MS`, `mcp/devCopy.js` for `DEV_COPY_WARNING`), `scripts/check-mcp-endpoint.js`, `scripts/parity-prismcp-http.js` + test, `client/src/pages/AssessmentSummaryPage.jsx` + quiz test, small test and doc files named below.

- [ ] **Step 1: Failing tests:** the quiz Load button shows "loaded" (not the reload error) when the run succeeded and only the follow-up read failed; `waitForRun` stops on unmount and on group change; parity `judge` with a `_source` exception, the exit logic, and DIFFERS printing its failures too; `check-mcp-endpoint.js` imports no database module (assert the module graph or that `server/db/index.js` is not loaded).
- [ ] **Step 2:** See them fail. **Step 3:** Implement; also: break the quizRun/syncQueue import cycle via the leaf module; remove the dead `signInLost && !request.noHold` branch; fix the comment wraps (`assignmentSync.js` header, above `diffAnswers`), the two blank lines in `docs/design-language.md`, the filler `expect(revised).toBeTruthy()`, and the duplicate import in `server/routes/mcp.test.js`.
- [ ] **Step 4:** Tests, both suites, build. **Step 5:** Commit `chore(prismcp): tidy and test the #131 loose ends (#170)`.

### Task 5: Documents

- [ ] Update `docs/prismcp-install-and-verify.md` (`context_id`, the 3-hour fallback, history retention), `.claude/build-progress.md`, `docs/design-language.md` if the banner rule's wording changes. Run the house checker on changed prose. Commit `docs(prismcp): #170 loose ends`.

### Task 6: Ship Prism, then the grader

- [ ] Whole-branch review, fix wave if needed. Push `main`; CI green; prod serves it; `node scripts/check-mcp-endpoint.js`; a live `get_assignment_context` returns `context_id`.
- [ ] assessment-grader (`~/repos/graham-plugins`): `shared/orchestration.md` and every skill that writes suggestions after `get_assignment_context` pass `context_id` from that answer. Minor version bump (0.18.0), CHANGELOG, `claude plugin validate .` and `./assessment-grader`, commit, push (standing rule for that repo).
- [ ] Close #170 with commits and evidence; refresh memory.
