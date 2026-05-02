# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

Optional local overrides: `PORT`, `DB_PATH`, `INBOX_DIR`, `CONFIG_PATH`.

Mastery sync (SBG data from Schoology's internal API) requires a one-time browser login:
```bash
npm run mastery:login   # Opens a browser — log in to Schoology, then close the window
```
Playwright browser binaries are installed automatically via `postinstall`.

## Running

If the dev server fails to restart (port already in use), kill stale processes first:
```bash
lsof -ti:3001 | xargs kill -9; lsof -ti:5173 | xargs kill -9
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

- **Theming:** All colors must use CSS custom properties from `app.css` — never hardcode hex values in components. Use `var(--accent)`, `var(--bg-subtle)`, `var(--card-bg)`, etc.
- **Button classes:** Use `.primary`, `.secondary`, `.ghost` (with `.danger`, `.success`, `.accent` modifiers), `.tab-btn`, `.filter-btn` — avoid inline button styles.
- **Alert/banner classes:** Use `.alert.alert-warning`, `.alert.alert-success`, etc. instead of inline colored divs.
- **Page wrapper:** Add `className="fade-in"` to the top-level div of each page for entry animation.
- **Sidebar width:** 240px (set in CSS), content margin-left matches.
- **Adding new themes:** Add a `[data-theme="name"]` block in `app.css` with all CSS variables, add the theme key to `themes` in `useTheme.jsx`. No component changes needed.

## Key References

- **Schoology API quirks, verified endpoints, and SBG findings**: `.claude/schoology-api-reference.md`
- **PowerSchool API probe results and access plan**: `.claude/powerschool-api-reference.md`
- **Build progress across all phases**: `.claude/build-progress.md`
- **Product spec and roadmap**: `product-spec.md`

## Working Notes

- Check `.claude/build-progress.md` before starting any new phase to avoid repeating work.
- Schema uses `CREATE TABLE IF NOT EXISTS` for safe idempotent creation via `getDb()`.
- The school uses standards-based grading with measurement topics from PowerSchool. Per-topic ratings are NOT available via Schoology API — see `.claude/schoology-api-reference.md` for full details.
- Phase 5 (Schoology write-back) is on hold pending a safe testing strategy.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `ganolan/prism` (uses the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
