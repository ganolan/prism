# PowerSchool API Reference

Findings from probing the HKIS PowerSchool server. No credentials yet — this documents what we know and what's needed to get access.

Last probed: 2026-04-05 (script: `test-powerschool-probe.js`)

## Server Details

- **URL:** `https://powerschool.hkis.edu.hk`
- **Version:** 25.9.0.0.252611238
- **Timezone:** Asia/Shanghai
- **SSO:** OIDC enabled for all roles (admin, teacher, student, guardian)
- **API status:** Live — `/ws/v1/metadata` returns 200

## Authentication

- PowerSchool uses **OAuth 2.0** (unlike Schoology's OAuth 1.0a)
- The OAuth endpoint is active: `POST /oauth/access_token` returns 401 `invalid_client` (not 404), confirming at least one plugin is already installed
- Auth flow: `POST /oauth/access_token` with `Authorization: Basic base64(client_id:client_secret)` and `grant_type=client_credentials` body
- Returns a bearer token to use in subsequent API requests

## What's Needed to Get Access

A PowerSchool admin needs to provide `client_id` and `client_secret` from an installed API plugin. Two paths:

1. **Reuse an existing plugin** — there's at least one installed (likely the Schoology sync plugin). Ask IT if you can get read-only credentials from it.
2. **Install a new plugin** — admin creates one under System > System Settings > Plugin Management Configuration (`/admin/pluginconfiguration.html`). The plugin XML defines which data tables are accessible.

**Suggested ask to IT:** "Is there an existing API plugin on PowerSchool I could get read-only credentials for? I need access to student standards/grades data for a teacher dashboard. If not, could we create one with read access to the relevant tables?"

## Why PowerSchool Matters for Prism

PowerSchool has data that Schoology's API blocks:

| Data | Schoology | PowerSchool |
|------|-----------|-------------|
| Per-topic mastery ratings | Mastery endpoint returns empty arrays | Available via `standardgradesection` / measurement topic tables |
| Standards definitions & hierarchies | 403 on `grading_rubrics`, misleading on `standards` | Full standards trees available |
| Attendance | 410 Gone (deprecated) | Available |
| Student demographics & schedules | Basic profile only | Full records |
| Historical grades | Current year only | All years |
| Reporting categories config | Not accessible | Available |

## API Structure (for when we have credentials)

PowerSchool REST API lives under `/ws/v1/`:

```
GET  /ws/v1/district                    — District info
GET  /ws/v1/school                      — School list
GET  /ws/v1/school/{id}/student         — Students in school
GET  /ws/v1/student/{id}                — Student detail
GET  /ws/v1/section/{id}                — Section detail
GET  /ws/v1/section/{id}/student        — Students in section
```

PowerQuery (custom SQL-like queries) at `/ws/schema/query/api`:
```
POST /ws/schema/query/api/{query_name}  — Run a named PowerQuery
```

Key tables for SBG data:
- `psm_measurementtopic` — Standards/measurement topics
- `standardgradesection` — Per-topic grades by section
- `storedgrades` — Historical grade records
- `attendance` / `attendance_code` — Attendance data

## Probe Results Summary

| Endpoint | Status | Meaning |
|----------|--------|---------|
| `/` | 302 → `/public/` | Server reachable |
| `/ws/v1/metadata` | 200 | API is live |
| `/oauth/access_token` | 401 | OAuth active, need valid credentials |
| `/ws/v1/district` | 400 | Exists but needs auth |
| `/ws/v1/school/count` | 400 | Exists but needs auth |
| `/ws/v1/school` | 404 | May need auth to see |
| `/ws/schema/query/api` | 400 | PowerQuery exists but needs auth |
| `/admin/home.html` | 302 → OIDC login | Admin panel behind SSO |
