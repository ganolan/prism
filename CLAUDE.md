# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Test harness and utility scripts for the Schoology (PowerSchool Learning) REST API at HKIS. Used to automate grading, comment posting, and data extraction workflows.

## Setup

```bash
npm install
```

Credentials live in `.env` (gitignored):
```
SCHOOLOGY_BASE_URL=https://api.schoology.com
SCHOOLOGY_CONSUMER_KEY=...
SCHOOLOGY_CONSUMER_SECRET=...
```

## Running

```bash
npm test          # runs test-api.js
node test-api.js  # same thing
```

## Architecture

- **ESM project** (`"type": "module"` in package.json)
- **OAuth 1.0a** two-legged auth with PLAINTEXT signature via `oauth-1.0a` package
- Token is empty (`{ key: '', secret: '' }`) for two-legged flow
- All requests go to `https://api.schoology.com/v1/...` — never the school domain (`schoology.hkis.edu.hk`), which redirects to Microsoft SSO

## Schoology API Quirks

- **`/users/me` redirects** (303) to `/users/{uid}`. Must follow redirects manually with fresh OAuth headers per hop — reusing the same nonce/signature on the redirected URL fails.
- **Per-assignment grade endpoint is 403**: `GET /sections/{id}/assignments/{aid}/grades` returns 403. Use the section-level `GET /sections/{id}/grades` instead, which returns all assignment grades including the target.
- **Grade `comment` field**: Present on grade objects from the section-level grades endpoint. `comment_status: 1` means visible to student; `null` means no comment. Cannot be written via `PUT /sections/{id}/assignments/{aid}/grades/{uid}` (returns 405). **CAN be written via bulk `PUT /sections/{id}/grades`** — wrap in `{ "grades": { "grade": [{ assignment_id, enrollment_id, grade, comment, comment_status: 1 }] } }`. Returns 207 with per-entry `response_code: 204`. Works for single or multiple students.
- **Two comment systems**: (1) Submission comments: `POST /sections/{id}/submissions/{aid}/{uid}/comments` — per-student dropbox comments. (2) Assignment comments: `POST /sections/{id}/assignments/{aid}/comments` — discussion-thread style.
- **Comment POST body must be flat**: Use `{ "comment": "text" }`, NOT `{ "comment": { "comment": "text" } }`. The nested form causes PHP to cast the inner object to the string `"Array"`, resulting in a blank comment.
- **Enrollments**: `GET /sections/{id}/enrollments` returns all members. Filter by `admin !== 1` to get students only.
- **User profiles**: `GET /users/{uid}` returns full profile including `primary_email`, `name_first_preferred`, and `parents.parent[]` array with parent/guardian names and emails. Enrollment records only have basic name info — must fetch full profile separately per student for contact details.

## Verified Endpoints

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/users/me` | 200 (via redirect) | Follow 303 manually |
| GET | `/v1/users/{uid}` | 200 | Full profile: email, parents[], preferred name |
| GET | `/v1/users/{uid}/sections` | 200 | Lists all sections |
| GET | `/v1/sections/{id}/assignments` | 200 | Paginated (`?start=&limit=`) |
| GET | `/v1/sections/{id}/grades` | 200 | All grades, includes `comment` field |
| GET | `/v1/sections/{id}/enrollments` | 200 | Members with UIDs |
| GET | `/v1/sections/{id}/submissions/{aid}/{uid}/comments` | 200 | Per-student submission comments |
| POST | `/v1/sections/{id}/submissions/{aid}/{uid}/comments` | 201 | Post submission comment |
| POST | `/v1/sections/{id}/assignments/{aid}/comments` | 201 | Post assignment comment |
| PUT | `/v1/sections/{id}/grades` | 207 | Bulk grade+comment update; per-entry 204 on success |
| GET | `/v1/sections/{id}/assignments/{aid}/grades` | 403 | Blocked — use section-level instead |
| PUT | `/v1/sections/{id}/assignments/{aid}/grades` | 405 | Not allowed — use section-level bulk PUT |
| PUT | `/v1/sections/{id}/assignments/{aid}/grades/{uid}` | 405 | Not allowed — use section-level bulk PUT |
