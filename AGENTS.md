# AGENTS.md

Base context for any AI coding agent working in this repository. This is the
single source of truth — `CLAUDE.md` is a one-line import of this file, so edit
here, not there.

Tool-specific config lives elsewhere and is not duplicated below: Claude Code
reads `.claude/settings.json` (+ gitignored `.claude/settings.local.json`);
Codex reads `.codex/config.toml`. The `.claude/` directory also holds shared
reference docs that are useful to *every* agent (see Key References) — the name
is historical, the contents are plain markdown and not Claude-specific.

## Project Purpose

Prism is a local-first teacher dashboard for viewing, managing, and enriching student data from Schoology and PowerSchool. It combines a React frontend, an Express API, and a local SQLite database, with feature-flagged tools for analytics, notes, flags, feedback review, and future Schoology write-back workflows.

For the full product intent, roadmap, and phased requirements, see `product-spec.md`.

## Setup

```bash
npm install
cd client && npm install
```

Credentials live in `.env` (gitignored):
```
SCHOOLOGY_BASE_URL=https://api.schoology.com
SCHOOLOGY_CONSUMER_KEY=...
SCHOOLOGY_CONSUMER_SECRET=...
```

The SQLite database lives at `server/db/students.db` (gitignored). PowerSchool CSV drops go in `data/imports/`. Optional local overrides: `PORT`, `DB_PATH` (default `server/db/students.db`), `INBOX_DIR`, `CONFIG_PATH`.

Mastery sync (SBG data from Schoology's internal API) requires a one-time browser login:
```bash
npm run mastery:login   # Opens a browser — log in to Schoology, then close the window
```
Playwright browser binaries are installed automatically via `postinstall`.

## Running

If the dev server fails to restart (port already in use), kill stale processes first. Use `-sTCP:LISTEN` so the filter targets the dev-server listeners only — a plain `lsof -ti:5173` also returns any browser process with a tab open to the dev server, which SIGKILL'ing would take down the browser's network stack:
```bash
lsof -ti:3001 -sTCP:LISTEN | xargs kill -9 2>/dev/null; lsof -ti:5173 -sTCP:LISTEN | xargs kill -9 2>/dev/null
```

```bash
npm run dev        # Express + Vite
npm run dev:server # server only
npm run dev:client # client only
npm run build      # frontend production build
npm run test:api   # Schoology API smoke test
```

## Architecture

- **ESM project** (`"type": "module"` in package.json)
- **Local-first app** with React frontend, Express backend, and SQLite persistence
- **OAuth 1.0a** two-legged auth with PLAINTEXT signature via `oauth-1.0a` package
- Frontend talks to backend only through relative `/api/...` endpoints
- Feature flags live in `config.yaml`
- All Schoology API requests go to `https://api.schoology.com/v1/...` — never the school domain

### Frontend Conventions

- **Theming:** All colors must use CSS custom properties from `client/src/app.css` — never hardcode hex values in components. Use `var(--accent)`, `var(--bg-subtle)`, `var(--card-bg)`, etc.
- **Button classes:** Use `.primary`, `.secondary`, `.ghost` (with `.danger`, `.success`, `.accent` modifiers), `.tab-btn`, `.filter-btn` — avoid inline button styles.
- **Alert/banner classes:** Use `.alert.alert-warning`, `.alert.alert-success`, etc. instead of inline colored divs.
- **Page wrapper:** Add `className="fade-in"` to the top-level div of each page for entry animation.
- **Sidebar width:** 240px (set in CSS), content margin-left matches.
- **Adding new themes:** Add a `[data-theme="name"]` block in `client/src/app.css` with all CSS variables, add the theme key to `themes` in `client/src/hooks/useTheme.jsx`. No component changes needed.
- **Date formatting (UK/AU):** Render dates as `toLocaleDateString('en-GB')` → DD/MM/YYYY, never US M/D/YYYY (the user is Australian; Prism runs at HKIS). Formatting is currently scattered (`client/src/lib/courseDisplay.js` `formatLastSynced` uses `en-GB`; `client/src/pages/CoursePage.jsx` still uses `en-US` for time-of-day). A configurable app-wide locale (one `config.yaml` setting + a single shared `formatDate()` helper all dates funnel through) is a deferred follow-up — scope that refactor if asked to "make dates configurable".
- **Design language & decisions:** `docs/design-language.md` is the running log of Prism's visual patterns and the rationale behind UI decisions (tracked by #80). Reuse the shared primitives documented there — e.g. `.help-dot` + `.help-pop` (the instant help-"?" popover) and `.number-stepper` — instead of re-inlining them. **Whenever you make a notable UI/visual decision, append it to that doc** so the language can later be unified.

## Key References

- **How endpoints are discovered + the multi-surface architecture (read before any API spike)**: `.claude/api-exploration-playbook.md`. Core principle: a spike is a *lower bound*, not a conclusion — data visible in the UI is reachable, so if a probe didn't find it the wrong surface was tested. Scope every conclusion to the surface actually tested.
- **Schoology API quirks, verified endpoints, and SBG findings**: `.claude/schoology-api-reference.md`
- **PowerSchool API probe results and access plan**: `.claude/powerschool-api-reference.md`
- **Build progress across all phases**: `.claude/build-progress.md`
- **Product spec and roadmap**: `product-spec.md`

## Working Notes

- Check `.claude/build-progress.md` before starting any new phase to avoid repeating work.
- **Preserve verified API intel.** API findings are hard-won via fragile spikes (the playbook treats probes as lower bounds). When removing code that used a discovered API surface, keep its verified intel in `.claude/schoology-api-reference.md` / `.claude/powerschool-api-reference.md` — annotate the relevant row as superseded / no-longer-used (with date + why) but **never delete** the shape/keying/enum docs. Before deleting a parser, confirm everything it encoded is in the reference doc. (Example: `grader_header_data` was annotated "no longer consumed" — not removed — when the GHD pre-filter was dropped, 2026-06-08.)
- Schema uses `CREATE TABLE IF NOT EXISTS` for safe idempotent creation via `getDb()`. Columns added to an existing table go in the `MIGRATIONS` array in `server/db/index.js` **as well as** `server/db/schema.sql`, or existing local databases silently miss them.
- The school uses standards-based grading with measurement topics from PowerSchool. Per-topic ratings are NOT available via Schoology API — see `.claude/schoology-api-reference.md` for full details.
- Phase 5 (Schoology write-back) is on hold pending a safe testing strategy.
- **Prefer real automated tests over manual-only verification.** The user invests in durable test infra (server + client Vitest; client uses React Testing Library) even for small fixes — don't default to "skip tests, it's a small change." New backend logic → a `*.test.js` beside it; frontend → client tests. For API-shape changes, a live parity probe (`scripts/parity-*.js`) diffing old-vs-new against real data is the verification of choice (it has caught real bugs spikes missed).
- **Permission autonomy — "wildcards within reason."** Broad dev wildcards (`node:*`, `npm run:*`, `gh issue:*`, project-scoped `Write`/`Edit`) are acceptable to keep friction low; still favour a fixed-capability helper script for the bulk of a repeated workflow where one fits naturally (e.g. `scripts/inspect.js`, the probe scripts). Avoid clearly catastrophic patterns (`rm -rf` of broad paths, `git push --force`); keep `curl`/`wget` localhost-only (network-exfiltration vector). For Claude Code specifically: universal read-only command families live in user-level `~/.claude/settings.json`; project-specific grants in `.claude/settings.json` (committed) or `.claude/settings.local.json` (gitignored). Proactively offer to allow-list a safe read-only command that prompts repeatedly.

## API Spikes & Probes

Read `.claude/api-exploration-playbook.md` first — a spike is a *lower bound*, not a conclusion (if a probe didn't find data the UI shows, the wrong surface was tested). Operational gotchas that have silently produced false results:

- **Run Playwright/probe scripts from the repo root, never `/tmp`** — elsewhere they can't resolve the repo's `node_modules` (`ERR_MODULE_NOT_FOUND` on `import 'playwright'`). Keep probes under `scripts/`.
- **No `timeout` binary on macOS** — use your harness's own timeout parameter, not `timeout 300 node …` (which no-ops).
- **Confirm session liveness with one cheap authenticated request, not the cookie-expiry timestamp.** The Schoology Drupal session (and the PowerSchool session) can be valid server-side long after the Microsoft SSO cookies in `.playwright-session/storage-state.json` show "expired". Login only refreshes SSO.
- **PowerSchool LTI launch:** the LTI run-URL form does NOT auto-submit under `page.goto` — call `document.forms[0].submit()`, then poll for the `powerschool.hkis.edu.hk` origin. The embedded PS iframe **detaches mid-loop**, so do an independent `page.goto` per request for multi-read sweeps (a shared-frame loop failed 5/6; per-nav got 6/6).
- **`/ws/pt/v1/...` content negotiation:** always send `Accept: application/json` — without it these PowerSchool endpoints 500 ("no message body writer", a header quirk, not "broken"); with it you get the real status.
- **Resolve ids before probing** — a 404 on a `null`/guessed id is not a missing route. Pull ids from a live session JSON (roster / LTI launch form), not a throwaway script whose `apiGet` returned `null` because `.env` wasn't loaded.
- **A list endpoint returning a record does not mean the record is current.** Schoology keeps returning dropped students from `/sections/{id}/enrollments` with `status: "5"`; filtering on `admin` alone re-added them every sync (#128). Check for a lifecycle/status field before treating a list response as "the current set".
- **Never document a response shape you didn't observe in tool output.** Fabricated shapes have been committed + posted publicly before; a documented shape must trace to a specific probe result. Re-read the actual JSON before each api-ref edit. (Pairs with "Preserve verified API intel" above.)
- **Discovery method ranking:** driving the real page and capturing its XHRs is most reliable; grepping the cross-origin React/Angular bundles (`asset-cdn.schoology.com`, the PS attendance app bundle) for `/iapi(2)/` / `/ws/` literals is a strong second — then live-probe each literal.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `ganolan/prism` (uses the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
