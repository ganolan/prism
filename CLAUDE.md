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

## Running

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

## Key References

- **Schoology API quirks, verified endpoints, and SBG findings**: `.claude/schoology-api-reference.md`
- **Build progress across all phases**: `.claude/build-progress.md`
- **Product spec and roadmap**: `product-spec.md`

## Working Notes

- Check `.claude/build-progress.md` before starting any new phase to avoid repeating work.
- Schema uses `CREATE TABLE IF NOT EXISTS` for safe idempotent creation via `getDb()`.
- The school uses standards-based grading with measurement topics from PowerSchool. Per-topic ratings are NOT available via Schoology API — see `.claude/schoology-api-reference.md` for full details.
