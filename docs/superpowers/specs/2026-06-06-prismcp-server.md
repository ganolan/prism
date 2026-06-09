# PrisMCP — MCP server bridging a grading agent to Prism (Project B)

**Date:** 2026-06-06
**Status:** Spec approved in brainstorm/grill (2026-06-06). Not yet implemented — planning/issues follow.
**Related:**
- Project A (render target): `docs/superpowers/specs/2026-06-04-prismcp-ui-design.md`, issue [#64](https://github.com/ganolan/prism/issues/64)
- Deferred Model A (per-question stats): [#83](https://github.com/ganolan/prism/issues/83)
- Rubric descriptors (forward-compat): [#67](https://github.com/ganolan/prism/issues/67)
- Teacher-context (the grading side): `Curriculum and Assessment/grading-workflow-and-prismcp-dovetail.md` (local, outside repo)

---

## 1. Scope

PrisMCP is a local **stdio MCP server** that lets an interactive Claude grading session (Graham, in
Claude Cowork / Desktop / Code, driven by his grading skills) **read** an assignment's roster, rubric
measurement-topics, and current grading state from Prism's local SQLite DB, and **write AI grading
suggestions back** into that DB. The Project A UI (`/assessment/:id`) already renders those
suggestions as the violet ✦ layer, where the teacher reviews and **publishes to Schoology
themselves**. PrisMCP never writes to Schoology.

**v1 covers the "assignment-style" (Model B) genre only** — portfolios, projects, essays, websites,
AR/IoT builds: anything graded to a per-student narrative comment + per-**measurement-topic**
proficiency levels, delivered with the work. These all share one write shape, so a new subtype needs
only a new grading skill, with **no MCP or UI change**.

### The loop PrisMCP enables

1. The agent calls `get_assignment_context` → roster (real names, `schoology_uid`), the assignment's
   aligned measurement topics (the rubric skeleton), current mastery levels + grade comments +
   display-to-student status, and any existing suggestions.
2. The agent grades **per the teacher's skills**, using its own file/browser tools. **PrisMCP never
   sees a submission.**
3. The agent calls `write_student_suggestions` (batched, whole class) and `write_assessment_analysis`.
4. The suggestions surface on `/assessment/:id` as the ✦ layer, coexisting with any grades already
   entered. The teacher reviews and publishes to Schoology.

### The boundary (why the server stays thin)

Markdown skills own the grading brain (philosophy, extraction, rubric application, output format,
delivery choice); they change often and are trivial to edit. PrisMCP owns only the thin, stable Prism
data plumbing. Full division of labour: `grading-workflow-and-prismcp-dovetail.md`. Consequences:

- The server holds **no grading philosophy, rubric logic, extraction recipe, or output formatting.**
- The orchestration `grade-assignment` prompt is **path-free**: it references instructions and
  submissions **by role/type, never by absolute path**, so it ships inside the repo and works for
  colleagues who don't have Graham's folders.

### Out of scope (v1)

- **Submission ingestion/extraction** — future, pending more Schoology-API discovery. *Not* a
  permanent "never"; the boundary is "eventually".
- **Writing to Schoology** — a standing guardrail (teacher publishes after review), not deferred.
- **Model A genres** (theory/validation, per-*question* data) — deferred to #83.
- **Rubric descriptor text** in context — deferred to #67 (`get_assignment_context` is
  forward-compatible to include it later).
- **Teacher in-progress drafts** in context — those live in browser `localStorage`, not the DB.
  Including them needs a separate server-side-draft-persistence change; `get_assignment_context` is
  forward-compatible to add them once they're in the DB.
- HTTP transport, multi-user/remote auth, live push of new suggestions to an open UI (the UI shows
  new suggestions on next load/refetch).

---

## 2. Architecture

- **Same repo, separate entrypoint.** New `mcp/` directory with `mcp/server.js`; an `npm run mcp`
  script. ESM (project is `"type": "module"`).
- **Transport:** `StdioServerTransport`. The MCP client spawns the server as a subprocess; the server
  opens the shared SQLite DB **directly** (it does **not** call Prism's Express server, which may not
  be running). All reads/writes are direct DB operations.
- **SDK:** `@modelcontextprotocol/sdk` (v1.x) + `zod` for input schemas. Use `McpServer` with
  `registerTool` / `registerResource` / `registerPrompt`.
- **DB resolution (portable):** open `students.db` resolved **relative to the server's own file
  location** (`mcp/server.js` → `../server/db/students.db`), honoring a `DB_PATH` env override. **No
  `CLAUDE_PROJECT_DIR` dependency** — Cowork/Desktop don't set it; resolving from the server file
  works identically in Claude Code and Desktop.
- **Reuse `getDb()`** (`server/db/index.js`) so schema creation (`CREATE TABLE IF NOT EXISTS`) and
  pragmas stay shared. WAL is already on. The MCP connection additionally sets
  `PRAGMA busy_timeout = 5000` so it and the Express server share the DB without write-conflict errors
  (see §7).
- **No new tables.** Writes target the existing `feedback` and `assessment_analysis` tables (both
  created by Project A).

---

## 3. Surface

PrisMCP exposes **tools** (the backbone the agent calls in a run), **resources** (an `@`-mention
read-only mirror for surgically pointing the agent at context), and one **prompt** (the orchestration
kickoff).

### 3.1 Tools

All `assignment_id` inputs accept the **Schoology** id or the **local** id and are resolved
internally (reuse the inbox resolver, §6). `course_id` is the **local** course id.

#### `list_courses`
Active (non-archived, non-excluded) courses, to resolve "which class".
```jsonc
// → [{ id, course_name, section_name, course_code, schoology_section_id }]
```

#### `list_assignments`
Args: `{ course_id }` (or a course name the tool resolves). Lets "the MAD project I just collected"
resolve to a concrete assignment.
```jsonc
// → [{ id, schoology_assignment_id, title, due_date, assignment_type,
//      has_aligned_topics: boolean, latest_submission_at: string | null }]
// latest_submission_at = max(grades.submitted_at) for the assignment, else null.
```

#### `get_assignment_context`
Args: `{ course_id, assignment_id }`. The primary read; composes the existing mastery roster/topics
query and the feedback for-assignment query.
```jsonc
{
  "assignment": { "id", "schoology_assignment_id", "title", "max_points", "grading_scale" },
  "topics": [                                   // aligned measurement topics = the rubric skeleton
    { "id", "external_id", "title", "category_title", "category_external_id" }
  ],
  "students": [{
    "id", "schoology_uid", "enrollment_id",
    "first_name", "last_name", "preferred_name",
    "current_scores": { "<topic_id>": { "level": "ED|EX|D|EM|IE" } }, // synced finals — level only; Prism owns the points conversion (never a bare number)
    "grade_comment": "string",
    "display_to_student": true,                 // comment_status (1 = visible)
    "exception": 0,                             // 0=none,1=Excused,2=Incomplete,3=Missing,4=Late
    "existing_suggestion": {                    // null when none; from draft/teacher_modified rows
      "status": "draft|teacher_modified",
      "narrative_feedback": "string",
      "rubric_scores": { "<topic key>": "ED|EX|D|EM|IE" },
      "reviewer_flags": "string|null"
    }
  }]
}
```
Does **not** include rubric descriptor text (#67) or teacher localStorage drafts (forward-compat).

#### `write_student_suggestions`
Args:
```jsonc
{
  "course_id", "assignment_id",
  "students": [{
    "student": "<schoology_uid | local id>",
    "narrative_feedback": "string?",
    "rubric_scores": { "<topic external_id | title>": "<level>" }?,  // level = code OR full name
    "reviewer_flags": "string?",
    "strengths": ["..."]?, "suggestions": ["..."]?
    // levels-only: no caller-supplied score — Prism owns the points conversion
  }]
}
```
Batched. Per student (see §4–§5): normalize levels, resolve topic keys, upsert the single active
suggestion row as `status='draft'`. Returns a per-student summary:
```jsonc
{ "results": [
  { "student", "status": "written" | "error",
    "feedback_id"?, "unresolved_topics"?: ["<key>"], "message"?: "string" }
]}
```
Unresolved topic keys and out-of-vocabulary levels are **reported** (not silently dropped) — a missing
grade is surfaced to the agent.

#### `write_assessment_analysis`
Args: `{ course_id, assignment_id, noticings: [{ title, body }], moderation_note?: string }`. Upserts
the single `assessment_analysis` row for the assignment.

### 3.2 Resources (read-only `@`-mention mirror)

Same reads as the tools, surfaced for `@prism:...` mentions so the teacher can inject Prism context
into an ad-hoc chat without running the grade prompt. Use `ResourceTemplate` for the parameterized
URIs.
- `prism://courses` → `list_courses` output
- `prism://course/{courseId}/assignments` → `list_assignments`
- `prism://assignment/{courseId}/{assignmentId}/context` → `get_assignment_context`

### 3.3 Prompt — `grade-assignment` (thin, path-free)

Args: `assignment` (free text), `assignment_type` (free-form hint, default `"portfolio"`). Expands —
server-side — to an orchestration message that carries **no grading content**:

> You are grading **{assignment}**. If the assignment is ambiguous, call `list_assignments` to resolve
> it. Call `get_assignment_context` to load the roster, aligned measurement topics, and current
> grading state. Then follow your **{assignment_type}** grading instructions (already provided in this
> chat's context) to grade the submissions provided in this chat. When done, call
> `write_student_suggestions` (whole class, one call) and `write_assessment_analysis`, then **stop and
> hand back to the teacher to review in Prism**.

It does **not** mention output/delivery choice — that's a skill step (the teacher's orchestration
skill asks "Prism only / also markdown / in-place?").

### 3.4 Server `instructions` (tool-search)

The server sets a concise (<2KB) `instructions` string so tool-search knows when to surface PrisMCP,
e.g.: *"Read a Prism-tracked course/assignment's roster, rubric measurement-topics, and current
grades, and write AI grading suggestions back into Prism for teacher review. Use when grading student
work for a course managed in Prism."*

---

## 4. Data contracts

### Proficiency vocabulary (five, incl. IE)

`ED / EX / D / EM / IE`. `write_student_suggestions` accepts **either the codes or the full names**
and normalizes to codes (case-insensitive):

| Full name | Code | Points |
|---|---|---|
| Exhibiting Depth | `ED` | 100 |
| Exhibiting | `EX` | 75 |
| Developing | `D` | 50 |
| Emerging | `EM` | 25 |
| Insufficient Evidence | `IE` | 0 |

Anything else is reported per-student as an error for that topic (never written). Stored value in
`feedback_json.rubric_scores` is the **code**, matching what the UI overlay (`resolveRubricScores`)
expects.

### Topic keying

`rubric_scores` keys are matched against the assignment's aligned topics by **`external_id` first,
then title** (both case-insensitive) — the same rule the UI uses. Keys that don't resolve are returned
in `unresolved_topics` for that student.

### `feedback_json` shape written

```jsonc
{
  "narrative_feedback": "string",
  "rubric_scores": { "<topic key as provided>": "ED|EX|D|EM|IE" },
  "reviewer_flags": "string|null",
  "strengths": ["..."], "suggestions": ["..."]
}
```
(The UI reads `narrative_feedback`, `rubric_scores`, `reviewer_flags`; `strengths`/`suggestions` are
carried through.)

### `assessment_analysis.analysis_json` shape

`{ "noticings": [{ "title", "body" }], "moderation_note"?: "string" }` — exactly what the UI's
Reviewer Analysis drawer reads.

---

## 5. Write semantics

- **Batched.** One `write_student_suggestions` call writes the whole class and returns a per-student
  summary.
- **One active suggestion per (student, assignment).** The MCP **upserts** — it finds the existing
  active `feedback` row for that (student, assignment) and updates it, else inserts. (This is stricter
  than the inbox importer's blind `INSERT`, which can pile up duplicate draft rows.)
- **Re-grade always writes a fresh suggestion as `status='draft'`**, pushing the prior `feedback_json`
  to `revision_history` first. No skipping of `teacher_modified`/`approved` rows.
- **Safety is structural:** the MCP writes **only** the `feedback` and `assessment_analysis` tables —
  **never** `mastery_scores`, `grades`, or Schoology. So a re-grade cannot clobber a grade or comment
  the teacher has entered (those live in different tables); the only thing superseded is the previous
  AI draft (kept in `revision_history`). This is what lets the AI ✦ coexist with already-entered
  grades, and re-surface on already-finished students.
- **UI interplay:** `GET /api/feedback/for-assignment/:id` returns `draft` + `teacher_modified` and
  excludes `approved`. Writing fresh suggestions as `draft` re-activates the ✦ overlay even on
  students the teacher had published. The open UI shows new suggestions on next load/refetch (no live
  push in v1).

---

## 6. Reuse & refactors

The MCP should **reuse query/write logic, not duplicate it**. Recommended extractions (small, behavior
preserving):

- **`server/services/assessmentContext.js`** (new): the roster + aligned-topics + comments/status
  query currently inline in `server/routes/mastery.js` `GET /:courseId/assignment/:assignmentId`, plus
  the suggestions read from `server/routes/feedback.js` `GET /for-assignment/:assignmentId`. Both the
  Express route and the MCP's `get_assignment_context` import it.
- **`server/services/idResolvers.js`** (new): extract `resolveStudentId` / `resolveAssignmentId` from
  `server/services/inbox.js`; import in both inbox and the MCP.
- **`server/services/suggestions.js`** (new): `upsertStudentSuggestion(...)` and
  `upsertAssessmentAnalysis(...)` implementing §4–§5 (normalize levels, resolve topic keys,
  push-to-revision-history, write `draft`). The MCP write tools call these; the inbox importer can
  later adopt the same upsert.
- Reuse `getDb()` (`server/db/index.js`) for the connection + schema.

---

## 7. Concurrency

The Express server and PrisMCP both open `students.db`. WAL is already enabled (concurrent readers +
one writer). The MCP connection sets `PRAGMA busy_timeout = 5000` so a write that briefly collides with
the server's write retries rather than throwing `SQLITE_BUSY`. Writes are short single-row upserts
wrapped in transactions. No schema changes, so the shared `CREATE TABLE IF NOT EXISTS` from `getDb()`
is safe from either process.

---

## 8. Dev / test story

- **Exercise the loop without a live grading run:** seed the same `feedback` rows the MCP writes via
  the existing inbox JSON path (`server/services/inbox.js`) — or call `write_student_suggestions`
  directly — then open `/assessment/:id` to see the ✦ layer. This is the same render path Project A
  tests use.
- **MCP unit tests:** test the tool handlers against a temp/`:memory:` DB seeded with a course +
  assignment + aligned topics + roster: `get_assignment_context` returns the composed shape;
  `write_student_suggestions` normalizes levels (names↔codes), resolves topic keys, reports unresolved
  keys, upserts one active row, and pushes prior content to `revision_history`;
  `write_assessment_analysis` upserts; re-grade leaves `mastery_scores`/`grades` untouched.
- **Manual smoke:** run `npm run mcp` from a client config (below), call each tool, confirm rows land
  and render.

---

## 9. Distribution / install

- **Claude Code:** project-scoped `.mcp.json` committed at repo root, so colleagues get PrisMCP on
  clone:
  ```json
  { "mcpServers": { "prism": { "type": "stdio", "command": "node", "args": ["mcp/server.js"] } } }
  ```
  Project-scoped servers require the user's one-time approval (`claude mcp` / the trust prompt). The
  prompt surfaces as `/mcp__prism__grade-assignment`; resources as `@prism:...`.
- **Claude Cowork / Desktop:** configured via the Desktop config / connector with an absolute
  `command`/`args` to `mcp/server.js` and (if needed) a `DB_PATH`. **Verify during the spike** exactly
  how Cowork surfaces MCP **prompts** (the prompt-picker UX) and resources, since Graham grades in
  Cowork — this is the one known-unknown; the server design doesn't depend on the answer, only the
  kickoff ergonomics do.

---

## 10. Staging & future (tracked separately)

- **Model A (theory/validation, per-question stats + feedback in Prism for analysis/viz)** — #83.
  The write contract extends to carry per-question data once a question-level store + UI exist.
- **Rubric descriptor text in `get_assignment_context`** — #67.
- **Teacher in-progress drafts in context** — needs server-side draft persistence (move
  `client/src/lib/assessmentDraft.js` localStorage into the DB); `get_assignment_context` is
  forward-compatible.
- **Submission ingestion** — future, pending Schoology-API discovery.
- **Live push of new suggestions to an open UI** — future; v1 relies on load/refetch.

---

## 11. Acceptance criteria

- `npm run mcp` starts a stdio MCP server that opens `students.db` resolved from the server file (or
  `DB_PATH`), with `busy_timeout` set, **without** requiring the Express server to be running.
- Tools registered and callable: `list_courses`, `list_assignments`, `get_assignment_context`,
  `write_student_suggestions`, `write_assessment_analysis`. Resources `prism://...` and prompt
  `grade-assignment` registered.
- `get_assignment_context` returns the §3.1 shape (roster + aligned topics + current finals/comments/
  display-status + existing suggestions) for a known assignment, accepting Schoology or local ids.
- `write_student_suggestions`: accepts level **names or codes** and normalizes; resolves topic keys by
  `external_id` then title and **reports** unresolved keys; upserts **one** active `draft` row per
  (student, assignment); pushes prior `feedback_json` to `revision_history`; leaves `mastery_scores`
  and `grades` untouched; returns a per-student written/skipped/error summary.
- `write_assessment_analysis` upserts the single `assessment_analysis` row in the UI-expected shape.
- Suggestions written by the MCP render as the ✦ layer / Reviewer Analysis drawer on `/assessment/:id`
  with no UI changes (Project A is the render target).
- The server contains **no** grading philosophy/rubric/extraction/output content and **no** path
  outside the repo; it never writes to Schoology and never reads submissions.

---

## 12. Verification

- `npx vitest run server/` (the new service + MCP handler tests pass; existing server tests stay
  green).
- Manual: configure the server in a client, run `grade-assignment` against a seeded assignment, confirm
  `feedback` + `assessment_analysis` rows land and render on `/assessment/:id`.
- Confirm concurrent operation: with the Express dev server running and the assessment page open, a
  `write_student_suggestions` call succeeds and the new ✦ appears after a refetch.
