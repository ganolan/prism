# PrisMCP Served by Prism over HTTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Prism server hosts PrisMCP at `/mcp`; every bulk Schoology read a tool starts is a queue run; the stdio PrisMCP and its `DB_PATH` setup are removed.

**Architecture:** `createServer()` (mcp/server.js) is mounted in Express with the SDK's stateless streamable HTTP transport, one server and transport per request. `get_assignment_context` asks the sync queue for a grading sync (a task run that also waits for comment threads and reads files) and waits for it. Quiz loads become queue runs. Tool results from a dev copy carry a warning, and a dev copy refuses Schoology writes.

**Tech Stack:** Node ESM, Express, better-sqlite3, `@modelcontextprotocol/sdk` 1.29 (`server/streamableHttp.js`, `server/middleware/hostHeaderValidation.js`, `client/streamableHttp.js` for tests), Vitest, React (one banner).

**Spec:** `docs/superpowers/specs/2026-10-20-prismcp-over-http-design.md`

## Global Constraints

- Tool names, inputs and outputs stay the same, except: `get_assignment_context` gains `use_stored_data` (boolean) and the answers listed in Task 3.
- Grading sync is skipped when the task's `task_synced_at` is under **5 minutes** old (`GRADING_FRESH_MS = 5 * 60 * 1000`).
- Suggestions show their data time when it is more than **10 minutes** older than the suggestion (`SYNC_FRESH_MS`, already exported by `syncQueue.js`).
- A tool call waits at most `GRADING_WAIT_MS = 50_000` for a queue run, then answers `SYNC_PENDING` with the run id; calling again follows the same run.
- Sign-in link: `https://prism.swordtail-everest.ts.net/settings#schoology-signin`.
- Stored-data warning text: `Data as of <ISO time>. Sign in to Schoology for a fresh sync.`
- Dev-copy warning text: `This is a dev copy of Prism: its data is replaced at the next refresh, and it refuses Schoology writes.`
- Dev copy = `resolveVersion().mode !== 'release'` (`server/lib/version.js`).
- `/mcp` keeps `originGuard`, and checks `Host` against `127.0.0.1`, `localhost` and the hostnames in `config.yaml` `server.allowedOrigins`.
- New columns go in `server/db/schema.sql` **and** the `MIGRATIONS` array in `server/db/index.js`.
- No em dashes in UI copy. Dates in the UI through `formatDateTime` (`client/src/lib/formatDate.js`).
- Tests at the end of every task: `npx vitest run` at the root and `cd client && npx vitest run`, gated on the exit code.

## Review Focus

- **A deploy restarts the server during a grading sync:** the run is marked interrupted; the tool answers `SYNC_FAILED` with the run id, and the next call starts a fresh grading sync. (Task 3 test.)
- **Two grading sessions on one task at once:** the second call joins the first call's run; one sync, both answers. (Task 1 test.)
- **`assignment_id` given as a local id or a Schoology id, or unknown:** both ids resolve; an unknown one answers `NOT_FOUND` and queues nothing. (Task 3 test.)
- **A OneDrive (LTI) task:** the file read's `NOT_NATIVE` is not a sync failure; the run completes and stamps `task_synced_at`. (Task 1 test.)
- **A session that lapses during the run** (the run is held mid-way): the tool answers `SESSION_LAPSED`, not `SYNC_PENDING`. (Task 3 test.)

---

### Task 1: Grading sync in the queue

**Files:**
- Modify: `server/services/syncQueue.js` (`covers`, header comment)
- Modify: `server/services/taskSyncRun.js` (`runTaskSync`)
- Test: `server/services/syncQueue.test.js`, `server/services/taskSyncRun.test.js`

**Interfaces:**
- Produces: request `{ kind: 'task', courseId, assignmentId, grading: true, trigger: 'button' }`. `enqueue` and `whenDone` are unchanged. The summary event of a grading run adds `comments: { refreshed, failed, error? }` and `files: { refreshed, failed, notNative?, error? }`.

- [ ] **Step 1: Write the failing tests**

In `syncQueue.test.js`:
```js
it('grading: a grading request joins only a grading run of the same task', () => {
  const a = enqueue({ kind: 'task', courseId: 5, assignmentId: '950', grading: true, trigger: 'button' });
  const b = enqueue({ kind: 'task', courseId: 5, assignmentId: '950', grading: true, trigger: 'button' });
  expect(b).toMatchObject({ runId: a.runId, joined: true });
});
it('grading: never joins a course run or a plain task run of that task', () => {
  const course = enqueue({ kind: 'courses', courseIds: [5], trigger: 'page' });
  const plain = enqueue({ kind: 'task', courseId: 5, assignmentId: '950', trigger: 'page' });
  const g = enqueue({ kind: 'task', courseId: 5, assignmentId: '950', grading: true, trigger: 'button' });
  expect(g.joined).toBe(false);
  expect([course.runId, plain.runId]).not.toContain(g.runId);
});
it('grading: a plain task request joins a queued grading run (it reads more)', () => {
  const g = enqueue({ kind: 'task', courseId: 5, assignmentId: '950', grading: true, trigger: 'button' });
  expect(enqueue({ kind: 'task', courseId: 5, assignmentId: '950', trigger: 'page' })).toMatchObject({ runId: g.runId, joined: true });
});
it('grading: a grading request joins a RUNNING grading run of the same task', async () => { /* hold the run in runTaskSync with a deferred; expect state 'running', joined */ });
```
In `taskSyncRun.test.js`:
```js
it('grading: waits for the comment threads and reads the files; both in the summary', async () => {
  // deps.syncAssignment returns comments job { queued: 3, done: Promise<{refreshed:3,failed:0}> }
  // deps.refreshFiles(db, taskId, { maxAgeSec: 0 }) returns { done: Promise<{refreshed:2,failed:0}> }
  // expect summary.comments = { refreshed: 3, failed: 0 }, summary.files = { refreshed: 2, failed: 0 }, task_synced_at stamped
});
it('grading: a OneDrive task (files NOT_NATIVE) still completes and is stamped', async () => { /* refreshFiles throws { code: 'NOT_NATIVE' } → files.notNative true, task_synced_at set */ });
it('grading: a failed thread read fails the run (no stamp)', async () => { /* comments done rejects → summary.comments.error, assignment phase 'error', task_synced_at unchanged */ });
it('a plain task run does not wait for threads or read files (unchanged)', async () => { /* refreshFiles not called */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run server/services/syncQueue.test.js server/services/taskSyncRun.test.js`
Expected: FAIL (grading requests join course runs; no `files` in the summary).

- [ ] **Step 3: Implement**

- `covers(entry, request)`: when `request.grading`, covered only by `entry.request.kind === 'task' && entry.request.grading` and the same task. A plain task request is also covered by a grading entry of the same task (existing `same` check).
- `enqueue`: a grading request (trigger `'button'`, no `force`) can join the running grading run of the same task through the existing first line.
- `runTaskSync(request, emit, { db, deps })`: `deps` gains `refreshFiles` (default `refreshAssignmentFiles` from `submissionFiles.js`). When `request.grading`: `syncAssignment` must return the comments job's `done` (change `assignmentSync.js` to return `comments: { queued, done }`, keeping `queued` for the page path), await it, then `refreshFiles(db, taskId, { maxAgeSec: 0 }).done`. `NOT_NATIVE` → `files: { notNative: true }`, not an error. The task is stamped only when submissions, mastery, threads and files (or `notNative`) succeeded.

- [ ] **Step 4: Run the tests to verify they pass**, then the root and client suites.

- [ ] **Step 5: Commit** `feat(sync): grading sync, a task run that waits for comment threads and reads files (#131)`

---

### Task 2: Quiz loads are queue runs

**Files:**
- Create: `server/services/quizRun.js`, `server/services/quizRun.test.js`
- Modify: `server/services/syncQueue.js` (`runOne` dispatch, no hold for `noHold`), `server/routes/quizzes.js:71-78`, `mcp/handlers.js` (`loadQuizResultsTool`)
- Test: `server/services/syncQueue.test.js`, `server/routes/quizzes.test.js`, `mcp/handlers.test.js`

**Interfaces:**
- Produces: `runQuizLoad(request, emit, { db, deps })` with request `{ kind: 'quiz', groupId, trigger: 'button', noHold: true }`. It emits `{ type: 'summary', quiz: <loadGroup summary> }`, or `{ type: 'summary', fatal: true, quizError: { code, message } }`.
- Produces: `loadQuizQueued(db, groupId, { waitMs = GRADING_WAIT_MS, deps }) → Promise<summary>`. It throws `QuizError` (`NO_SESSION`, `UNREACHABLE`, `BUSY`, `NOT_FOUND`), or `QuizError('PENDING', …)` with `runId` when the wait passes `waitMs`.
- Consumes: `enqueue`, `whenDone` (Task 1 unchanged), `queueDeps.sessionStatus`.

- [ ] **Step 1: Write the failing tests**
```js
// quizRun.test.js
it('a lapsed session answers NO_SESSION at once and queues nothing', async () => { /* sessionStatus → { live: 'expired' }; expect rejects code NO_SESSION; currentSync() idle */ });
it('a load waits its turn behind a running sync, then returns the loadGroup summary', async () => { /* a running course run held by a deferred; release it; expect summary */ });
it('a loadGroup QuizError becomes the answer (BUSY keeps its meaning)', async () => {});
it('a wait past waitMs answers PENDING with the run id; loading again joins that run', async () => {});
// syncQueue.test.js
it('a noHold run whose session check fails finishes failed (never held)', async () => {});
// quizzes route test
it('POST /api/quizzes/:id/load goes through the queue (a sync_runs row of kind quiz)', async () => {});
```

- [ ] **Step 2: Run them to verify they fail** (`npx vitest run server/services/quizRun.test.js server/routes/quizzes.test.js`). Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** `runOne`: `kind === 'quiz'` → `queueDeps.runQuizLoad`. `covers`: a quiz request joins only a queued or running quiz run of the same `groupId`; quiz runs cover nothing else. For `noHold`, an expired session ends the run `failed` with a `quizError` `NO_SESSION` summary, never `hold()`. `quiz` runs record no attempt stamp. `loadQuizQueued` checks the session first, then enqueues and races `whenDone` against `waitMs`, then reads `summary_json` from `sync_runs`. The route maps `PENDING` to 202 `{ runId }`. The client's Load button keeps polling `getSyncRun(runId)` until finished when it gets 202 (client test in `AssessmentSummaryPage.quiz.test.jsx`).

- [ ] **Step 4: Run the tests to verify they pass**, then both suites.

- [ ] **Step 5: Commit** `feat(quizzes): quiz loads are queue runs, never beside a sync (#131)`

---

### Task 3: `get_assignment_context` forces the grading sync

**Files:**
- Create: `server/services/gradingSync.js`, `server/services/gradingSync.test.js`
- Modify: `mcp/handlers.js` (`getAssignmentContextTool`), `mcp/server.js` (the tool's input schema and description)
- Test: `mcp/handlers.test.js`, `mcp/server.test.js`

**Interfaces:**
- Produces: `gradingSync(db, assignmentRef, { useStoredData = false, waitMs = GRADING_WAIT_MS, now = Date.now(), onProgress, deps }) → Promise<{ state: 'fresh' | 'synced' | 'stored', runId?, dataAsOf, summary? }>`.
  - Throws `GradingSyncError` with `code`: `NOT_FOUND`; `SESSION_LAPSED` with `{ signInUrl, lastSyncedAt }`; `SYNC_FAILED` with `{ runId, message }`; `SYNC_PENDING` with `{ runId }`.
  - Exports `GRADING_FRESH_MS`, `GRADING_WAIT_MS`, `SIGN_IN_URL`.
- Produces: tool answer = the context as today, plus `data_as_of`. With stored data it also has `stale_data: 'Data as of <time>. Sign in to Schoology for a fresh sync.'` as the first key. The `*_source` fields come from the run summary (`refreshed`, `failed`, `cached_only: false`), or `cached_only: true` with the stored-data note.
- Consumes: Task 1's grading request and summary; `whenDone`, `queueDeps.sessionStatus`.

- [ ] **Step 1: Write the failing tests** (`gradingSync.test.js`, with queue deps replaced)
```js
it('a task synced under 5 minutes ago is fresh: nothing queued', async () => {});
it('otherwise a grading run is queued ahead of page runs and awaited → synced', async () => {});
it('a local id and a Schoology id both resolve; an unknown one is NOT_FOUND and queues nothing', async () => {});
it('a lapsed session answers SESSION_LAPSED with the sign-in link and task_synced_at, and queues nothing', async () => {});
it('use_stored_data skips the session check and the sync → stored, dataAsOf = task_synced_at', async () => {});
it('a run held mid-way (sign-in lost) answers SESSION_LAPSED', async () => {});
it('a failed or interrupted run answers SYNC_FAILED with its run id', async () => {});
it('a wait past waitMs answers SYNC_PENDING; calling again follows the same run', async () => {});
it('onProgress is called while waiting', async () => {});
```
In `mcp/server.test.js`: `get_assignment_context` accepts `use_stored_data`, and an error answer names the code (`SESSION_LAPSED`) and the sign-in link.

- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** The tool replaces its three direct refreshes (comments, files, mastery) with `gradingSync`. The MCP tool handler passes `onProgress` as `extra.sendNotification({ method: 'notifications/progress', … })` when the request carries a `progressToken`, every 10 s. Errors are returned as tool errors whose text starts with the code. The tool description states the force rule, the 5-minute window, the lapsed-session choice (ask the teacher, never choose stored data yourself) and `SYNC_PENDING` (call again).

- [ ] **Step 4: Run the tests to verify they pass**, then both suites.

- [ ] **Step 5: Commit** `feat(prismcp): get_assignment_context forces a grading sync through the queue (#131)`

---

### Task 4: Suggestions carry their data time

**Files:**
- Modify: `server/db/schema.sql` (`feedback.data_as_of TEXT`), `server/db/index.js` (`MIGRATIONS`), `server/services/suggestions.js` (`upsertStudentSuggestion`), `server/routes/feedback.js` (`/for-assignment/:id` returns `data_as_of`), `client/src/pages/AssessmentSummaryPage.jsx`, `docs/design-language.md`
- Test: `server/services/suggestions.test.js`, `client/src/pages/AssessmentSummaryPage.test.jsx`

**Interfaces:**
- Produces: `feedback.data_as_of` = the assignment's `task_synced_at` when the suggestion is written (null if never synced).

- [ ] **Step 1: Write the failing tests**
```js
it('a suggestion stores the task_synced_at of its assignment as data_as_of', () => {});
it('a rewrite updates data_as_of', () => {});
// client
it('suggestions made from data over 10 minutes older than the suggestion show one banner with that time', async () => {
  // feedback rows: updated_at 2026-10-20T10:30, data_as_of 2026-10-20T09:00
  expect(await screen.findByText('AI suggestions were made from data as of 20/10/2026, 17:00. Sync Assignment, then grade again for current data.')).toBeInTheDocument();
});
it('no banner when the data was current', async () => {});
```
(Expected times use local-time instants, not `Z` literals, so the test holds in any time zone.)

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement.** One `.alert.alert-warning` banner above the cards, naming the oldest stale `data_as_of`. *Ruling against the spec's "beside the suggestions":* one banner per page reads faster than a line on every card, and a grading run writes all cards from the same data. Record it in `docs/design-language.md`.

- [ ] **Step 4: Run the tests to verify they pass**, then both suites and `npm run build`.

- [ ] **Step 5: Commit** `feat(assessment): suggestions record their data time; a banner names stale ones (#131)`

---

### Task 5: `/mcp` on the server

**Files:**
- Create: `server/routes/mcp.js`, `server/routes/mcp.test.js`
- Modify: `server/index.js` (mount before the SPA fallback), `mcp/server.js` (`createServer({ devCopy })`, dev warning), `mcp/handlers.js` (`assertSchoologyWritable` replaces `assertSchoologyConfigured` and the unsubmit path)
- Test: `mcp/handlers.test.js`

**Interfaces:**
- Produces: `mcpRouter({ allowedHosts: string[], devCopy: boolean }) → express.Router`. POST `/` handles one request in stateless mode (`sessionIdGenerator: undefined`, `enableJsonResponse: false`); GET and DELETE answer 405.
- Produces: `createServer({ devCopy = false } = {})`. When `devCopy`, every tool result's first content item is the dev-copy warning.
- Produces: `assertSchoologyWritable({ devCopy, env })` throws `TriageError('DEV_COPY', …)` on a dev copy, else the existing credentials check (message no longer mentions an MCP `env` block).

- [ ] **Step 1: Write the failing tests** (`mcp.test.js`: an Express app on an ephemeral port, the SDK `Client` with `StreamableHTTPClientTransport`, `DB_PATH=':memory:'` seeded as `mcp/server.test.js` does)
```js
it('lists the same tools as createServer() over HTTP', async () => {});
it('calls list_courses over HTTP and gets the seeded course', async () => {});
it('refuses a Host that is not Prism\'s (DNS rebinding) with 403', async () => {});
it('refuses a POST whose Origin is another site with 403', async () => {});
it('a dev copy: every tool result starts with the dev-copy warning', async () => {});
it('a dev copy refuses request_resubmission with comment_line (DEV_COPY), and records nothing', async () => {});
it('a dev copy refuses request_resubmission with unsubmit: true (DEV_COPY)', async () => {});
it('a request survives a server restart: a new app on the same port answers the next call', async () => {});
```

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement.** `app.use('/mcp', originGuard({ allowed }), hostHeaderValidation(allowedHosts), express.json({ limit: '25mb' }), mcpRouter(…))`. `allowedHosts` = `['127.0.0.1', 'localhost', ...allowedOrigins.map((o) => new URL(o).hostname)]`. `devCopy = resolveVersion().mode !== 'release'`. The handlers keep using the server's `getDb()`.

- [ ] **Step 4: Run the tests to verify they pass**, then both suites and the build.

- [ ] **Step 5: Commit** `feat(prismcp): the Prism server hosts PrisMCP at /mcp (#131)`

---

### Task 6: Parity check

**Files:**
- Create: `scripts/parity-prismcp-http.js`, `scripts/parity-prismcp-http.test.js` (the comparison function only)

**Interfaces:**
- Produces: `node scripts/parity-prismcp-http.js --url http://127.0.0.1:3002/mcp --db <copy>`. It calls every read tool directly (handlers with `getDb()` on `--db`) and through `/mcp` with the same arguments. Arguments come from the copy: the first current course, its newest graded assignment, a student, a quiz group and a rubric. It prints one line per tool, `same` or the differing paths, and exits 1 on any difference. Exceptions, each listed with its reason: the `*_source` fields, `data_as_of`, the dev-copy warning item.

- [ ] **Step 1: Write the failing test** for `diffAnswers(a, b, { ignore })` (paths of differing leaves, ignoring listed keys).
- [ ] **Step 2: Run it to verify it fails.**
- [ ] **Step 3: Implement the script.**
- [ ] **Step 4: Run it live.** `sqlite3 ~/prism/data/students.db ".backup <scratchpad>/parity.db"`, then `DB_PATH=<scratchpad>/parity.db PORT=3002 npm run dev:server`, then the script. Expected: every line `same`, exit 0. Then `npm run dev:stop` and delete `parity.db` and its `-wal` and `-shm`.
- [ ] **Step 5: Commit** `test(prismcp): parity check of /mcp against the direct handlers (#131)`

---

### Task 7: Ship and switch

- [ ] **Step 1:** Push `main` (fast-forward). Confirm CI green on the commit (read the run's conclusion) and prod serving it (`curl -s 127.0.0.1:3001/api/version`).
- [ ] **Step 2:** On the mini, with a node script under `scripts/` (not curl): `tools/list` and `list_courses` through `https://prism.swordtail-everest.ts.net/mcp`. Expected: the tool list, and no dev-copy warning. This proves the tailnet proxy's `Host` passes the check.
- [ ] **Step 3: Stop for Graham** (question tool): ask him to name a target for one live status-line check through prod `/mcp`: preview, publish, read back the Schoology comment, undo, read back again.
- [ ] **Step 4:** Run that check and record the read-backs.
- [ ] **Step 5:** On the mini: `claude mcp remove prism -s user` and `claude mcp add --transport http -s user prism https://prism.swordtail-everest.ts.net/mcp`. Give Graham the same two lines for the laptop in the report. Check that one `get_assignment_context` call from a new session on the mini returns `data_as_of`.

---

### Task 8: Remove the old path and update the documents

**Files:**
- Delete: `mcp/dbGuard.js`, `mcp/dbGuard.test.js`, the stdio `main()` in `mcp/server.js` and its `isMain` guard, `mcp/serverImport.test.js` if it only tests that guard
- Modify: `docs/prismcp-install-and-verify.md` (rewritten: one `claude mcp add --transport http` line per machine, the dev-copy rules, the lapsed-session flow), `AGENTS.md` (the PrisMCP `DB_PATH` line, the "never point PrisMCP at a dev clone" line), `docs/deploy.md`, `docs/adr/0003-prism-served-from-a-home-server-over-tailscale.md` (option B adopted, 20/10/2026), `.claude/build-progress.md`, `CONTEXT.md` if a term changes

- [ ] **Step 1:** Grep for old wording across code, client, tests and docs: `DB_PATH` with PrisMCP, `StdioServerTransport`, `assertExplicitDbPath`, `ssh`, `mcp/server.js` as a command, `env block`. Fix every hit.
- [ ] **Step 2:** Run both suites and the build. Expected: green.
- [ ] **Step 3:** Commit `refactor(prismcp): remove the stdio server and its DB_PATH setup (#131)`, push, CI green, prod serving it.
- [ ] **Step 4:** Close #131 with commit ids, the parity output and the live-check read-backs. Retire the memory `project_prismcp_stale_after_deploy.md`, and update `project_state.md`.
