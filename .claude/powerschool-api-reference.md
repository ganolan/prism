# PowerSchool API Reference

Findings from probing the HKIS PowerSchool server.

There are **two** independent ways into PowerSchool data:
1. **OAuth-2 `/ws/v1/` plugin API** — the "official" path. Still blocked: needs an admin to hand over a `client_id`/`secret` (see "What's Needed to Get Access"). No working credentials yet.
2. **Session-authenticated web services (`/ws/...`)** — the internal endpoints the PowerSchool web UI itself calls. **These work today**, riding the same browser session the mastery sync already uses (HKIS SSO covers both Schoology and PowerSchool). No plugin credentials required. See "Session-Authenticated Web Services" below — this is how grade level / year group becomes syncable.

Last probed: 2026-04-05 (OAuth path, script: `test-powerschool-probe.js`)
Session-auth path discovered: 2026-05-30 (via the Schoology "attendance" LTI app — resolves issue #43's "run a probe for this page" ask).
Endpoint-discovery crawl: 2026-05-30 — captured the attendance LTI app's full `/ws/...` surface (incl. new `/ws/pt/v1/...` PowerTeacher API) and resolved #66; see "Endpoint-discovery crawl" below.
Block-number resolved: 2026-06-08 (#106) — the displayed "Block N" = `section_info.bellScheduleItems[].period.name`; see "Block number" below. Probes: `scripts/probe-ps-block-number.js`, `scripts/probe-ps-sectiondcid.js`.

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
→ [{ dcid, id, psmSectionId, courseName, sectionNumber, expression ("2(A-B)"),
     attendanceModeCode, attendanceTypeCode, yearId, term,
     calenderDays: { "2025-08-21": { inSession, cycleDay: { letter:"A"|"B", ... }, ... }, ... },
     inSessionDays: [...],
     attendanceCodes: [...], attCodeToIdMap: {...},
     bellScheduleItems: [ { periodId, period: { id, periodNumber, name, abbreviation, sortOrder }, bellSchedule, startTime, endTime, ... } ],
     periodIdToPsmPeriodIdMap: { "<periodId>": "<psmPeriodId>" },
     sectionMeetings: [ { periodNumber, cycleDayLetter:"A"|"B", meeting:"2(A)" } ],
     maxEditablePastDate, maxEditableFutureDate }]
```
⚠️ `calenderDays`/`inSessionDays` ignore the `startDate`/`endDate` params — `section_info` returns the **whole year's** calendar regardless of range (verified 2026-06-08). The date range only matters for the per-day roster (`section_attendance`), not for `section_info`'s calendar or bell-schedule fields.

### Block number — the displayed "Block N" = `bellScheduleItems[].period.name` (#106, verified 2026-06-08)

**Resolved.** The canonical block a teacher sees at the top of the attendance-code column (e.g. ACSS = "Block 3") is the PowerSchool **period name**, available directly from `section_info` — **no in-session date, no `userDcid`, no `getattendance_integration` needed.**

```
block = section_info[0].bellScheduleItems[].period.name
        — filtered to periodId ∈ keys(periodIdToPsmPeriodIdMap)
        — distinct across items (every bell-schedule variant maps the section to the same period)
```

`period` shape: `{ dcid, id, schoolId, yearId, periodNumber, name:"Block 3", abbreviation:"BK3", sortOrder }`.

**⚠️ CRITICAL — `period.name` ≠ `periodNumber` ≠ the Schoology `expression`/`section_title` number.** This is exactly why Schoology's field (and even PowerSchool's `periodNumber`) is insufficient. Observed counter-examples:

| Schoology expr | `periodNumber` | displayed `period.name` | `abbreviation` |
|---|---|---|---|
| `7(A-B)` (APCSP) | 7 | **Block 6** | BK6 |
| `6(A-B)` (Robotics) | 6 | **Block 4** | BK4 |

So you must read `period.name`, not derive a number from the expression or `periodNumber`.

**Why it's stable per course:** `bellScheduleItems` contains one entry per bell-schedule variant the year uses (regular day, Early Release, Special Schedule, PCG Day, pilot schedules…) — **all 36 for ACSS carry the same `period` (id 4202 → "Block 3")**. Both `sectionMeetings` (A-day and B-day) carry the same `periodNumber`. So the block does not vary across A/B cycle days or schedule variants. Date-independent: `bellScheduleItems` is present even for an off-day (weekend) range.

**Triple-confirmed for ACSS** (sectionDcid 49355 → periodId 4202):
1. `section_info` resolution → `period.name` = "Block 3".
2. Rendered grid DOM: `<th class="attendance-header">Block 3</th>`.
3. The app's own `POST /ws/pagecustomizations/insertions` body → `parameters[0]` = `{ "att_period":"Block 3", "Period_ID":"4202", "sectionid":"49355" }`.

**Block resolution across all of the API user's 2025-26 sections** (one PS session, `section_info` per `sectionDcid`; probe: `scripts/probe-ps-block-number.js`):

| Section | sectionDcid | `period.name` | abbr | periodNumber | Schoology expr |
|---|---|---|---|---|---|
| Advanced Computer Science Studio | 49355 | **Block 3** | BK3 | 2 | 2(A-B) |
| AI & Machine Learning | 49390 | **Block 8** | BK8 | 8 | 8(A-B) |
| AP Computer Science Principles | 49354 | **Block 6** | BK6 | 7 | 7(A-B) |
| Mobile App Development | 49386 | **Block 1** | BK1 | 1 | 1(A-B) |
| PCG | 50210 | **Pastoral Care** | PCG | 11 | 11(A-B) |
| Robotics | 49388 | **Block 4** | BK4 | 6 | 6(A-B) |
| Teaching Assistant (Sem) | 49027 | **Block 4** | BK4 | 6 | 6(A-B) |
| Interim B | 51066 | **Interim** | IM | 12 | 12(A-B) |
| Interim A | 51067 | — | — | — | `section_info` → **500** (section-specific server error, not auth) |

Note **not every period is a numbered "Block N"**: PCG → "Pastoral Care", Interim → "Interim". Prism's `courses.block_number` column stores just the digit (UI renders `[BK {n}]`), so the sync stores the integer parsed from `^Block (\d+)$`. It is **PowerSchool-authoritative**: every regular sync re-resolves all *active* courses (opt-out checkbox in the sync dialog) and overwrites with PowerSchool's numbered block; sections where no number resolves (PCG/Interim, or a block not yet assigned at year start) keep their existing value. Running every sync means a course synced before its block was published **self-heals** on the next sync — no manual step. (Earlier designs used a fetch-once `block_synced_at` marker + a manual refresh button; both were dropped because the marker froze year-start courses empty. `block_synced_at` remains as an informational "last resolved" timestamp.)

**⚠️ Archived courses & past sections (verified 2026-06-08).** Block resolution only works for **current-year** sections. The attendance LTI / `section_info` is scoped to the current school year: a **prior-year** `sectionDcid` still resolves from the LTI launch form, but `section_info` on it returns non-200 → `section-info-failed`. Observed: of 15 archived courses, only the 2 current-year-but-archived sections resolved; all 13 prior-year ones failed. Implication: archived courses can't be reliably block-synced in bulk. So **archived courses get their block best-effort at import time** (`POST /api/courses/import` calls `syncBlockNumbers({ courseIds: [newId] })`) — current-year archived imports resolve, prior-year ones skip. The regular sync deliberately covers active courses only.

**Resolving Schoology section → `sectionDcid` for the sync** (verified 2026-06-08, probe `scripts/probe-ps-sectiondcid.js`): an authenticated `context.request.get(<LTI run URL>)` returns the launch-form HTML (HTTP 200, `text/html`, no JS redirect) — regex `name="custom_sectiondcid" value="(\d+)"`. Empty value = template/master course (skip). This is a **Schoology** fetch (carries the Schoology session cookie); it does not need the PowerSchool session.

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
`grad_year = Y + (12 − gradeLevel)` (G12→2026, G11→2027, G10→2028, G9→2029).

**Store the invariant, derive the display (corrected 2026-06-10, spike #43 — supersedes the earlier
"store grade_level, derive grad_year" note).** Persist `grad_year` (compute it once per sync from the
authoritative `gradeLevel`), and derive the *displayed* current grade on read. Rationale: `gradeLevel` is a
**time-relative** datum — "Gr 12" only means anything paired with the year observed — while `grad_year` is
**time-invariant** ("Class of 2026" forever). A student who leaves/graduates stops being re-synced, so their
stored value freezes: a frozen `grad_year` stays correct indefinitely, but a frozen `gradeLevel` re-derived
against the current year **drifts wrong** every rollover (a Gr-12 leaver reads as Gr-13 → grad_year 2027 the
next year). For *active* students re-synced each cycle the two are equivalent; the distinction only bites for
departed students — exactly when correctness matters. Prism uses the existing `students.grad_year` column;
display derives current grade = `12 − (grad_year − Y)` and shows no grade once it exceeds 12 (graduated).

### Caveats / open items

- **`userDcid` value:** the working `/ws/attendance/section_attendance` call used `userDcid=10005`, but the
  LTI `custom_userdcid` is `2_10405`. PowerSchool appears to resolve the real `userDcid` from the session,
  not the LTI param. Stripping the `2_` prefix gives `10405`, which did **not** match the working `10005` —
  so don't assume `custom_userdcid` is the value to pass. Confirm by reading it from a session endpoint, or
  test whether the roster returns regardless of `userDcid` (it likely only scopes "attendance taken by").
  *(Re-confirmed 2026-06-08: capturing the live attendance grid, the app's own `section_attendance` request
  used `userDcid=10005` — same value, still distinct from the LTI `2_10405`. The block-number sync (#106)
  sidesteps this entirely: `section_info` needs no `userDcid`.)*
- **Session fragility:** same as mastery sync — depends on the browser session; expires → re-login.
- **In-session date:** must be derived per-section from `section_info.calenderDays`; a hardcoded "today" breaks on off days.

### Student alerts & custom-alert popups (probed 2026-05-30, for #65)

The per-student alert icons in the attendance grid come from PowerSchool's **MBA custom-alerts plugin** (`aet_customalert`), whose client API lives under `/teachers/mba_alerts/queries/`. (Note: `section_attendance.studentAlerts` is a *different*, standard alert channel — empty for these students — and `getStudentsInSection.json` returns only the roster — **verified shape 2026-06-10, spike #43**: `POST` body `sectionIds={sectionDcid}` (date-free; note the plural param), response is a flat array of `{ ccid, sectionid, lastfirst, studentid, studentdcid }` — **roster identity only, NO `gradeLevel`/demographics**, so it is *not* a date-free grade-level source. The only confirmed `gradeLevel` read stays `/ws/attendance/section_attendance` (needs an in-session date). The PT-v1 `/ws/pt/v1/student/...` namespace — a possible cleaner date-free demographics/grade source — did **not** fire on the grid render and is still unprobed (tracked for a follow-up probe).) The plugin JS (loaded via `/ws/pagecustomizations/insertions`) is the map.

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

### Endpoint-discovery crawl (2026-05-30): attendance-app surface + #66 resolution

A read-only LTI-launch capture + grep of the attendance app's Angular bundle
(`/scripts/sgy-att-scripts/main.*.js`, ~923 KB) surfaced the **full client-side endpoint
surface of the Schoology→PowerSchool "attendance" LTI app**. Scope caveat: this is the
*attendance integration's* surface only — a lower bound on PowerSchool's `/ws/`, not all of it.

**Launch mechanism note:** the LTI run URL (`GET /apps/lti/4980125287/run/course/{sgySectionId}`)
returns an auto-submitting form whose `action` is `https://powerschool.hkis.edu.hk/ltigw/launch`
(`target=_self`). Under Playwright the inline auto-submit does **not** fire on `page.goto`; you
must explicitly `document.forms[0].submit()`, then the top page navigates to PS and the app loads
at `/integrations/attendance/index.html`. The embedded PS frame **detaches mid-loop** (playbook's
iframe-fragility warning) — for multi-read sweeps, do an **independent `page.goto` per request**
rather than reusing one frame (a shared-frame loop failed 5/6 reads; per-navigation got 6/6).

**Confirmed firing on load (200, session-auth) — new this pass:**
- `GET /ws/i18n/locale`, `GET /ws/i18n/formats`, `GET /ws/i18n/messageKeys?keys=...` — i18n bundles (low value)
- `GET /ws/preferences/core/pref/{prefName}` — generic per-install preference read (seen: `gvu-teacherlogoff`)
- `GET /public/pwteachers.html?redir=...` — teacher-portal entry; `GET /oidc/openid_connect_login` (302) — SSO hop

(Plus already-documented: `/ws/attendance/section_info`, `/ws/attendance/section_attendance`,
`POST /ws/schema/query/com.pearson.core.schools.grade_levels`, `POST /ws/pagecustomizations/insertions`,
`POST /teachers/mba_alerts/queries/getStudentsInSection.json`.)

**`/ws/pt/v1/attendance/getattendance_integration` — endpoint LIVE, correct params NOT yet found (2026-05-30).**

⚠️ *Correction:* an earlier revision of this doc documented a rich `attendance_data`/`students`/`attendance_codes`
response shape for this endpoint. **That shape was never observed and has been removed as fabricated.** What is
actually verified:

- The endpoint exists and the PS session reaches it (a known-good legacy `section_info` call returned 200 in the
  same probe, so the session is fine).
- With `Accept: application/json`, every param variant tried returned **409** `{"ErrorMessage":{"message":"Invalid sectionId: 0"}}`
  — i.e. the server parsed **none** of `sectionid` / `sectionDcid` / `section_id` as the section, defaulting to 0.
  (Without the Accept header it 500s with a serialization error — a content-negotiation quirk, not success.)
- So the bundle literals (`params:["sectionid","date"]` was an *inference* from nearby code, not a confirmed
  signature) do **not** map cleanly to a working query. The real call almost certainly resolves the section from
  a different param or from session/launch context (like the legacy `/ws/attendance/...` did with `userDcid`).

**To finish:** capture the app's *actual* `getattendance_integration` request from the live attendance grid
(it only fires when the grid renders for an in-session date) rather than reconstructing it — that will reveal the
true param name/value and the real response shape. Until then, the **legacy `/ws/attendance/section_attendance`
remains the only confirmed-working attendance read.**

> **Update 2026-06-08 (#106):** captured the live ACSS attendance grid render. `getattendance_integration`
> did **not** fire on this load — the grid rendered from `section_info` + `section_attendance` alone. Captured
> `/ws/` calls on grid render: `i18n/*`, `preferences/core/pref/gvu-teacherlogoff`,
> `schema/query/com.pearson.core.schools.grade_levels`, `attendance/section_info`,
> `pagecustomizations/insertions` (carries `att_period`/`Period_ID`), `attendance/section_attendance`.
> So `getattendance_integration`'s real signature is **still unresolved** (it must fire from a different
> view/interaction, not the default grid render). It was **not needed** for block number — see
> "Block number" above. The displayed "Block N" comes from `section_info.bellScheduleItems[].period.name`.

- `GET /ws/pt/v1/attendance/getattendanceformultisection` — same family, same unknown param mapping; not probed further.
- ⚠️ `POST /ws/pt/v1/attendance/saveattendance` and `/saveattendances` — attendance **writes** (the write path #39 needs; not probed, read-only policy).

**Referenced in the app bundle but NOT exercised on load (candidates — string literals, not yet shape-probed):**
- `/ws/pt/v1/student/...` — student data (PT v1; PII — probe carefully)
- `/ws/pt/v1/seating_chart/config/integration`, `/ws/pt/v1/seatingchart/objects/layout_integration/...`
- `/ws/seatingchart/config`, `/ws/seatingchart/objects/layout/...`, `/ws/seatingchart/section/attendance`, `/ws/seatingchart/section/multi_section_attendance`, `/ws/seatingchart/section/section_info`
- `GET /ws/preferences/core/user/pref/{prefName}` — per-user preference read
- `GET /ws/session/last-hit`, `POST /ws/session/terminate-session` — session keep-alive / logout

The `/ws/pt/v1/...` ("PowerTeacher v1") namespace is new here and is the modern read/write
attendance API — likely a cleaner attendance source than the legacy `/ws/attendance/...` calls,
pending shape probes.

#### #66 resolution — "G1/G2 Correspondence" alerts are NOT per-guardian identities

Verified via **GET-only** `aet_customalert_sf.html` reads (no POSTs): the three correspondence
alerts — `G1 Correspondence` (32012479), `G2 Correspondence` (32012481), `G1&G2 Correspondence`
(32012482) — **all reference the same single student-extension field, `X_HomeEmail`** (per the
documented catalog above). They do **not** resolve distinct per-guardian identities; the
G1/G2/G1&G2 distinction is encoded in each alert's trigger match against that one field's value,
not via separate guardian records. Live reads of `U_DEF_EXT_STUDENTS.X_HomeEmail` (dcid 44467,
2-guardian; dcid 38590 Claire Tse, G2 deceased) both returned 200 with a single, **heterogeneous,
PII-bearing** value per student — so exact value decoding was left for a careful PII-safe pass.

**Takeaway for Prism:** the genuinely *per-guardian* flags are the **paired** fields already in
the catalog — `X_DNC_G1`/`X_DNC_G2` (do-not-contact) and `X_G1DECEASED`/`X_G2DECEASED` — not the
Correspondence alerts. Distinct per-guardian *contact details* (names/emails) are not exposed by
these alerts; they live in PowerSchool's guardian/contact tables (see Frontier).

### Student home / postal address (#68 — wanted feature; feasibility, live probe pending)

The user wants student **home / postal address** surfaced in Prism. Where it lives (2026-05-30 analysis; no live read yet — tracked in **#68**):

- **Schoology cannot provide it.** `GET /v1/users/{uid}` exposes email / parents / names / photo / role but **no postal address** — Schoology is not the demographics system of record.
- **PowerSchool is the source** (SIS — standard `students` street/city/state/zip). Reachable surface **unconfirmed**: the clean OAuth `GET /ws/v1/student/{id}?expansions=addresses` is blocked (needs admin `client_id`/`secret` — see "What's Needed to Get Access"); the near-term lead is the session-auth **`/ws/pt/v1/student/...`** namespace (or a `/ws/schema/query` named query), riding the mastery-sync browser session. The `/ws/pt/v1/student/...` literal is already listed under "Referenced in the app bundle but NOT exercised on load" above (PT v1; PII — probe carefully). Join is deterministic: `students.school_uid == "1_" + dcid`.
- **Safeguarding-tier PII** — addresses for minors are highly sensitive. Probe PII-safe (masked / shape only; never commit a real address) and gate behind a feature flag + human implementation, exactly like the do-not-contact / deceased-guardian flags (#65). The clean long-term fix waits on PowerSchool OAuth `/ws/v1/` credentials.

### Relevance to other issues

- **#68 (student home/postal address):** Schoology has none; PowerSchool is the source — see "Student home / postal address" above (session-auth `/ws/pt/v1/student` lead, safeguarding-tier PII, live probe pending).
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
