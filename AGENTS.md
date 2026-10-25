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

The SQLite database lives at `server/db/students.db` (gitignored). PowerSchool CSV drops go in `data/imports/`. Optional local overrides: `PORT`, `HOST` (default `127.0.0.1`), `DB_PATH` (default `server/db/students.db`), `PRISM_SESSION_DIR`, `CONFIG_PATH`, `PRISM_SKIP_BROWSERS`, `PRISM_SCHEDULED_SYNC` (`1` arms the nightly scheduled sync; set only by the prod launchd agent, never in a dev clone). PrisMCP needs no setting of its own: the Prism server hosts it at `/mcp` (20 Oct 2026, #131), and each machine installs it with one `claude mcp add --transport http` line, see `docs/prismcp-install-and-verify.md`.

Mastery sync (SBG data from Schoology's internal API) requires a one-time browser login:
```bash
npm run mastery:login   # Opens a browser — log in to Schoology, then close the window
```
Playwright browser binaries are installed automatically via `postinstall`.

## Running

**Prod may be listening on this machine.** Prod runs on the Mac mini at `127.0.0.1:3001` (launchd `com.prism.server`, cwd `~/prism/releases/…`), and dev clones live on the mini too — check `hostname` (`macmini.local`) before assuming you're on a laptop. So:

- **Never kill by port** (`lsof -ti:3001 | xargs kill`). On the mini that kills **prod** (it happened 2026-09-28; the watchdog restarted it). To stop a stale dev server use `npm run dev:stop`, which only stops listeners whose working directory is inside this clone and reports anything else it leaves alone.
- `npm run dev` / `dev:server` run a preflight (`scripts/dev-ports.js check`) that **refuses to start** if the API port is taken, naming the holder. If it says the holder is not this clone, don't kill it — start the dev copy on its own port: `PORT=3002 npm run dev` (the Vite proxy follows `PORT`). Never bypass the preflight: a dev API that loses the port race leaves the dev UI proxying to prod's real data.

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
- **No CORS; writes only from Prism's own pages** (18 Oct 2026): the API sends no CORS headers, and `server/middleware/originGuard.js` refuses any non-GET request whose `Origin` is another site (no `Origin`, as from curl or Claude Code, is fine). Allowed: the request's own host or `X-Forwarded-Host`, plus `config.yaml` `server.allowedOrigins` (prod's tailnet address). The Vite dev proxy sends `X-Forwarded-Host` (`client/devProxy.js`, `xfwd`). A new client on another origin needs its origin added there.
- Feature flags live in `config.yaml`
- **PrisMCP is part of the server** (20 Oct 2026, #131): `server/routes/mcp.js` serves the tools of `mcp/server.js` at `/mcp` over stateless streamable HTTP, behind the same `originGuard` plus a `Host` check. Claude Code reaches `https://prism.swordtail-everest.ts.net/mcp`. No other process opens the database. `node scripts/check-mcp-endpoint.js [url] [--expect-dev]` checks an endpoint.
- All Schoology API requests go to `https://api.schoology.com/v1/...` — never the school domain

### Frontend Conventions

- **Theming:** All colors must use CSS custom properties from `client/src/app.css` — never hardcode hex values in components. Use `var(--accent)`, `var(--bg-subtle)`, `var(--card-bg)`, etc.
- **Button classes:** Use `.primary`, `.secondary`, `.ghost` (with `.danger`, `.success`, `.accent` modifiers), `.tab-btn`, `.filter-btn` — avoid inline button styles.
- **Alert/banner classes:** Use `.alert.alert-warning`, `.alert.alert-success`, etc. instead of inline colored divs.
- **Letter grades come only from HKIS's chart** (#193): `client/src/lib/hkisLetterGrade.js` (`computeLetterGrade` is a lookup in it; 2 to 5 categories, any IE is F). Show the chart with `GradeScaleHelp` (`components/GradeScale.jsx`), never a copy of the table.
- **One grade card:** `client/src/components/gradeCard/StudentRubricCard.jsx` is the only component that draws a student's grade and comment on a task (#176). View mode is the student page and the gradebook pop-up (Edit switches to edit mode in place); edit mode is the assessment page. Change the card, not a copy of it.
- **Page wrapper:** Add `className="fade-in"` to the top-level div of each page for entry animation.
- **Sidebar width:** 240px (set in CSS), content margin-left matches.
- **Phone layout:** below 768px the sidebar becomes a drawer behind a top-bar menu button (`App.jsx` `Shell`). Every phone rule lives in the single `PHONE LAYOUT` `@media (max-width: 768px)` block at the end of `client/src/app.css`, so desktop rendering can't change — keep it that way. Inline `style={{…}}` beats a media query, so prefer classes in anything that should adapt. `npm run check:mobile [baseUrl]` checks the shell at phone + desktop widths in a real browser against a running dev server (jsdom can't evaluate media queries).
- **Private details covers the whole app (#197, 25 Oct 2026):** one switch in the left sidebar (`components/PrivateDetails.jsx`; on a phone in the menu drawer, with its state in the top bar), off by default, remembered on the device (`client/src/lib/privateDetails.js`). With it off, private content is left out of the DOM and the shared `PrivateHidden` box stands in its place: the triage rail and its counts (dashboard and course pages), the Gradebook, Assessments and Analytics tabs, the assessment page, the student page's alerts, contacts, notes and courses, Class Tools' filters and Balance percentages, and the Roster tab's private parts. A new view that shows a private value renders only with the switch on, with a test. Client tests start with it on (`setPrivateDetailsDefault(true)` in `client/src/test-setup.js`); a test about the switch stores its value. Rules: `docs/design-language.md` ("Private details across Prism").
- **Roster tab (#160, 25 Oct 2026):** `components/roster/` draws four modes (Details and Attendance, Needs attention, Test day, Mastery; the first was "Roster" until #192). Its cards follow the roster's own width through container queries (`@container roster`, in the ROSTER section of `app.css`), because the same page is full width, beside the triage rail, or on a phone; device rules (the drawer, tap targets) still go in `PHONE LAYOUT`. On the Roster tab **Private details** hides comment counts, alerts, filters, Copy emails, the triage count, and the students, levels and grades of Needs attention, Test day and Mastery. On a current course's Roster tab the main column keeps the width it has beside the triage rail, and the rail is shown by default only while Private details is on (#192). Reporting categories show as short labels (P, CRC: `client/src/lib/categoryAbbr.js`), never their numbers. `check:mobile` also opens the Roster tab in all four modes at 390px and 1100px. Rules: `docs/design-language.md` ("Roster tab: ...").
- **Theming:** Prism has a single palette, defined as CSS custom properties in `:root` in `client/src/app.css` (#133 removed the Midnight/Ocean themes and the switcher). There is no theme system to extend — tune the palette in place.
- **Date formatting (UK/AU):** Render dates as `toLocaleDateString('en-GB')` → DD/MM/YYYY, never US M/D/YYYY (the user is Australian; Prism runs at HKIS). Use `formatDate` / `formatDateTime` from `client/src/lib/formatDate.js` for new code (a bare `toLocaleString()` renders US order on a US-locale machine). Older call sites still pass `'en-GB'` inline, and `client/src/pages/CoursePage.jsx` still uses `en-US` for time-of-day. A configurable app-wide locale (one `config.yaml` setting + a single shared `formatDate()` helper all dates funnel through) is a deferred follow-up — scope that refactor if asked to "make dates configurable".
- **Design language & decisions:** `docs/design-language.md` is the running log of Prism's visual patterns and the rationale behind UI decisions (tracked by #80). Reuse the shared primitives documented there — e.g. `.help-dot` + `.help-pop` (the instant help-"?" popover) and `.number-stepper` — instead of re-inlining them. **Whenever you make a notable UI/visual decision, append it to that doc** so the language can later be unified.
- **Show the source's own value when Prism cannot interpret it** (Graham, 25 Oct 2026): when a code or field from Schoology or PowerSchool falls outside what Prism understands, show that value verbatim ("Recorded in PowerSchool as \"X\"") rather than a label Prism guesses. Example: the roster's NB gender tag.
- **Hover text is an instant popover, never a `title` tooltip** (Graham, 25 Oct 2026, every UI build from now on): any text a user needs on mouseover (a full name behind an abbreviation or code, a chip's meaning, a help line) opens immediately on hover, focus or tap through the shared `useHelpPop` / `.help-pop` (`client/src/components/HelpDot.jsx`). Keep an `aria-label` with the same text for screen readers and agents; a native `title` is too slow and is not the place for it. Short labels must be meaningful: an abbreviation (P, CRC), not an internal number.
- **No em dashes in UI copy:** use a hyphen, comma or colon instead (they take too much inline room). A guard test enforces it, along with a short list of phrases Graham has rejected on screen (`REJECTED` in `client/src/copy.test.js`, e.g. "at once": write "immediately").

## Key References

- **How endpoints are discovered + the multi-surface architecture (read before any API spike)**: `.claude/api-exploration-playbook.md`. Core principle: a spike is a *lower bound*, not a conclusion — data visible in the UI is reachable, so if a probe didn't find it the wrong surface was tested. Scope every conclusion to the surface actually tested.
- **Schoology API quirks, verified endpoints, and SBG findings**: `.claude/schoology-api-reference.md`
- **PowerSchool API probe results and access plan**: `.claude/powerschool-api-reference.md`
- **Build progress across all phases**: `.claude/build-progress.md`
- **Product spec and roadmap**: `product-spec.md`
- **Hosting + deploy — live since cutover on 2026-09-24**: `docs/deploy.md` (operations), `docs/adr/0003-prism-served-from-a-home-server-over-tailscale.md` and `docs/superpowers/specs/2026-09-23-prism-hosting-and-deploy-design.md` (design). **Prod is the Mac mini** (`https://prism.swordtail-everest.ts.net`, tailnet only — a Tailscale Service; the mini itself is `macmini`, tagged `tag:server`) and holds the one authoritative database; push to `main` deploys it once CI is green. Every other clone — the laptop included — is a disposable dev clone: never run `db:backup` from one, and never grade for real on one: its `/mcp` starts every tool result with a dev-copy warning and refuses Schoology writes. `CONTEXT.md` holds the vocabulary (prod / release / dev clone / snapshot / cutover).

## Definition of done (every task, unprompted)

Graham relies on the agent to catch what he would miss (19 Oct 2026). Before reporting a task finished:

- **Issues:** search `ganolan/prism` for every issue the work touches (`gh issue list --search …`, and the milestone's other issues). Comment on each with what changed (commit ids, evidence), close what is done, open issues for follow-ups. Nothing is left only in the chat.
- **Docs:** update everything that describes the changed behaviour: `.claude/schoology-api-reference.md` / `.claude/powerschool-api-reference.md` (verified intel, dated), `.claude/build-progress.md`, `docs/design-language.md` (UI decisions), `docs/deploy.md`, `docs/prismcp-install-and-verify.md` and PrisMCP tool descriptions in `mcp/server.js`, this file. When the work improves on what Schoology, PowerSchool or the manual workflow does today, add an entry to `docs/improvements-log.md` (status quo, the problem, what Prism does, dated evidence). Grep code, client, tests and docs for the old wording and fix every hit.
- **Tests:** `npx vitest run` at the root (server, `mcp/`, `scripts/`) **and** `cd client && npx vitest run`, then `npm run build`. After pushing `main`, CI must be green on that commit and prod must serve it (`curl -s 127.0.0.1:3001/api/version` on the mini). A change to sync is not done until the next full run on prod completes: read `sync_runs` (status, `error_count`) after it, or start one with `POST /api/sync {"everything":true}` (reads only). On 24 Oct 2026, a change with green CI made every full sync fail for two nights (`9969f01`).
- **Loose ends:** fix, don't list: stale comments, small bugs found on the way, missing tests, wrong memories. Stop dev servers you started (`npm run dev:stop`, never by port). Delete scratch database copies, screenshots and page snapshots: they hold student data.
- **Handoff:** leave memory current for a new session (what shipped, what is next). The report states what was done and verified; open items are only Graham's decisions, asked with the question tool.

## Working Notes

- **Never run Prism from a cloud-synced folder** (#121). The live SQLite trio (`.db` + `-wal` + `-shm`) tears under sync, and `.git` can arrive incomplete — observed 2026-09-22: the OneDrive clone was missing 8 objects and could not read its own HEAD tree, while `git status` still reported clean. This includes OneDrive **and** macOS `~/Documents` when Desktop & Documents sync is enabled. `npm run db:backup` (SQLite backup API) is the only safe way to copy the database; `db:restore` must clear stale `-wal`/`-shm` first or a foreign WAL can be replayed over the restored file.
- Check `.claude/build-progress.md` before starting any new phase to avoid repeating work.
- **Preserve verified API intel.** API findings are hard-won via fragile spikes (the playbook treats probes as lower bounds). When removing code that used a discovered API surface, keep its verified intel in `.claude/schoology-api-reference.md` / `.claude/powerschool-api-reference.md` — annotate the relevant row as superseded / no-longer-used (with date + why) but **never delete** the shape/keying/enum docs. Before deleting a parser, confirm everything it encoded is in the reference doc. (Example: `grader_header_data` was annotated "no longer consumed" — not removed — when the GHD pre-filter was dropped, 2026-06-08.)
- Schema uses `CREATE TABLE IF NOT EXISTS` for safe idempotent creation via `getDb()`. Columns added to an existing table go in the `MIGRATIONS` array in `server/db/index.js` **as well as** `server/db/schema.sql`, or existing local databases silently miss them.
- The school uses standards-based grading with measurement topics from PowerSchool. Per-topic ratings are NOT available via Schoology API — see `.claude/schoology-api-reference.md` for full details.
- **Schoology write-back is live** (the old "Phase 5 on hold" note is retired, 17 Oct 2026): Prism writes grade comments and levels, points on points-only tasks, status lines, FRQ marks, LTI unsubmit and submission comments. A new write path gets one live write that Graham approves, on a target he names, then a read-back. Copy the safety pattern in `server/services/quizWriteback.js`: re-read, refuse if Schoology changed, write, read back, stop the batch on a failure. Open write-back work is the **Schoology write-back** milestone.
- **Root tests never touch the clone's database.** `vitest.config.js` sets `DB_PATH=:memory:` for every server, `mcp/` and `scripts/` test file, and `server/db/testIsolation.test.js` checks it (23 Oct 2026: a test had been deleting rows from a dev copy's real database). A test that needs a file database sets its own `DB_PATH`.
- **CI runs in UTC; the mini runs in Hong Kong time.** A client test that builds a date from local time can pass on the mini and fail in CI: build fixed instants. Read the CI run's conclusion (`gh run list`), not the exit code of a command that only prints it.
- **Prefer real automated tests over manual-only verification.** The user invests in durable test infra (server + client Vitest; client uses React Testing Library) even for small fixes — don't default to "skip tests, it's a small change." New backend logic → a `*.test.js` beside it; frontend → client tests. For API-shape changes, a live parity probe (`scripts/parity-*.js`) diffing old-vs-new against real data is the verification of choice (it has caught real bugs spikes missed).
- **Permission autonomy — "wildcards within reason."** Broad dev wildcards (`node:*`, `npm run:*`, `gh issue:*`, project-scoped `Write`/`Edit`) are acceptable to keep friction low; still favour a fixed-capability helper script for the bulk of a repeated workflow where one fits naturally (e.g. `scripts/inspect.js`, the probe scripts). Avoid clearly catastrophic patterns (`rm -rf` of broad paths, `git push --force`); keep `curl`/`wget` localhost-only (network-exfiltration vector). For Claude Code specifically: universal read-only command families live in user-level `~/.claude/settings.json`; project-specific grants in `.claude/settings.json` (committed) or `.claude/settings.local.json` (gitignored). Proactively offer to allow-list a safe read-only command that prompts repeatedly.

## API Spikes & Probes

**Spike before you settle (Graham, 17 Oct 2026).** Prism is becoming a reliable replacement for much of Schoology's functionality, so **performance and data integrity come first**, and API spikes are encouraged, not a detour. Don't give up on the first surface tried:
- **Before calling data unavailable,** try the endpoint's parameter variants (`with_attachments`, `with_comments`, `richtext`, paging), the single-item and bulk forms, `/multiget`, then the internal API and the page's own XHRs. Example: submission comment files were first written up as "not in the REST comment"; one more probe found them behind `?with_attachments=1` on the same call, at no extra cost.
- **No headless browser where an HTTP route exists.** Order of preference: public REST, then the internal API over plain HTTP (session cookies plus the `X-Csrf-Token`/`X-Csrf-Key` from `Drupal.settings.s_common`), and a browser only as a last resort. A browser path that ships is debt: name it in the code and the API reference, and keep looking for its HTTP route.
- **Prove integrity, not just status codes:** read back what you wrote, and compare checksums for files.

Read `.claude/api-exploration-playbook.md` first — a spike is a *lower bound*, not a conclusion (if a probe didn't find data the UI shows, the wrong surface was tested). Operational gotchas that have silently produced false results:

- **Run Playwright/probe scripts from the repo root, never `/tmp`** — elsewhere they can't resolve the repo's `node_modules` (`ERR_MODULE_NOT_FOUND` on `import 'playwright'`). Keep probes under `scripts/`.
- **No `timeout` binary on macOS** — use your harness's own timeout parameter, not `timeout 300 node …` (which no-ops).
- **Confirm session liveness with one cheap authenticated request, not the cookie-expiry timestamp.** The Schoology Drupal session (and the PowerSchool session) can be valid server-side long after the Microsoft SSO cookies in `.playwright-session/storage-state.json` show "expired". Login only refreshes SSO.
- **PowerSchool LTI launch:** the LTI run-URL form does NOT auto-submit under `page.goto` — call `document.forms[0].submit()`, then poll for the `powerschool.hkis.edu.hk` origin. The embedded PS iframe **detaches mid-loop**, so do an independent `page.goto` per request for multi-read sweeps (a shared-frame loop failed 5/6; per-nav got 6/6).
- **PowerTeacher student pages log a security violation if reached out of order.** `/teachers/studentpages/*.html` (e.g. Demographics) must follow the teacher's click path in the same session: `home.html` → `summary.html` → `menu.html` → the student page, each sent with the previous page as Referer. A direct GET answered 403 or PowerSchool's "Security Violation Logged" page (2026-10-17, #116); `scripts/probe-ps-student-fields.js` follows the path and stops on that page. The class Emergency Contact List (`/teachers/StudEmgContacts.html`, guardian slots for #66) is read every sync after `home.html`, with home as Referer (`PowerSchoolWeb.teacherPage`); alert pop-ups are requested as their dialog requests them, from the attendance page (#163).
- **`/ws/pt/v1/...` content negotiation:** always send `Accept: application/json` — without it these PowerSchool endpoints 500 ("no message body writer", a header quirk, not "broken"); with it you get the real status.
- **Resolve ids before probing** — a 404 on a `null`/guessed id is not a missing route. Pull ids from a live session JSON (roster / LTI launch form), not a throwaway script whose `apiGet` returned `null` because `.env` wasn't loaded.
- **Schoology's own pages can hide records its REST lists return.** `/courses/mycourses/past` omits linked sections (AI & ML 6(A-B) 2023-24 and 14 AP CSA sections); `GET /users/{teacherUid}/sections?include_past=1` lists all 83 (for a student's uid `include_past` does nothing). Linked sections share task ids and keep their own students and grades: Prism holds a set as one course (`linked_sections`) and refuses Schoology writes to it (#178).
- **The teacher's section list includes classes the teacher only sat in.** `GET /users/{me}/sections` (with or without `include_past=1`) lists every section the teacher is enrolled in, `admin: 0` too: a colleague's class or a faculty group, whose grades answer 403 and whose "students" include the teacher (24 Oct 2026). Only `admin: 1` sections are the teacher's courses (`server/lib/sectionRole.js`).
- **A list endpoint returning a record does not mean the record is current.** Schoology keeps returning dropped students from `/sections/{id}/enrollments` with `status: "5"`; filtering on `admin` alone re-added them every sync (#128). Check for a lifecycle/status field before treating a list response as "the current set".
- **A probe that reads student data asks Graham once, for a bounded set** (the #160 pattern, 25 Oct 2026): read only, up to 3 students per type, from one current class, with the API reference recording response shapes only (no names, ids or text); the script caps the count in code and stops at a Security Violation page. Wider reads need a new approval.
- **Never document a response shape you didn't observe in tool output.** Fabricated shapes have been committed + posted publicly before; a documented shape must trace to a specific probe result. Re-read the actual JSON before each api-ref edit. (Pairs with "Preserve verified API intel" above.)
- **A lapsed Schoology session answers the grader document lists `403`, not a sign-in redirect** (2026-10-19). Load a page (`/home`) to tell the two apart: a lapsed session is sent to sign-in there.
- **SharePoint answers `403` to Node's own `User-Agent`;** send a browser-like one (`lib/stateCookieJar.js` `USER_AGENT`).
- **Drop cookies a `Set-Cookie` expires** (`Max-Age=0` or a past `Expires`). Schoology expires `login_landing_dest` with the value `deleted`; a jar that keeps it ends a sign-in at `/deleted`.
- **Discovery method ranking:** driving the real page and capturing its XHRs is most reliable; grepping the cross-origin React/Angular bundles (`asset-cdn.schoology.com`, the PS attendance app bundle) for `/iapi(2)/` / `/ws/` literals is a strong second — then live-probe each literal.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `ganolan/prism` (uses the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
