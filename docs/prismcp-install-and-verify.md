# PrisMCP: install and verify

Operational guide for PrisMCP, Prism's MCP server for AI grading (spec: `docs/superpowers/specs/2026-06-06-prismcp-server.md`, tracking issues #84 and #131). Since 20/10/2026 **the Prism server hosts PrisMCP at `/mcp`** over streamable HTTP. No PrisMCP process runs on the laptop or the mini, and none opens the database. The server owns the database, the saved Schoology session, the Schoology API keys and the sync queue. An interactive Claude grading session reads a Prism course or assignment (roster, rubric measurement topics, current grades) and writes AI grading **suggestions** back into Prism for teacher review on `/assessment/:id` (the violet ✦ layer).

The design is `docs/superpowers/specs/2026-10-20-prismcp-over-http-design.md`. The operations side is in `docs/deploy.md`.

**It writes to Schoology only through Prism's status lines** (triage resubmissions spec Amendment B, 2026-10-03). A status line is a single line at the top of a student's Schoology grade comment, never a score:

- `request_resubmission`, `grade_stands` and `extend_deadline` publish one **only when the caller passes `comment_line`**. The caller first calls `preview_status_line` to render it.
- `undo_extension` removes the line that extension published **only when the caller passes `remove_line: true`**.
- `preview_status_line` writes nothing, but it does a fresh **read** of the student's Schoology comment.

Omitting `comment_line` or `remove_line` keeps the action Prism-only, as with every other write below. These tools use the Schoology credentials in the server's `.env` (see [Schoology credentials](#schoology-credentials-for-the-status-line-tools-since-2026-10-03)).

## Tools

- **Courses and rosters:** `list_courses` (`include_archived: true` adds archived courses with `school_year` and `term`), `list_assignments`, `list_students` (`include_dropped: true` adds leavers).
- **Grading:** `get_assignment_context` (forces a Schoology sync of the task first, see [Grading sync](#the-grading-sync-get_assignment_context)), `write_student_suggestions`, `write_assessment_analysis`.
- **Linked quizzes:** `list_quiz_groups`, `load_quiz_results`, `set_question_tags`. `load_quiz_results` reads the attempts from Schoology through the saved session and sends nothing to Schoology. It stores them in Prism, replaces any earlier load and removes attempts that were deleted in Schoology. It runs as a run in Prism's sync queue, so it waits behind a running sync (`server/services/quizRun.js`). It fails with `NO_SESSION` when the saved login has expired, `UNREACHABLE` when Schoology could not be reached (try again, the session is not at fault), `BUSY`, or `PENDING` when it is still going after about 50 s. `PENDING` carries the sync run id: call again to join that run.
- **Rubrics:** `list_rubrics`, `read_rubric`, `write_rubric`, `attach_rubric`.
- **Resources and prompt:** `prism://courses`, `prism://course/{courseId}/assignments`, `prism://assignment/{courseId}/{assignmentId}/context` (a database read with no sync), and the `grade-assignment` prompt.
- **Triage:** `get_triage` (the late-work referral watch, feedback-owed, make-up-test and **resubmission** lists, with the same numbers as the dashboard; each row's `day` counts the due or test date as day 1; referral after day 8, feedback overdue after day 10 by default). `get_submission_status` (roster-wide submission state for a course, one assignment or one student, for "who has not submitted X?", with a ready-to-paste email list; `status` defaults to `not_submitted`, the whole-school view, and `all` needs a course, `assignment_id` or student because it lists every item). `list_referrals` (history: `{ referrals, extensions }`). `school_calendar` (school-day information and counts between dates).
- **Triage writes:** `record_referral` (mark a late-work row at the limit as referred), `undo_referral` (delete a referral by id), `extend_deadline` (give one student N more lessons, counted in school days, on a summative task, a Schoology test or quiz, or via `resubmission_id` an open resubmission request; on a make-up it moves the make-up clock), `undo_extension` (delete an extension by id, with `remove_line: true` to also remove the status line it published), `set_makeup_tracking` (ignore one Schoology test or quiz for make-ups, or track it again, for all students).
- **Resubmissions (Amendment B):** `request_resubmission` (ask a student to resubmit, with a deadline in lessons), `grade_stands` (close an open request once its deadline has passed, with no resubmission, so the original grade stands), `preview_status_line` (render the exact status-line text and due date before publishing; never guess them), `list_resubmissions` (history by course, student, since and state). An arrival clears only on genuinely new visible feedback.
- **Student history (read-only, since 2026-10-08):** `find_student` (by legal or preferred name, email, email number or uid, across archived years, with graduation year and courses to distinguish same-named students) and `get_student_history` (every course and year with the teacher: per assessment the overall level, levels per measurement topic and the grade comment verbatim; published finals only, never AI suggestions; summative-only by default with `omitted` counts; `detail: 'compact'` and `limit` / `offset` paging). See `docs/superpowers/specs/2026-10-08-prismcp-student-history-design.md`.

## Install

One line per machine, on the laptop and on the mini. It adds the tools to Claude Code for every project (user scope):

```bash
claude mcp add --transport http -s user prism https://prism.swordtail-everest.ts.net/mcp
```

Nothing else is needed. The command holds no path, key or SSH setting. Prism has no login, and the tailnet is the perimeter (ADR 0003), so the machine must be on the tailnet.

**If the machine still has the old entry** (a `node` or `ssh` command that ran `mcp/server.js`), remove it first. The file no longer exists, so the old entry cannot start:

```bash
claude mcp remove prism -s user
claude mcp remove prism -s local   # only if an old per-project entry exists
```

Local scope outranks user scope, and project scope (`.mcp.json`) outranks both. There is no committed `.mcp.json`, so a committed `prism` entry cannot override this one.

A machine with no `prism` entry has no prism tools. That is visible, not silent.

Open Claude Code sessions use the new tools at the next call after a deploy, because the tools run in the server. There is nothing to reconnect after a deploy. See [Deploys](#deploys-and-dropped-calls).

### Codex

The repository's `.codex/config.toml` points Codex at the same endpoint (`url = "https://prism.swordtail-everest.ts.net/mcp"`). This entry is not verified with Codex.

### Claude Desktop and Cowork

This guide covers Claude Code. Claude Desktop starts local commands from `~/Library/Application Support/Claude/claude_desktop_config.json`, and the old `prism` entry there (`node` on `mcp/server.js`, or `ssh`) no longer works. Quit Desktop (Cmd-Q), remove the `prism` entry from `"mcpServers"`, then reopen it. Desktop keeps the config in memory and can write it back over an edit made while it runs. Connecting Desktop to the HTTP endpoint is not verified.

How Desktop showed the earlier server (2026-06-06): the `grade-assignment` prompt as "Grade an assignment (Prism)" under the composer's **＋ → Connectors → Add from prism**, and `prism://courses` as "Prism courses". The templated resources did not appear, and `@`-mention did nothing. Claude Code shows the prompt as `/mcp__prism__grade-assignment` and resources as `@prism:...`.

## Verify an endpoint

```bash
node scripts/check-mcp-endpoint.js                                 # prod, over the tailnet
node scripts/check-mcp-endpoint.js http://127.0.0.1:3002/mcp --expect-dev   # a dev copy
```

The script connects the way Claude Code does, lists the tools and calls `list_courses`. It prints counts only, never course names, for example `https://prism.swordtail-everest.ts.net/mcp: 36 tools; list_courses 12 courses; prod` (an example of the format, not a measured count). It exits 0 when the endpoint answers and is the kind expected: prod, or with `--expect-dev` a dev copy. It exits 1 when the endpoint does not answer, `list_courses` fails, or the endpoint is the other kind. Run it after an install, after a deploy that touched `/mcp`, and before grading from a new machine. Its test is `scripts/check-mcp-endpoint.test.js`.

Check the Claude Code side with `claude mcp list`: `prism` shows as connected.

## Dev copies

A dev clone's server also serves `/mcp` (a server whose `/api/version` mode is not `release` is a dev copy). Its database is a disposable snapshot of prod. So that grading on it cannot be mistaken for the real thing:

- **Every tool result starts with a warning:** "This is a dev copy of Prism: its data is replaced at the next refresh, and it refuses Schoology writes."
- **Schoology writes are refused** with the code `DEV_COPY` (a status line, an LTI unsubmit). Students would see the write, and prod would have no record of it. Nothing is published, unsubmitted or recorded. Prism-only calls still work.
- **Suggestions written to a dev copy are lost** at the next `npm run db:refresh`. Never grade for real on one.

To point Claude Code at a dev copy, give it a different name. Do not reuse `prism`, because local scope outranks user scope and would hide prod:

```bash
claude mcp add --transport http -s local prism-dev http://127.0.0.1:3002/mcp
node scripts/check-mcp-endpoint.js http://127.0.0.1:3002/mcp --expect-dev
```

Remove it when finished: `claude mcp remove prism-dev -s local`. `/mcp` accepts the `Host` names `127.0.0.1`, `localhost` and the hosts in `config.yaml` `server.allowedOrigins`. Another name gets a 403.

## The grading sync (`get_assignment_context`)

`get_assignment_context` forces a **grading sync** of the task before it answers. This is a run in the sync queue that reads the task's details, submissions, grades, mastery levels and grade comments, waits for the comment threads, and reads the files of every student who uploaded. The run goes ahead of page syncs and waits for a sync that is already running.

- **Skipped when fresh:** if the task's last grading sync (`assignments.grading_synced_at`, stamped only by a grading run that read everything; a plain Sync Assignment or course sync does not count) finished under 5 minutes ago, the tool does not read again. Delivery, calibration and rubric review call the tool several times in one session, and this stops each call from waiting.
- **Live timings (prod, 20/10/2026):** the first call took 20.9 s. A second call within 5 minutes answered in 65 ms.
- **What the answer reports:** `data_as_of` is the task's last full sync. `mastery_source`, `submission_comments_source` and `submission_files_source` report what the sync read. For a fresh answer, each of the three notes that the earlier grading sync read it.
- **Suggestions record their data time:** the answer records, on the assignment, the data time and the moment it was served. The suggestions written later carry both, so Prism's stale-data banner judges the data the agent was given, however long grading took.
- **Progress:** while it waits, the tool sends MCP progress notifications every 10 s when the client asked for them.
- **Config:** a source switched off in `config.yaml` (`submission_comments`, `submission_files`) is not read. Its `*_source` answers `cached_only: true` with "is off in config.yaml".

The tool never returns older data silently. Its errors start with a code:

- `SESSION_LAPSED`: the saved Schoology session has expired, or was lost during the sync. The error carries the sign-in link (`https://prism.swordtail-everest.ts.net/settings#schoology-signin`) and the task's last full sync. **The agent asks the teacher** to sign in and call again, or to call again with `use_stored_data: true`. That flag skips the sync and returns the context from the database, with `stale_data` ("Data as of <time>. Sign in to Schoology for a fresh sync.") as its first key. The agent never chooses stored data itself.
- `SYNC_FAILED`: the run failed or finished with errors. The error names the run and the reason. **The agent reports to the teacher** what failed. The teacher may retry (calling again starts a new run) or, if a read keeps failing, choose `use_stored_data: true` (the stored data, with the `stale_data` warning). The agent never chooses stored data itself.
- `SYNC_PENDING`: the run is still going after about 50 s, for example because it waits behind a dashboard sync. Calling again follows the same run.
- `NOT_FOUND`: no such assignment, or Schoology no longer has the task.

### Deploys and dropped calls

The server keeps no MCP session, so a restart ends no session. A call that is in flight during a deploy restart gets a dropped connection. The next call starts a fresh run. Call again.

## The saved Schoology session

`request_resubmission` unsubmits submitted OneDrive (LTI) work by default (`unsubmit`), and the grading sync reads comments and files. Both use the saved Schoology session over plain HTTP, not the API keys and not a browser. The server finds it through `PRISM_SESSION_DIR` (on the mini, `~/prism/data/.playwright-session`). The teacher signs in from Settings (`#schoology-signin`). A lapsed session shows as `SESSION_LAPSED` above. For `request_resubmission` it fails safely: the ask is recorded, and the tool result carries the Schoology link so the teacher can unsubmit by hand.

## Schoology credentials for the status-line tools (since 2026-10-03)

Prism's Schoology client reads `SCHOOLOGY_BASE_URL`, `SCHOOLOGY_CONSUMER_KEY` and `SCHOOLOGY_CONSUMER_SECRET` from the server's environment, which the server loads from its own `.env` (`~/prism/data/.env` on the mini, mode 600). They are needed for `preview_status_line`, for `request_resubmission`, `grade_stands` and `extend_deadline` with `comment_line`, and for `undo_extension` with `remove_line`. No machine that runs Claude holds them.

If one is missing, those tools fail before touching anything with `SCHOOLOGY_NOT_CONFIGURED: Prism cannot reach Schoology: ... missing from the server's .env: nothing was read, published or recorded`. Add the variables to the server's `.env` and restart the server (`docs/deploy.md`). Every other tool works without them, and so do the same actions without `comment_line` or `remove_line`.

## Parity check

`scripts/parity-prismcp-http.js` compares every read tool called two ways with the same arguments on the same database copy: the handlers called directly (as `mcp/server.js` `createServer()` builds them, the path the removed stdio entry served) and the server's `/mcp`. Run it on a scratch copy, never on the live database:

```bash
sqlite3 ~/prism/data/students.db ".backup <copy>"          # a copy of prod
DB_PATH=<copy> PORT=3002 npm run dev:server               # a dev copy on the scratch database
node scripts/parity-prismcp-http.js --url http://127.0.0.1:3002/mcp --db <copy>
npm run dev:stop                                          # then delete <copy>
```

It prints one line per call: `same`, the differing paths, or `FAILED`. Each exception lists its reason in the script. It exits 1 on any difference, an errored call, an uncovered tool or a target that is not a dev copy. Its output holds no answers, but the copy holds student data: delete it when done.

Result on 20/10/2026, on a copy of prod: 23 of 23 calls the same. Coverage 36 of 36 tools: 18 compared, 3 excluded, 15 writers (not called).

## Verify a change

### 1. Automated

```bash
npx vitest run                  # root: server, mcp/, scripts/ (includes server/routes/mcp.test.js, the /mcp transport)
cd client && npx vitest run
```

`server/routes/mcp.test.js` drives the tools through a real HTTP client against an in-process Express app. Then run `node scripts/check-mcp-endpoint.js` against the deployed server.

### 2. Manual render check on `/assessment/:id`

The headless e2e proves the data path; this confirms the pixels.

1. Open the app on a dev copy (`PORT=3002 npm run dev` on the mini) or, to grade for real, on prod. Check what answers with `node scripts/check-mcp-endpoint.js <url>/mcp`.
2. Open a real assignment in the app and note its **course id** and **Schoology assignment id** (the assessment page URL / the mastery route uses the Schoology id).
3. From **Claude Code** (with `prism` configured per machine, see Install), run the real workflow against that assignment: `/mcp__prism__grade-assignment`, or call `write_student_suggestions` + `write_assessment_analysis` directly with one or two students.
4. Reload `/assessment/:id` and confirm:
   - [ ] violet ✦ dashed ring on the suggested rubric cell(s), **coexisting** with any teacher mark on the same row (agree-case = solid border + dashed ring + ✦);
   - [ ] the `✦ Suggested feedback` box + `↑ Use suggestion`;
   - [ ] the `⚑ Reviewer flags` strip as short bullet lines (`reviewer_flags_brief` when written, else the first sentence of each `reviewer_flags` paragraph), with the full text behind `▾ Show detailed flags`;
   - [ ] the `✦ Reviewer Analysis` button → drawer with the proposed distribution + noticings (when `write_assessment_analysis` was called).
5. **Concurrent check:** with the page open, run another `write_student_suggestions`. Reload the page: the new ✦ appears (there is no live push, so a reload is expected).
6. **Score-scale suggestions (#41):** for an unaligned assignment (`list_assignments` shows a `score_scale`, e.g. "Completion Scale"), `get_assignment_context` returns `score_scale.levels` (best → worst) and each student's `current_scale_level`. Write `scale_level` (code or label) plus a teacher-facing `evidence` note instead of `rubric_scores`. This is the path for an agent that checks a third-party platform and marks work Completed. Reload `/assessment/:id` and confirm:
   - [ ] the suggested level shows the violet ring and a `✦ Suggested` tag, with `✦ Suggested <level>: <evidence>` under the level buttons;
   - [ ] the class bar shows `✦ Accept all suggestions (N)` (N = suggestions that differ from the current grade, on unlocked students). It only **stages** them; `Publish all` is still the teacher's step;
   - [ ] a level outside the assignment's scale is rejected with a message naming the valid levels (verified 2026-09-28: "Great" → rejected; "Consistent" / "i" → C / I).

## Guardrails (confirmed 2026-06-06)

- [x] The server contains **no** grading philosophy, rubric, extraction or output content.
- [x] It never writes a score to Schoology. *(Amended 2026-10-03: the status-line tools listed at the top write one line of a student's Schoology comment, only when given `comment_line` or `remove_line`.)*
- [x] Grading writes target only the `feedback` and `assessment_analysis` tables, never `mastery_scores` or Schoology. *(Amended 2026-10-03: the triage tools also record referrals, extensions and resubmissions, and a published or removed status line is mirrored into `grades` and `status_lines`.)*
- [x] Only the Prism server opens the database. *(Since 2026-10-20, #131: the stdio entry, its `DB_PATH` guard and the SSH setup are removed.)*
