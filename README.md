# Prism

Prism is a local-first teacher dashboard for working with Schoology and PowerSchool data outside the Schoology web UI.

It combines:

- a small Express API server
- a React + Vite frontend
- a local SQLite database
- optional import and feedback workflows for CSV and JSON files

The project is currently geared toward a single-teacher workflow, but it is structured so a colleague can fork it, point it at their own data, and extend it safely behind feature flags.

For the full description of what Prism is intended to become, including the phased roadmap and feature scope, see [product-spec.md](product-spec.md).

## What It Does

Prism can currently:

- sync courses, students, assignments, grades, and comments from Schoology
- import supplemental student data from PowerSchool CSV exports
- store everything locally in SQLite
- provide course dashboards, student profiles, search, analytics, notes, flags, and class tools
- ingest structured feedback JSON files into a review workflow

## Tech Stack

- Backend: Node.js, Express, better-sqlite3
- Frontend: React, Vite, React Router, Recharts
- Data store: SQLite
- Config: `.env` for secrets, `config.yaml` for feature flags

## Repository Layout

```text
.
├── client/                 # React frontend
├── server/                 # Express API, services, SQLite schema
├── server/db/              # schema + local database file
├── inbox/                  # optional feedback JSON drop folder
├── config.yaml             # feature flags
├── CLAUDE.md               # project notes and API quirks
├── product-spec.md
├── test-api.js             # Schoology API smoke test
└── test-bulk-comment.js    # write-back API test
```

## Requirements

- Node.js 18 or newer recommended
- npm
- Schoology API credentials

This project uses native `fetch` on the server side, so an older Node version will likely cause problems.

## Quick Start

1. Clone the repo.
2. Install dependencies:

```bash
npm install
cd client && npm install
cd ..
```

3. Create a `.env` file in the repo root:

```bash
SCHOOLOGY_BASE_URL=https://api.schoology.com
SCHOOLOGY_CONSUMER_KEY=your_key_here
SCHOOLOGY_CONSUMER_SECRET=your_secret_here
```

You can use [`.env.example`](.env.example) as the starting point:

```bash
cp .env.example .env
```

The `.env` file should live at the project root and should never be committed. It contains Schoology credentials and optional local path overrides.

4. Start the app:

```bash
npm run dev
```

5. Open the frontend at `http://localhost:5173`

The Express API runs on `http://localhost:3001`, and the Vite dev server proxies `/api` requests there.

## Environment and Local Paths

These environment variables are supported:

- `SCHOOLOGY_BASE_URL`
- `SCHOOLOGY_CONSUMER_KEY`
- `SCHOOLOGY_CONSUMER_SECRET`
- `PORT` to override the backend port. Default: `3001`
- `DB_PATH` to override the SQLite database path. Default: `server/db/students.db`
- `INBOX_DIR` to override the feedback inbox folder. Default: `inbox/`
- `CONFIG_PATH` to override the feature flag config file. Default: `config.yaml`

Example:

```bash
SCHOOLOGY_BASE_URL=https://api.schoology.com
SCHOOLOGY_CONSUMER_KEY=abc123
SCHOOLOGY_CONSUMER_SECRET=secret123

# Optional
PORT=3001
DB_PATH=server/db/students.db
INBOX_DIR=inbox
CONFIG_PATH=config.yaml
```

## Scripts

From the repo root:

- `npm run dev` starts the server and client together
- `npm run dev:server` starts the Express server in watch mode
- `npm run dev:client` starts the Vite frontend
- `npm run build` builds the frontend into `client/dist`
- `npm run test:api` runs the Schoology API smoke test

From `client/`:

- `npm run dev`
- `npm run build`
- `npm run preview`

## Feature Flags

Feature flags live in [config.yaml](config.yaml).

This lets you fork the project and selectively enable features like analytics, feedback review, class tools, and Schoology write-back without removing code.

## Running a Local Fork Safely

If you are forking this for your own use:

- start with `schoology_writeback: false`
- use a copy of production data only if you understand the privacy implications
- point `DB_PATH` and `INBOX_DIR` to your own local folders if you do not want to share state with another checkout
- verify Schoology API behavior in your own environment before enabling write-back features

## Data Notes

- The SQLite database is local and is created automatically on startup.
- The server applies the schema in `server/db/schema.sql` when the database is opened.
- The Schoology sync is designed around the public API, including pagination and some known endpoint quirks documented in `CLAUDE.md`.
- Feedback inbox files are expected as JSON and can be processed from the `inbox/` directory.

## Contributing

If you fork this project and want to extend it:

1. Create a feature branch.
2. Keep feature work behind `config.yaml` flags when possible.
3. Prefer additive schema changes in `server/db/schema.sql`.
4. Keep frontend API calls relative to `/api`.
5. Avoid storing application state in browser storage. This project is intentionally local-first through SQLite.
6. Test sync and import flows against realistic data before merging.

Good areas for improvement:

- packaging for non-technical users
- better test coverage
- more resilient import validation
- improved Schoology write-back workflows
- multi-user or colleague-specific configuration

## Troubleshooting

If the frontend loads but data does not appear:

- make sure the server is running on port `3001`
- confirm the Vite client is running on port `5173`
- check that your `.env` file exists and contains valid Schoology credentials
- confirm `SCHOOLOGY_BASE_URL` is the API host, not the school login domain

If Schoology sync fails:

- read the API notes in [CLAUDE.md](CLAUDE.md)
- verify that your Schoology consumer key and secret are valid
- check whether your Schoology tenant behaves differently for redirects or write endpoints

## Notes for Colleagues

This repo was built around a real teacher workflow, so some assumptions are practical rather than productized. If you fork it:

- expect to adapt field mappings and import workflows to your own school context
- review feature flags before exposing tools to others
- treat `CLAUDE.md` and `product-spec.md` as the best sources of project intent and implementation history
