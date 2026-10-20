# PrisMCP served by Prism over HTTP (#131)

Date: 20 October 2026. Status: design, for Graham's approval.

## Intent

Graham, 20/10/2026: "The most robust solution is always my preference. I want this system to be rock solid."

PrisMCP today is a separate process (`mcp/server.js`, stdio). It opens prod's SQLite file directly and reads
Schoology itself. On the laptop it runs on the mini over SSH; on the mini it runs directly. Nothing has
failed in use, but the design has three weaknesses:

- **Old code after a deploy:** an open grading session keeps the PrisMCP code it started with. This
  happened on 13 Oct 2026: after a deploy, `attach_rubric` in an open session was still the old code.
- **Schoology reads outside the sync queue:** `get_assignment_context` reads mastery levels, comment
  threads and files itself, and `load_quiz_results` reads quiz attempts. These run beside the queue's
  syncs, against the same database, and update no "Synced" time.
- **Setup per machine:** SSH, an absolute `DB_PATH`, the session folder, and the Schoology secret sourced
  on the mini. A wrong `DB_PATH` writes grading to a disposable copy.

After this work there is one path: the Prism server owns the database, the Schoology session, the API
secret and the sync queue, and PrisMCP is part of the server.

## Goals

- **The server hosts PrisMCP** at `/mcp` (MCP over streamable HTTP). Claude Code on the laptop and on the
  mini connect to `https://prism.swordtail-everest.ts.net/mcp`. No PrisMCP code runs on either machine.
- **One writer:** only the server process touches the database.
- **One queue:** every bulk Schoology read a tool starts is a run in the sync queue.
- **A deploy updates every session's tools at once.**
- **Grading starts from fresh data:** opening an assignment for grading forces a full sync of that task.
- **The old path is removed** once the new one is proven: the stdio entry, `DB_PATH` for PrisMCP, the SSH
  setup and the `DB_PATH` guard.

## Non-goals

- **Logins or access control.** Prism stays tailnet-only with no login. A second teacher (#167) handles
  that separately.
- **New tools or changed tool behavior** beyond what this document lists.
- **Background or nightly reads of archived courses** (Graham, 20/10: keep them on demand).

## Anti-goals

- **Two paths kept "for safety".** A fallback to direct SQLite is a second path that can drift from the
  first without anyone noticing.
- **Grading on old data without being told.** Stored data is used only when the teacher chooses it.
- **A write that reports success and is lost**, for example on a dev copy.

## Decisions Graham made (20/10/2026)

1. **The server hosts PrisMCP itself** (not a local thin client calling REST).
2. **Grading forces a sync** of the task, even when that means waiting behind a running sync.
3. **Lapsed session:** the tool asks the teacher to sign in, and offers grading from stored data with a
   warning. It never chooses stored data on its own.
4. **No fallback:** the direct-SQLite path is removed after a parity check.
5. **Every `get_assignment_context` call forces the sync, unless that task had a full sync in the last 5
   minutes.** Delivery, calibration and rubric review call it too, often several times in one session;
   the 5-minute window stops repeat calls from waiting again.

## How it works

### `/mcp` on the server

- `createServer()` in `mcp/server.js` already builds the tools with no transport. The Express app mounts
  it at `/mcp` with the SDK's streamable HTTP transport (`@modelcontextprotocol/sdk` 1.29).
- **Stateless** (no MCP session id kept by the server): a server restart, such as a deploy, ends no
  client's session; the next request reaches the new code.
- **Tools run in the server process** and use its database connection, its sync queue and its saved
  Schoology session. Tool names, inputs and outputs stay the same, so the `assessment-grader` plugin works
  unchanged. Tool descriptions change only where behavior changes (below).
- **Security:** the same rules as `/api`. `originGuard` refuses a request whose `Origin` is another site.
  `/mcp` also checks the `Host` header against the server's own names (`127.0.0.1`, `localhost`, the
  tailnet name in `config.yaml` `server.allowedOrigins`), so a web page cannot reach it through a hostname
  it controls (DNS rebinding).
- **Dev copies** *(author's call)*: a dev clone's server also serves `/mcp`. Every tool result from a dev
  server (`/api/version` mode other than `release`) starts with a warning: this is a dev copy, and its
  Prism data is replaced at the next refresh. A dev server's `/mcp` refuses every Schoology write (status
  lines, unsubmit, FRQ marks, rubric attach) with that reason: students would see the write, and prod
  would have no record of it.
- **The `prism://assignment/.../context` resource** stays a database read with no sync *(author's
  call)*: a resource is attached by the teacher, not called by a tool.

### Grading sync (`get_assignment_context`)

`get_assignment_context` asks the queue for a **grading sync** of the task and waits for it, unless the
task's last full sync (`task_synced_at`) is under 5 minutes old (Graham's decision 5):

- **What it reads:** everything a Sync Assignment run reads (task details, submissions, grades, mastery
  levels and grade comments), plus the comment threads, waited for (15 to 20 s), and the files of every
  student who uploaded. Today a task run returns before the threads finish, and files are read only on demand.
- **Priority:** it goes ahead of page syncs, like a button press, and waits for a sync that is already
  running.
- **Joining** *(builder's-reviewer question, settled by the author)*: a grading sync joins only a queued
  or running grading sync of the same task. A second call from the same session therefore follows the
  first call's run, so it never loops. It never joins a course run: a course run waits for no comment
  threads and reads no files.
- **When it completes:** the context is built from the database, as now. The `*_source` fields
  (`mastery_source`, `submission_comments_source`, `submission_files_source`) report what the sync read.
- **When it fails:** the tool answers with the error and the run id. It does not return stale data
  silently.
- **Lapsed session:** the queue would hold the run until a sign-in. Instead the tool answers at once:
  `SESSION_LAPSED`, the sign-in link (`https://prism.swordtail-everest.ts.net/settings#schoology-signin`),
  the task's last full sync time (`task_synced_at`), and the instruction to ask the teacher: sign in and
  call again, or call again with `use_stored_data: true`. With that flag the context is returned from the
  database with a `stale_data` warning at the top: "Data as of <last full sync>. Sign in to Schoology for a
  fresh sync."
- **Suggestions record their data time** *(author's call)*: every suggestion stores the task's
  `task_synced_at` when it is written. The assessment page shows "Suggested from data as of <time>" beside
  suggestions whose data time is more than 10 minutes older than the suggestion. The tool's inputs stay
  the same, so a skill cannot forget to pass it.

### Other Schoology work

- **Quiz loads become queue runs** *(author's call)*, from `load_quiz_results` and from the page's
  **Load** button (`server/routes/quizzes.js`), so the one-queue rule holds for the whole app. The session
  is checked before queueing: a lapsed session answers `NO_SESSION` at once and is never held. A load waits
  its turn behind a running sync, with the long-call handling below. `UNREACHABLE` and `BUSY` (the group
  is locked) keep their meaning.
- **Single reads and writes stay direct**, as the pages do them: `preview_status_line` (one comment read),
  `get_support_summary` (one PowerSchool page), and every write (status lines, unsubmit, FRQ marks, rubric
  attach). Their safety steps do not change: re-read, refuse if Schoology changed, write, read back.

### Long calls

A tool call can now wait for a queued sync (up to a few minutes behind a dashboard run). The tool sends MCP
progress notifications while it waits. The builder confirms Claude Code's tool timeout. If a wait can
exceed it, the tool answers before the timeout with the run id and a state to call again with, never a
silent failure.

## Verification

- **Tests:** the existing PrisMCP tests run against the HTTP transport (an in-process Express app), plus
  tests for the grading sync, the lapsed-session answer, `use_stored_data`, the dev-copy warning, the
  `Host` check and the quiz run.
- **Parity check** (`scripts/parity-prismcp-http.js`): every read tool, called through the old stdio path
  and through `/mcp` against the same database copy, with the same arguments; the answers must match
  except for the fields this design changes. Run on a scratch copy of prod made with `sqlite3 .backup`,
  then delete the copy.
- **One live check Graham approves** before the old path is removed: on a target he names, a status line
  through `/mcp` (preview, publish, read back, undo).
- **Both machines switched:** `claude mcp add --transport http prism https://prism.swordtail-everest.ts.net/mcp`
  on the laptop and on the mini, the old entries removed, and one grading run on each.
- **Definition of done:** root and client suites, build, CI green, prod serving the commit.

## Removal and documentation

- **Removed:** the stdio entry (`mcp/server.js` main), `mcp/dbGuard.js` and its test, the SSH and
  `DB_PATH` instructions.
- **Rewritten:** `docs/prismcp-install-and-verify.md` (one `claude mcp add` line per machine).
- **Updated:** `AGENTS.md` (the PrisMCP `DB_PATH` line), `docs/deploy.md`, ADR 0003 (option B adopted, with
  date), `.claude/build-progress.md`, `CONTEXT.md` if a term changes, tool descriptions in `mcp/server.js`.
- **Memory:** the "PrisMCP stale after deploy" note is retired.

## Left to the builder

- File layout (where the tools live once `mcp/` is part of the server).
- The queue's new run kinds and how the grading sync reuses the task run.
- Progress-notification wording and interval.
- The exact parity exceptions, each listed in the script with its reason.
