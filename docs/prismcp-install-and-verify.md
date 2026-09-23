# PrisMCP — install & verify

Operational guide for the PrisMCP server (spec: `docs/superpowers/specs/2026-06-06-prismcp-server.md`, tracking issue #84). PrisMCP is a local **stdio** MCP server that lets an interactive Claude grading session read a Prism course/assignment's roster, rubric measurement-topics, and current grades, and write AI grading **suggestions** back into Prism's local SQLite DB for teacher review on `/assessment/:id` (the violet ✦ layer). **It never writes to Schoology** and never reads submissions.

Surface: tools `list_courses`, `list_assignments`, `get_assignment_context`, `write_student_suggestions`, `write_assessment_analysis`; `@`-mention resources `prism://courses`, `prism://course/{courseId}/assignments`, `prism://assignment/{courseId}/{assignmentId}/context`; and the `grade-assignment` prompt.

## `DB_PATH` is required, and must be absolute (since 2026-09-23)

**PrisMCP refuses to start unless `DB_PATH` is set to an absolute path.** It
writes grading suggestions straight into SQLite and loads no dotenv, so the
path it is given *is* the database every write lands in — and every write
reports success. A wrong path is silent; on a disposable dev clone the work is
erased at the next `npm run db:refresh`.

A relative path is refused because it resolves against whichever directory
the client launched from. `:memory:` and `file:` URIs are accepted.

## Install

### Claude Code — once per machine, user-scoped

There is **no committed `.mcp.json`**. Claude Code ranks project scope
(`.mcp.json`) above user scope, so a committed `prism` entry would silently
override the route to the server's database on every machine. Configure it
once per machine instead:

**Before cutover** — the laptop is master and grades against its own clone:

```bash
claude mcp add prism -s user -e DB_PATH="$HOME/repos/prism/server/db/students.db" -- /usr/local/bin/node "$HOME/repos/prism/mcp/server.js"
```

**After cutover** — the cutover script prints both of these:

```bash
# on the mini: straight at prod
claude mcp remove prism -s user
claude mcp add prism -s user -e DB_PATH=/Users/gnolan/prism/data/students.db -- /usr/local/bin/node /Users/gnolan/prism/current/mcp/server.js

# on the laptop: over SSH to the mini (needs Remote Login on the mini)
claude mcp remove prism -s user
claude mcp add prism -s user -- ssh gnolan@macmini 'cd ~/prism/current && DB_PATH=$HOME/prism/data/students.db /usr/local/bin/node mcp/server.js'
```

The SSH command is single-quoted so `~` and `$HOME` expand **on the mini**.
`/usr/local/bin/node` is spelled out because a non-interactive SSH session's
`PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`. MCP is a stdio protocol and does
not care that the pipe runs through SSH; Claude, the grading plugin and the
prompts stay on the laptop.

Check with `claude mcp list`. **Local scope outranks user scope**, so if an old
per-project entry exists, remove it: `claude mcp remove prism -s local`.
PrisMCP logs the database it opened to stderr at startup
(`[prismcp] database: …`).

A machine with no `prism` entry simply has no prism tools — visible, not silent.

### Claude Desktop / Cowork (absolute path)

Desktop/Cowork spawn the server with an **absolute** command. Add to the Desktop
MCP config (Settings → Developer → Edit Config, or the connector UI), then
**restart Desktop**:

```json
{
  "mcpServers": {
    "prism": {
      "command": "node",
      "args": ["/Users/gnolan/repos/prism/mcp/server.js"],
      "env": { "DB_PATH": "/Users/gnolan/repos/prism/server/db/students.db" }
    }
  }
}
```

- Both paths are absolute, and `DB_PATH` is mandatory (see above).
- If a path contains spaces, keep it as a single array element; don't split it.

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
3. From **Claude Code** (with `prism` configured per machine — see Install), run the real workflow against that assignment — `/mcp__prism__grade-assignment`, or call `write_student_suggestions` + `write_assessment_analysis` directly with one or two students.
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
