# PowerSchool API Reference

Findings from probing the HKIS PowerSchool server.

There are **two** independent ways into PowerSchool data:
1. **OAuth-2 `/ws/v1/` plugin API** — the "official" path. Still blocked: needs an admin to hand over a `client_id`/`secret` (see "What's Needed to Get Access"). No working credentials yet.
2. **Session-authenticated web services (`/ws/...`)** — the internal endpoints the PowerSchool web UI itself calls. **These work today**, riding the same browser session the mastery sync already uses (HKIS SSO covers both Schoology and PowerSchool). No plugin credentials required. See "Session-Authenticated Web Services" below — this is how grade level / year group becomes syncable.

Last probed: 2026-04-05 (OAuth path, script: `test-powerschool-probe.js`)
Session-auth path discovered: 2026-05-30 (via the Schoology "attendance" LTI app — resolves issue #43's "run a probe for this page" ask).

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

## Session-Authenticated Web Services (working today — no plugin credentials)

Discovered 2026-05-30 while probing the Schoology "attendance" app (issue #43). The app at
`https://schoology.hkis.edu.hk/apps/4980125287/run/course/{schoologySectionId}` is **not Schoology
data** — it is an **LTI tool that embeds PowerSchool in an iframe** (`powerschool.hkis.edu.hk/integrations/attendance/index.html`).
The grade-level badges, attendance, and student-alert icons are all served by PowerSchool's own
internal web services under `/ws/...`, authenticated by the browser's PowerSchool session cookie
(established via SSO when the iframe loads). The Playwright session created by `npm run mastery:login`
already carries this — no separate PowerSchool login needed.

### Step 1 — Resolve Schoology section → PowerSchool `sectionDcid` (via the LTI launch)

The mapping is handed over by Schoology in the **LTI launch form**. An authenticated GET to the LTI
run URL returns an auto-submitting form whose hidden inputs carry the PowerSchool IDs:

```
GET https://schoology.hkis.edu.hk/apps/lti/4980125287/run/course/{schoologySectionId}
→ HTML form with:
    <input name="custom_sectiondcid" value="49390"/>    ← PowerSchool sectionDcid
    <input name="custom_userdcid"    value="2_10405"/>   ← teacher's PS user id (prefixed; see caveat)
```

Verified across all 10 of the API user's sections (2025-26) — 9 resolve, 1 is null:

| Schoology section | Course | `custom_sectiondcid` |
|---|---|---|
| 7899896098 | Advanced Computer Science Studio | 49355 |
| 7899907727 | AI & Machine Learning | 49390 |
| 7899896088 | AP Computer Science Principles | 49354 |
| 7899907701 | Mobile App Development | 49386 |
| 7899916157 | PCG | 50210 |
| 7899907720 | Robotics | 49388 |
| 7899866071 | Teaching Assistant (Sem) | 49027 |
| 8141827061 / 8141827060 | *Interim courses | 51067 / 51066 |
| 280110114 | MASTER Art, Design & Technology | **null** (template/master course — no real PS section) |

### Step 2 — Find an in-session date

The roster only populates for a date the section actually meets; off days (weekends, holidays, end of
year) return empty `sectionAttendances`. Pull the section's calendar and pick an `inSession` day:

```
GET https://powerschool.hkis.edu.hk/ws/attendance/section_info?sectionDcid={dcid}&multiSections=false&startDate={YYYY-MM-DD}&endDate={YYYY-MM-DD}
→ [{ dcid, id, psmSectionId, courseName, expression ("8(A-B)"), term, calenderDays: { "2025-08-21": { inSession, cycleDay, ... }, ... } }]
```

### Step 3 — Fetch the roster with grade level

```
GET https://powerschool.hkis.edu.hk/ws/attendance/section_attendance
    ?sectionDcid={dcid}&userDcid={userDcid}&startDate={inSessionDay}&endDate={inSessionDay}
    &includeStudentAlerts=true&multiSections=false&sortByFirstName=false
→ {
    sectionAttendances: [{
      sectionId, date, periodId,
      studentAttendance: [{
        studentId,        // PS studentid (also in the alert-popup links, e.g. 41683)
        dcid,             // PS student DCID (e.g. 41533) — the join key
        gradeLevel,       // ← year group: 9 / 10 / 11 / 12
        lastName, firstName, lastFirst,
        onTrack, enrolled,
        ccDateEnrolled, ccDateLeft   // section enrollment dates
      }]
    }],
    studentTardyCount, studentAbsentCount, studentAlerts, ...
  }
```

Grade-level *definitions* (not per-student) come from
`POST /ws/schema/query/com.pearson.core.schools.grade_levels` → `{ record: [{ grade_level, grade_text }] }`.

### Attendance tallies (`studentAbsentCount` / `studentTardyCount`)

Confirmed 2026-05-30. Both are per-student maps keyed by `studentId`, **scoped to the queried
`startDate`..`endDate`** — PowerSchool sums them server-side, so a wide range returns per-student
absence & tardy totals in a single call (no client-side aggregation):

| Range | Meeting days | Absences (students / total) | Tardies (students / total) |
|---|---|---|---|
| single day | 1 | 3 / 3 | 0 / 0 |
| spring term | 38 | 13 / 45 | 2 / 2 |
| full year | 74 | 14 / 86 | 4 / 8 |

Empty maps just mean zero-in-range (e.g. first week of school, or a single day with no tardies — which
is what made an earlier single-day probe look "empty"). Per-day detail is in `meetingAttendance[].code`
(`L`/`A`/`X` count as absences, `M1` does **not**, blank = present). These tallies are **per-section**
(per class meeting) — the right scope for a per-course view; a whole-school-day total would need a
different source.

### Step 4 — Join PowerSchool → Prism students

**The join is deterministic.** Schoology's enrollment `school_uid` is literally `1_{PowerSchool dcid}`:

| Prism `students.school_uid` | PowerSchool `dcid` |
|---|---|
| `1_41533` | `41533` |
| `1_58808` | `58808` |

So `students.school_uid == "1_" + ps.dcid`. Confirmed 15/15 by name-match against the Prism DB on a
live section. The `1_` prefix denotes the students realm; the teacher `custom_userdcid` uses `2_`
(users realm).

### Deriving grade / graduating year

`gradeLevel` is the **current** grade (9–12) — authoritative, not inferred from student ID. Graduating
year is a clean function of it: for school year ending in calendar year `Y` (2025-26 → `Y = 2026`),
`grad_year = Y + (12 − gradeLevel)` (G12→2026, G11→2027, G10→2028, G9→2029). Because the raw datum is
*current grade*, prefer storing `grade_level` and deriving `grad_year` on read (or recompute each sync),
rather than storing a `grad_year` that silently goes stale at year rollover.

### Caveats / open items

- **`userDcid` value:** the working `/ws/attendance/section_attendance` call used `userDcid=10005`, but the
  LTI `custom_userdcid` is `2_10405`. PowerSchool appears to resolve the real `userDcid` from the session,
  not the LTI param. Stripping the `2_` prefix gives `10405`, which did **not** match the working `10005` —
  so don't assume `custom_userdcid` is the value to pass. Confirm by reading it from a session endpoint, or
  test whether the roster returns regardless of `userDcid` (it likely only scopes "attendance taken by").
- **Session fragility:** same as mastery sync — depends on the browser session; expires → re-login.
- **In-session date:** must be derived per-section from `section_info.calenderDays`; a hardcoded "today" breaks on off days.

### Student alerts & custom-alert popups (probed 2026-05-30, for #65)

The per-student alert icons in the attendance grid come from PowerSchool's **MBA custom-alerts plugin** (`aet_customalert`), whose client API lives under `/teachers/mba_alerts/queries/`. (Note: `section_attendance.studentAlerts` is a *different*, standard alert channel — empty for these students — and `getStudentsInSection.json` returns only the roster.) The plugin JS (loaded via `/ws/pagecustomizations/insertions`) is the map.

**Full alert catalog — one call, no inference needed:**
`POST /teachers/mba_alerts/queries/getAlertTypes.json` (form `disabled=0&student_schoolid=40`) returns the **complete catalog of every configured alert** (HS = school 40). Returned **31 definitions** (a trailing meta element is popped by the client). Each def: `id`, `name`, `trigger_type`, `student_field`, `ext_table_name`, `icon`, `stub_url`, operators, `sort_order`. Three trigger types:
- `sf` (student-field-value, 20) — reads a field on the student extension table; **this is where the safeguarding flags live**.
- `adv` (advanced query, 10) — e.g. Absence Alerts, MAP, Siblings, Student Support Summary (HTML popup templates `mba_*.html` / `*.html`).
- `man` (manual, 1) — Early Dismissal.

**High-value `sf` fields (the catalog):**

| Alert | Field | Alert id |
|---|---|---|
| Do Not Contact Guardian 1 / 2 | `X_DNC_G1` / `X_DNC_G2` | 10672509 / 10672510 |
| Deceased Guardian 1 / 2 | `X_G1DECEASED` / `X_G2DECEASED` | 10593864 / 10733416 |
| Divorced | `X_G1G2Relationship` | 10593857 |
| G1 / G2 / G1&G2 Correspondence | `X_HomeEmail` | 32012479 / 32012481 / 32012482 |
| Accommodation Plan (SPP) | `X_SPP` | 10593860 |
| Individual Learning Plan | `X_ILP` | 10593859 |
| Learning Support Level 1/2/3 | `X_LS_SUPPORT_LEVEL` | 10593862/61/63 |
| Allergies / EpiPen / Missing Health Form | `X_ALLERGYCNF` / `X_ALLERGYEPI` / `X_MedicalConfirm` | — |
| No Photo (publicity) | `X_PublicityNotice` | 10593856 |
| Elevator / Library / AQHI | `X_ELEVATORALERT` / `X_LIBRARYALERT` / `X_APIABOVE100` | — |

**Reading an `sf` field value (confirmed end-to-end):**
```
GET /teachers/alerts/aet_customalert_sf.html?frn=001{dcid}&mba_frn=001{dcid}&id={alertId}
    &student_field=U_DEF_EXT_STUDENTS.{FIELD}&tableName=U_DEF_EXT_STUDENTS
→ HTML: "{Student Name}  U_DEF_EXT_STUDENTS.{FIELD}: {value}"   (parse after the last ': ')
```
⚠️ **Table-name gotcha:** the working table is **`U_DEF_EXT_STUDENTS`**, *not* the catalog's `student_field` prefix (`U_Students_Extension`) — the latter returns the icon but no value. Verified: Claire Tse (`frn=00138590`, `X_G2DECEASED`) → `1` (deceased Guardian 2 = true). Empty body = flag not set. Batch read also exists: `GET stuFieldValues.json?stuList={ids}&student_id={ids}&field1={f}&fieldTbl1={tbl}&table1={tbl}` (params per the plugin JS; finalize against a live call).

**Implication (supersedes earlier "scrape HTML" framing):** most safeguarding/SEN flags are **structured `field: value` reads** (boolean-ish or short text), not brittle table-scraping. Only the `adv` popups (siblings/MAP/support-summary detail) are HTML tables. So the do-not-contact/deceased/divorced data (#66) is cleanly readable. Still session-auth (expires → re-login) and sensitive → human-implemented + feature-flagged (#65). OAuth `/ws/v1/` + PowerQuery remains the cleaner long-term source if credentials arrive. Tier A (`onTrack`, `enrolled`, enrollment dates, attendance tallies) needs none of this.

### Relevance to other issues

- **#39 (attendance marking):** `section_info` + `section_attendance` are the attendance endpoints that issue
  asks to probe; `section_attendance` is read here, and the same surface (`pss-integration-attendance-picker`)
  is what writes attendance codes. The "no page on non-timetabled dates" behavior #39 notes = the in-session-date
  requirement above.
- **#42 (parent-contact flags):** `includeStudentAlerts=true` returns `studentAlerts`, and the app's alert
  links expose siblings, MAP scores, Student Support Summary, and Accommodation Plan (SPP) popups — but the
  "do not contact this parent" flag is more likely a Schoology field; not yet confirmed here.

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
