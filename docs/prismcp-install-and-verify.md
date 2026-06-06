# PrisMCP — install & verify

Operational guide for the PrisMCP server (spec: `docs/superpowers/specs/2026-06-06-prismcp-server.md`, tracking issue #84). PrisMCP is a local **stdio** MCP server that lets an interactive Claude grading session read a Prism course/assignment's roster, rubric measurement-topics, and current grades, and write AI grading **suggestions** back into Prism's local SQLite DB for teacher review on `/assessment/:id` (the violet ✦ layer). **It never writes to Schoology** and never reads submissions.

Surface: tools `list_courses`, `list_assignments`, `get_assignment_context`, `write_student_suggestions`, `write_assessment_analysis`; `@`-mention resources `prism://courses`, `prism://course/{courseId}/assignments`, `prism://assignment/{courseId}/{assignmentId}/context`; and the `grade-assignment` prompt.

## Install

### Claude Code (committed, zero-config)

The project-scoped `.mcp.json` at the repo root is committed, so on clone Claude Code offers to connect the `prism` server. Approve it once (the trust prompt, or `claude mcp`). It then surfaces:

- prompt → `/mcp__prism__grade-assignment`
- resources → `@prism:...`

No paths to configure — the server resolves `students.db` relative to its own file (`mcp/server.js` → `../server/db/students.db`).

### Claude Desktop / Cowork (absolute path)

Desktop/Cowork spawn the server with an **absolute** command. Add to the Desktop MCP config (Settings → Developer → Edit Config, or the connector UI), then **restart Desktop**:

```json
{
  "mcpServers": {
    "prism": {
      "command": "node",
      "args": ["/Users/gnolan/Library/CloudStorage/OneDrive-HongKongInternationalSchool/_repos/prism/mcp/server.js"]
    }
  }
}
```

- The DB resolves automatically (relative to the server file). Only add `"env": { "DB_PATH": "/abs/path/to/students.db" }` if your DB lives elsewhere.
- The path contains spaces — keep it as a single array element (shown above); don't split it.

## Verify

### 1. Automated headless e2e — one command

```bash
npm run mcp:e2e
```

Seeds a **throwaway temp DB** (never `students.db`), spawns `mcp/server.js` over real stdio, runs the `grade-assignment` prompt + both write tools, then reads the result back from a separate ("Express-side") connection. Expect 5× `PASS`, proving the full loop and cross-process WAL coexistence (spec §7).

Also useful: `npx vitest run` (the 188 unit/integration tests, incl. the MCP handlers, must stay green).

### 2. Manual render check on `/assessment/:id`

The headless e2e proves the data path; this confirms the pixels.

1. `npm run dev` (Express :3001 + Vite :5173).
2. Open a real assignment in the app and note its **course id** and **Schoology assignment id** (the assessment page URL / the mastery route uses the Schoology id).
3. From **Claude Code** (where PrisMCP is connected via `.mcp.json`), run the real workflow against that assignment — `/mcp__prism__grade-assignment`, or call `write_student_suggestions` + `write_assessment_analysis` directly with one or two students.
4. Reload `/assessment/:id` and confirm:
   - [ ] violet ✦ dashed ring on the suggested rubric cell(s), **coexisting** with any teacher mark on the same row (agree-case = solid border + dashed ring + ✦);
   - [ ] the `✦ Suggested feedback` box + `↑ Use suggestion`;
   - [ ] the `⚑ Reviewer flags` strip (when `reviewer_flags` was written);
   - [ ] the `✦ Reviewer Analysis` button → drawer with the proposed distribution + noticings (when `write_assessment_analysis` was called).
5. **Concurrent check:** with the page open and the dev server running, run another `write_student_suggestions`; reload → the new ✦ appears (v1 has no live push, so a reload/refetch is expected).

### 3. Cowork/Desktop prompt-picker spike — RESOLVED (2026-06-06, Claude Desktop)

How PrisMCP surfaces in **Claude Desktop**: under the composer's **＋ → Connectors → Add from prism** submenu — **not** as `/` slash commands and **not** via `@`-mention (that's the Claude Code surface).

- **`grade-assignment` prompt** → listed as **"Grade an assignment (Prism)"** (chat-bubble icon). Selecting it inserts the orchestration message; the `assignment` / `assignment_type` args are given inline in the chat.
- **`prism://courses` resource** → listed as **"Prism courses"** (document icon). The *templated* resources (`.../assignments`, `.../context`) do **not** appear as menu items — they need parameters, so the agent reaches that data through the `list_assignments` / `get_assignment_context` **tools** instead.
- **`@`-mention does nothing** for resources in Desktop — resource attachment lives in the "Add from prism" menu, not `@`.
- In practice the picker is optional: a plain instruction at the end of a grading run — *"upload the student feedback to prism"* — makes the agent call the write tools directly. **Confirmed end-to-end on a real grading run.**

Claude Code surfaces the same prompt as `/mcp__prism__grade-assignment` and resources as `@prism:...`.

## Guardrails (confirmed 2026-06-06)

- [x] The server contains **no** grading philosophy / rubric / extraction / output content, and **no** path outside the repo.
- [x] It never writes to Schoology and never reads submissions.
- [x] Writes target only the `feedback` and `assessment_analysis` tables — never `mastery_scores`, `grades`, or Schoology.
