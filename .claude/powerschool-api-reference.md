# PowerSchool API Reference

Findings from probing the HKIS PowerSchool server.

There are **two** independent ways into PowerSchool data:
1. **OAuth-2 `/ws/v1/` plugin API** — the "official" path. Still blocked: needs an admin to hand over a `client_id`/`secret` (see "What's Needed to Get Access"). No working credentials yet.
2. **Session-authenticated web services (`/ws/...`)** — the internal endpoints the PowerSchool web UI itself calls. **These work today**, riding the same browser session the mastery sync already uses (HKIS SSO covers both Schoology and PowerSchool). No plugin credentials required. See "Session-Authenticated Web Services" below — this is how grade level / year group becomes syncable.

Last probed: 2026-04-05 (OAuth path, script: `test-powerschool-probe.js`)
Session-auth path discovered: 2026-05-30 (via the Schoology "attendance" LTI app — resolves issue #43's "run a probe for this page" ask).
Endpoint-discovery crawl: 2026-05-30 — captured the attendance LTI app's full `/ws/...` surface (incl. new `/ws/pt/v1/...` PowerTeacher API) and resolved #66; see "Endpoint-discovery crawl" below.
Block-number resolved: 2026-06-08 (#106) — the displayed "Block N" = `section_info.bellScheduleItems[].period.name`; see "Block number" below. Probes: `scripts/probe-ps-block-number.js`, `scripts/probe-ps-sectiondcid.js`.
Student alerts over plain HTTP: 2026-10-17 (#117) — the LTI launch, the MBA alert catalogue, rosters, field values and advanced-alert matches all read with `fetch`, no browser; see "Student alerts over plain HTTP (#117)" below. Probes: `scripts/probe-ps-alerts-http.js`, `scripts/parity-ps-alerts.js`.
Student grade level, gender, postal address: 2026-10-17 (#116) — grade level and gender from `/ws/pt/v1/` (JSON, plain HTTP, no date), the address only on the PowerTeacher Demographics screen (HTML); see "Student grade level, gender and postal address (#116)" below. Probe: `scripts/probe-ps-student-fields.js`.
Grade level from the section student list: 2026-10-18 (#164) — Prism's grade-level read, plain HTTP, `section_attendance` kept as the fallback; 0 mismatches over 110 student rows; see "Grade level from the section student list (#164)". Parity: `scripts/parity-ps-grade-level.js`.

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
already carries this — no separate PowerSchool login needed. *(Since 2026-10-17/18, #117 and #141: no browser
either. The PowerSchool session is made over plain HTTP by POSTing the LTI launch form, see "Student alerts over
plain HTTP (#117)" step 1 and "Block number", "Plain HTTP, no browser".)*

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

**2026-10-01 (triage, #task-13) — observed `calenderDays` entry shape, stored verbatim in `school_days.raw`.** Live sync via `syncPsAttendance` → `extractCalendarDays`/`mergeCalendarDays` (`server/lib/psCalendar.js`), dev clone DB, 2026-27 school year (308 rows synced).

In-session, cycle day present (`2027-01-12`):
```json
{"dcid":50952,"id":50952,"schoolId":40,"date":"2027-01-12","scheduleId":"A","a":1,"b":1,"c":1,"d":1,"e":1,"f":1,"inSession":true,"membershipValue":1,"note":null,"type":null,"cycleDayId":3502,"cycleDay":{"dcid":3502,"id":3502,"schoolId":40,"yearId":36,"letter":"B","dayNumber":2,"abbreviation":"B","sortOrder":2},"bellScheduleId":4235,"weekNumber":0,"ipAddress":null}
```

Not in session (`2027-01-10`):
```json
{"dcid":50950,"id":50950,"schoolId":40,"date":"2027-01-10","scheduleId":"A","a":0,"b":0,"c":0,"d":0,"e":0,"f":0,"inSession":false,"membershipValue":0,"note":null,"type":null,"cycleDayId":0,"cycleDay":null,"bellScheduleId":0,"weekNumber":0,"ipAddress":null}
```

`inSession: true`, non-school-day type, `cycleDay: null` (`2026-10-01`, a public holiday PS still flags `inSession: true`):
```json
{"dcid":50849,"id":50849,"schoolId":40,"date":"2026-10-01","scheduleId":"A","a":1,"b":1,"c":1,"d":1,"e":1,"f":1,"inSession":true,"membershipValue":1,"note":"Public Holiday (National Day)","type":"PH","cycleDayId":0,"cycleDay":null,"bellScheduleId":0,"weekNumber":0,"ipAddress":null}
```

`cycleDay` carries more than just `letter`: `dayNumber` (observed values 1/2, matching the A/B letter 1:1 — i.e. PS's own cycle is a plain two-value A/B alternation, numbered), plus `abbreviation` (mirrors `letter`) and `sortOrder`. **The dashboard currently surfaces only `letter`** — `dayNumber`/`sortOrder`/`abbreviation` are stored in `raw` but unused.

**Calendar parity vs the 2026-27 Master Plan (`scripts/parity-school-calendar.js`, dev DB, overlap 2026-08-13 → 2027-06-16): PARITY DIFFERS.**
- School days: Master Plan 164, PowerSchool (`in_session=1`) 220 — a 56-day gap, and it is *one-directional*: `onlyInPlan` is empty (every Master Plan school day is also `in_session=1` in PowerSchool), `onlyInPs` has all 56 extra dates.
- **Root cause (confirmed by inspecting `raw` for every `onlyInPs` date): PowerSchool's `inSession` boolean is true on days that are not instructional days.** Every one of the 56 extra dates has `cycleDay: null`/`cycleDayId: 0` and a `type`/`note` marking it non-instructional: `"type":"PH"` (public holiday, e.g. 2026-10-01 National Day, 2026-10-19 day after Chung Yeung), `"type":"H"` (Winter Break, e.g. 2026-12-14..2027-01-01), `"type":"PD"` (Professional Development Day, e.g. 2026-11-26), `"type":"O"` (Interim, e.g. 2027-03-01), `"type":"M"` (half day, e.g. 2027-06-16 "Last Day of School (Half Day)"). The Master Plan's cycle-day column correctly excludes all of these; PS's `inSession` flag does not — it means "the school year is in session" (membership/calendar-active), not "classes meet today". `extractCalendarDays` (`server/lib/psCalendar.js`) currently takes `inSession` at face value without checking `cycleDay`; the reliable "is this a teaching day" signal is `cycleDay != null`, not `inSession`. **Not fixed in this task** (live investigation only, no code changes per brief) — flagging for whoever next touches `mergeCalendarDays`/the in-session rule. *(superseded 2026-10-02 — fixed, see below)*
- Letter mapping: `letterByParity` (keyed by Master Plan cycle-day-number parity, odd/even) converged to `{"0":"A","1":"A"}` with 80 flagged mismatches, all landing on Master Plan cycle-days 3/4/7/8 (never 1/2/5/6). Cross-checking PS's own consecutive school days directly (e.g. 2026-08-13→2026-08-27: letters run A,A,A,A,B,B,A,A,B,B,A) shows PS's A/B letter **repeats in pairs**, not strict day-to-day alternation. The Master Plan's own cycle-day column (1–8) is therefore a different numbering scheme (likely a block/rotation counter) from PS's A/B letter cadence; reducing the Master Plan's 1–8 number mod 2 does not track PS's actual AABB-grouped letter pattern, which produces a deterministic quarter-cycle mismatch rather than a real data error. No `onlyInPs`/`onlyInPlan` disagreement is implicated here — this is purely an artifact of comparing two different cycle-numbering schemes via naive parity, not a data bug.

**2026-10-01/02 (triage, #task-13) — fixed, re-synced, parity now matches.** Per the root cause above, `extractCalendarDays` (`server/lib/psCalendar.js`) now requires **both** `inSession` and a non-null `cycleDay` before treating a date as a school day (commit `fix(triage): school day = in session with a cycle day; parity letter check by cycle day`). `compareCalendars` (`scripts/lib/masterPlanCalendar.js`) now learns PowerSchool's letter **per Master Plan cycle-day number (1–8)** instead of by odd/even parity, since the school's A/B cadence pairs up by cycle-day number (1-2=A, 3-4=B, 5-6=A, 7-8=B) rather than alternating daily — this removes the spurious parity mismatches documented above without being a data bug fix (it's a comparison-model fix).

Re-ran the live sync (dev clone DB, same 2026-27 year, 308 calendar rows stored — the row count is unchanged; only which rows count as `in_session` changed) and the parity script against the same Master Plan file. New result:

```
Overlap 2026-08-13 → 2027-06-16
School days: Master Plan 164, PowerSchool 165
Cycle-day → PowerSchool letter: {"1":"A","2":"A","3":"B","4":"B","5":"A","6":"A","7":"B","8":"B"}
Only in PowerSchool (1): 2026-12-11
Only in Master Plan (0): —
Letter mismatches (0): —
PARITY DIFFERS ❌  (exit 1 — one date still outside the Master Plan's school-day count; see below)
```

The sole remaining `onlyInPs` date, `2026-12-11`, is **accepted, not a bug**: its `raw` has `"note":"End of S1 (Half Day)"`, `"type":"M"`, and — unlike the other 56 non-instructional days found earlier — a **present** `cycleDay` (`{"letter":"A","dayNumber":1,...}`). PowerSchool counts this half day as an instructional day (it has a cycle letter); the Master Plan's Daily Planning View does not mark it with a numeric cycle day in column F. PowerSchool's count (165) is accepted as correct for this one date; 164/165 is the expected steady state, not a residual bug. The letter mapping is now a clean per-cycle-day pairing (`1,2→A`; `3,4→B`; `5,6→A`; `7,8→B`) with **zero** letter mismatches, confirming the original letter-mismatch finding above was purely a comparison-model artifact (naive parity vs. the real paired cadence), not a data problem.

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

**Resolving Schoology section → `sectionDcid` for the sync** (verified 2026-06-08, probe `scripts/probe-ps-sectiondcid.js`): an authenticated `context.request.get(<LTI run URL>)` returns the launch-form HTML (HTTP 200, `text/html`, no JS redirect) — regex `name="custom_sectiondcid" value="(\d+)"`. Empty value = template/master course (skip). This is a **Schoology** fetch (carries the Schoology session cookie); it does not need the PowerSchool session. *(Since 2026-10-18 (#141) the same GET is a plain `fetch` with the saved cookies, `powerschoolWeb.launchIds`; `context.request` is no longer used.)*

**Plain HTTP, no browser (#141, verified 2026-10-18, read only).** The block pass (`server/services/psAttendanceSync.js`)
no longer opens a browser. Per course it reads the launch form from Schoology (above); the first course with a
`sectionDcid` starts the PowerSchool session by POSTing that same form to its action
(`server/services/powerschoolWeb.js`, as in "Student alerts over plain HTTP (#117)" step 1); then
`GET /ws/attendance/section_info` (the same query string as before) with PowerSchool's cookies and
`Accept: application/json`. After the loop the grade-level pass (#164, `psGradeLevelRead.js`: the section student
list, `section_attendance` as fallback) runs on the same session with the `section_info` answers in hand, so the
whole pass makes one launch. A redirect or a non-JSON page means PowerSchool's
session ended (relaunch once with a fresh form, ask again); an error status is the section's own answer
(`section-info-failed:<status>`); a page carrying "Security Violation Logged" stops the pass (`PS_SECURITY`; not
seen). Observed on 2026-10-18 (counts only):
- **Active courses:** 9 of 9 `section_info` reads answered 200: 8 numbered blocks, 1 `not-numbered` (its name
  not printed); 308 calendar days (165 school days), 522 lesson dates across the 9; grade levels for 96 students
  (first runs: from `section_attendance` in the loop; after the #164 merge: 9 of 9 sections from the student list,
  480 ms). One launch for the whole pass.
- **Archived courses (targeted, as the import does):** 25 of 25 answered `section_info` **500**
  (`section-info-failed:500`), the browser path the same (25 of 25 `section-info-failed`). Not checked which school year
  each belongs to; it fits the finding above that prior-year sections fail.
- **Parity** (`scripts/parity-ps-blocks.js`: the pre-#141 browser pass, kept in
  `scripts/lib/psAttendanceSyncBrowser.js`, and the HTTP pass, each on its own blanked copy of the database):
  per-course result 9 of 9, `courses.block_number` 35 of 35, `class_meetings` 522 = 522 dates, `school_days`
  308 = 308 rows (date, in session, letter and `raw` identical), `students.grad_year` 295 of 295 (96 seen
  each way). **0 differences**, in all four runs (two before and two after merging #164's grade pass).
- **Wall time** for the whole pass (9 active courses): browser 8.3, 8.1, 9.6, 8.3 s; HTTP 5.1, 5.3, 4.9, 5.0 s.
  The archived targeted pass: browser 11.7 s, HTTP 9.3 s for 25 courses.

### Which days a class meets (its lessons): `calenderDays[d].bellScheduleId` ∈ the section's `bellScheduleItems[].bellScheduleId` (verified 2026-10-06)

**A section's own `calenderDays` do NOT mark its meeting days.** They span the section's whole term: every
school day in it (`inSession` + `cycleDay`) is listed. Observed for all 9 active sections on 2026-10-06
(`scripts/probe-section-meeting-days.js`, read-only): full-year sections 165 school days
(`{"A":85,"B":80}`), semester sections 76 or 89. Comparing sections' school-day sets: identical within a term.
The `expression` (`"1(A-B)"`) and `sectionMeetings` (`[{ periodNumber: 1, cycleDayLetter: "A", meeting: "1(A)" },
{ …"B"… }]`) say "meets on A and B days", i.e. also every day, so neither identifies lessons either.

**The bell schedule does.** Every `calenderDays` entry carries a `bellScheduleId` (day keys observed: `dcid, id,
schoolId, date, scheduleId, a…f, inSession, membershipValue, note, type, cycleDayId, cycleDay, bellScheduleId,
weekNumber, ipAddress`), and `section_info.bellScheduleItems` lists ONLY the bell schedules that contain the
section's period (item keys: `dcid, id, bellScheduleId, bellSchedule, periodId, period, dayPartId, dayPart,
startTime, endTime, minutesAttended, adaCode, dailyAttendanceCode`; `bellSchedule.name` e.g. `"PCG Day 1 "`; every
item's `periodId` is the single key of `periodIdToPsmPeriodIdMap`). So: **meets on date d ⇔ d is a school day and
`calenderDays[d].bellScheduleId` is one of the items' `bellScheduleId`s.** That gives each class about half the school
days (observed meeting/school days: 44/89 and 45/89, 38/76, 82/165 and 83/165), alternating day by day: e.g. Block 1/5/7 meet
Tue 06, Thu 08, Mon 12, Wed 14, Fri 16 Oct 2026 and Blocks 2/6 on Mon 05, Wed 07, Fri 09, Tue 13, Thu 15.
**Teacher confirmed the derived two-week table matches the real timetable (2026-10-06).** PCG (advisory) has an
irregular pattern. Implemented as `extractMeetingDates` (`server/lib/psCalendar.js`), stored per course in
`class_meetings` on every block sync; used only for "N lessons from today" hints (all clocks count school days).

**A section's term = its calendar's first and last school day (2026-10-23, #174).** Because `calenderDays` span the
section's whole term, the first and last date that is a school day (`inSession` and a `cycleDay`) are the term's
start and end. Read live for all 9 active courses on a dev copy, 23 Oct 2026: semester sections 2026-08-13 to
2026-12-11 (Mobile Games, Robotics Block 2, Teaching Assistant (SEM)) and 2027-01-04 to 2027-06-08 (Mobile App,
Robotics Block 5); full-year sections 2026-08-13 to 2027-06-08 (AI & ML, AP CSP Blocks 6 and 7, PCG). Stored per
course as `courses.term_start` / `term_end` on every block sync (`termRange`, `server/lib/psCalendar.js`); Triage's
Flags panel takes a date's semester end from the shortest stored term containing it (`server/lib/semesters.js`).
`section_info.term` was not used. **The calendar's longest break is the semester split (2026-10-24, #180):** on prod's
merged `school_days` for 2026-27, the longest gap between school days in the full-year term is winter, 2026-12-11 to
2027-01-04 (24 days; next spring 2027-03-23 to 04-06, 14 days, then Chinese New Year 2027-02-04 to 02-15, 11 days), and
the last school day before it and the first after it are exactly the semester sections' term end and start. Prism uses
that split only where no semester term is stored.

### Step 3 — Fetch the roster with grade level

*(2026-10-18, #164: now the **fallback** grade-level read. Prism reads grade level from the section student list,
`/ws/pt/v1/section/{psmSectionId}/students_integration`, with no date; see "Grade level from the section student list
(#164)" below. Parity: 0 mismatches over 110 student rows. Since #164 this read goes over plain HTTP, not the browser.)*

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

**⚠️ Use a multi-day RANGE, not a single day, for full roster coverage (verified 2026-06-10, #43).**
`section_attendance` returns a section's `studentAttendance` roster only for days that **section actually
meets** (A/B block rotation) — a single `startDate==endDate` query returns an **empty** `sectionAttendances`
for any section not meeting that exact day. So a sync that picks one school-in-session day captures only the
blocks meeting that day (live: 18/108 students; only the 2 blocks meeting that date). Query a **range of
~15 in-session days** instead: the response then contains one `sectionAttendances[]` entry per meeting day,
each repeating the full roster — dedupe per student by `dcid` (`Map<dcid → gradeLevel>`). With the range,
coverage hit 100% of every block-resolvable course (75/108; the rest are interim-only / archived). Grade
level is the same per-student value on every day, so de-duplication is lossless. See `pickInSessionRange`
in `server/lib/psGradeLevel.js`.

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
  *(2026-10-18, #141: the attendance reads now go over plain HTTP with the saved Schoology cookies, and a
  Schoology bounce to sign-in renews once through Microsoft first, `schoologyWeb.getResource`; a re-login is
  needed only when Microsoft asks for a real sign-in.)*
- **In-session date:** must be derived per-section from `section_info.calenderDays`; a hardcoded "today" breaks on off days.

### Student alerts & custom-alert popups (probed 2026-05-30, for #65)

The per-student alert icons in the attendance grid come from PowerSchool's **MBA custom-alerts plugin** (`aet_customalert`), whose client API lives under `/teachers/mba_alerts/queries/`. (Note: `section_attendance.studentAlerts` is a *different*, standard alert channel — empty for these students — and `getStudentsInSection.json` returns only the roster — **verified shape 2026-06-10, spike #43**: `POST` body `sectionIds={sectionDcid}` (date-free; note the plural param), response is a flat array of `{ ccid, sectionid, lastfirst, studentid, studentdcid }` — **roster identity only, NO `gradeLevel`/demographics**, so it is *not* a date-free grade-level source. The only confirmed `gradeLevel` read stays `/ws/attendance/section_attendance` (needs an in-session date). The PT-v1 `/ws/pt/v1/student/...` namespace — a possible cleaner date-free demographics/grade source — did **not** fire on the grid render and is still unprobed (tracked for a follow-up probe). *(Probed 2026-10-17, #116:
`/ws/pt/v1/section/{psmSectionId}/students_integration` and `/ws/pt/v1/student/{psmId}` are date-free and carry
`gradeLevel` and `gender`; see "Student grade level, gender and postal address (#116)".)*) The plugin JS (loaded via `/ws/pagecustomizations/insertions`) is the map.

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

*(2026-10-17, #117: the catalogue gives Allergies (10593855) `trigger_type: adv` (`allergies.html`), not sf, though
its `student_field` names `X_ALLERGYCNF`; EpiPen is 10593828 and Missing Health Form 11361898 (both sf). Full
id/rule table in "Student alerts over plain HTTP (#117)".)*

**Reading an `sf` field value (confirmed end-to-end):**
```
GET /teachers/alerts/aet_customalert_sf.html?frn=001{dcid}&mba_frn=001{dcid}&id={alertId}
    &student_field=U_DEF_EXT_STUDENTS.{FIELD}&tableName=U_DEF_EXT_STUDENTS
→ HTML: "{Student Name}  U_DEF_EXT_STUDENTS.{FIELD}: {value}"   (parse after the last ': ')
```
⚠️ **Table-name gotcha:** the working table is **`U_DEF_EXT_STUDENTS`**, *not* the catalog's `student_field` prefix (`U_Students_Extension`) — the latter returns the icon but no value. Verified: Claire Tse (`frn=00138590`, `X_G2DECEASED`) → `1` (deceased Guardian 2 = true). Empty body = flag not set. Batch read also exists: `GET stuFieldValues.json?stuList={ids}&student_id={ids}&field1={f}&fieldTbl1={tbl}&table1={tbl}` (params per the plugin JS; finalize against a live call). *(Finalized 2026-10-17, #117: `{ids}` are PowerSchool **studentid**s, not dcids, and `field{n}` is the lower-case field name; see "Student alerts over plain HTTP (#117)" below.)*

**Implication (supersedes earlier "scrape HTML" framing):** most safeguarding/SEN flags are **structured `field: value` reads** (boolean-ish or short text), not brittle table-scraping. Only the `adv` popups (siblings/MAP/support-summary detail) are HTML tables. So the do-not-contact/deceased/divorced data (#66) is cleanly readable. Still session-auth (expires → re-login). PII stance now per **ADR `docs/adr/0002-pii-handling-philosophy.md`** — teacher-accessible data, surface it under local-first / teacher-scoped / feature-flagged guardrails (this **supersedes** the earlier "human-implemented + display-only, treat as blocker" framing). OAuth `/ws/v1/` + PowerQuery remains the cleaner long-term source if credentials arrive. Tier A (`onTrack`, `enrolled`, enrollment dates, attendance tallies) needs none of this.

**Update 2026-06-11 (#43 shipped → #117 spun out):**
- **`section_attendance` is already fetched + mostly discarded.** `psAttendanceSync` pulls it every sync (over a ~15-in-session-day range) and keeps only `gradeLevel`. *(2026-10-18, #164: no longer every sync; it is now only the fallback when the section student list fails, so the Tier A fields below would need their own read.)* The same `studentAttendance[]` rows already carry **Tier A** — `onTrack`, `enrolled`, `ccDateEnrolled`/`ccDateLeft`, per-day `meetingAttendance[].code`, and range-scoped `studentAbsentCount`/`studentTardyCount`. So #65 (on-track/enrollment) and #39 (attendance read) are "store fields already in hand," no new call.
- **`includeStudentAlerts=true` is NOT the accommodation source.** #43 sets it `false`. Flipping `true` only populates `section_attendance.studentAlerts` (the **standard** channel — empty for these students). The real per-student SEN/accommodation flags are the **MBA custom-alerts plugin** above (`stuFieldValues.json` `sf` flags + `adv` popups).
- **Open probe for #117:** the `sf` flags are *presence* booleans (`X_SPP` = has-accommodation-plan). The **detail** — "what accommodation / how much extra time" — lives in the `adv` **SPP / Student Support Summary** popup (`mbapop_spp.html` / support-summary), which is **HTML and not yet shape-probed**. Capturing that (JSON endpoint vs HTML scrape) is the first step of #117. *(2026-10-17: the presence flags shipped in #117 over plain HTTP, see "Student alerts over plain HTTP (#117)" below; the detail popups are still not shape-probed and the extra-time amount is a follow-up. `mbapop_spp.html` is the SPP alert's `stub_url` (its popup); the alert itself is `sf` on `X_SPP`, not `adv`.)*

### Student alerts over plain HTTP (#117, verified 2026-10-17)

Read only, values masked: every probe printed status codes, field names, value *types* and counts, never a value
or a name. Probes: `scripts/probe-ps-alerts-http.js <schoologySectionId> [launch|catalogue|roster|wsinfo|insertions]`
(one section; no step = launch → catalogue → roster → values → adv → manual) and `scripts/parity-ps-alerts.js`
(the sync itself, against a database copy). Code: `server/services/powerschoolWeb.js` (session),
`server/lib/psAlerts.js` (rules, Prism's kept set), `server/services/psAlertsSync.js` (sync).

**1. Session, no browser.** `storage-state.json` holds **no** PowerSchool cookies (only Schoology and Microsoft
ones), so the session is made fresh from the attendance LTI tool each sync:
- `GET https://schoology.hkis.edu.hk/apps/lti/4980125287/run/course/{schoologySectionId}` with the Schoology session
  cookies → **200** HTML with one form. Field names observed: `lti_message_type`, `lti_version`,
  `launch_presentation_document_target`, `tool_consumer_info_product_family_code`, `tool_consumer_info_version`,
  `ext_lms`, `ext_submit`, `oauth_callback`, `user_id`, `roles`, `launch_presentation_locale`, `lis_person_name_given`,
  `lis_person_name_family`, `lis_person_name_full`, `lis_person_contact_email_primary`, `lis_person_sourcedid`,
  `context_id`, `context_type`, `context_title`, `context_label`, `resource_link_id`, `resource_link_title`,
  `resource_link_description`, `launch_presentation_return_url`, `tool_consumer_instance_guid`,
  `tool_consumer_instance_name`, `custom_sectiondcid`, `custom_userdcid`, `custom_username`, `oauth_signature_method`,
  `oauth_signature`, `oauth_nonce`, `oauth_timestamp`, `oauth_token`, `oauth_consumer_key`, `oauth_version`.
  Form `action` = `https://powerschool.hkis.edu.hk/integrations/attendance/index.html`.
- `POST` those fields (urlencoded) to the action → **200** `text/html` (~53 KB, the attendance app), no redirect,
  with `Set-Cookie` **`JSESSIONID`, `psaid`, `currentSchool`**. Those cookies carry every read below.
- One launch served all 9 active sections of a sync (6.2 s for 96 students, 2026-10-17). The form is signed with a
  nonce, so a relaunch reads a fresh form first. The same session also answered
  `GET /ws/attendance/section_info` (200, `bellScheduleItems` present, 308 `calenderDays`), so the block pass
  (`psAttendanceSync.js`) can likely drop its browser too: **a lead for #141**, not done in #117.
  *(Done 2026-10-18, #141: the block pass is plain HTTP on this session; see "Block number", "Plain HTTP, no
  browser".)*

**2. The plugin code.** The MBA custom-alerts plugin's JS is served inline by
`POST /ws/pagecustomizations/insertions?_={unix}`, JSON body `{ "path": "/integrations/attendance/index.html",
"insertions": ["content.footer"], "parameters": [{ sectionid, frn: "003{sectionDcid}", att_period, att_date,
Att_Mode_Code, pagetype, ATT_Source_Code, Period_ID }] }` (the attendance bundle's `getCustomizationsBody`). It
answered **400** until the request also carried `Origin` and `Referer` (the attendance page) and
`Accept: application/json, text/plain, */*` (which of the three it needs was not isolated), then **200**: JSON
`{ "content.footer": "<html with the plugin's <script>s>" }`. In that code every read is `jQuery.post(path, params,
'json')` (`getData`), which **pops the last element** of an array answer (a trailing meta entry). Per section the page
calls `getStudentsInSection`, then per student `getAlerts` (man), `stuFieldValues` (sf) and `getAdvTriggerMatches`
(adv, skipping `trigger_url: QUERY_CHECK.html`). Prism makes the same reads once per section instead (below).

**3. Catalogue — `POST /teachers/mba_alerts/queries/getAlertTypes.json`** (`disabled=0&student_schoolid=40`) → 200,
**34 entries = 33 alerts + a trailing `{}`** (31 alerts on 2026-05-30). Every value is a string. Keys: `color`,
`disabled`, `icon`, `icon_type`, `id`, `name`, `public_visibility`, `querystring`, `additional_params`, `school_number`,
`stub_url`, `student_field`, `student_field_invert`, `student_field_operand`, `student_field_operator`,
`disable_student_field`, `sub_visible`, `teacher_visible`, `trigger_type`, `trigger_url`, `report_exclusion`,
`school_abbreviation`, `ext_table_name`, `sort_order`. The rules as configured (school configuration, not student data):

| id | type | field (sf) or `trigger_url` (adv) | rule | name (as PowerSchool spells it) | Prism key |
|---|---|---|---|---|---|
| 18746902 / 18746903 / 18746904 | adv | `mba_attendance.html`, `querystring` `vtotcount=10` / `15` / `20` | | Absence Alert (10) / (15) / (20+) | |
| 18729467 | adv | `mba_attendance.html`, `vtotcount=1` | | Absence Alert (Current Semester) | |
| 10593860 | sf | `X_SPP` | in `1` | Accomodation Plan | `accommodation_plan` |
| 11361904 | adv | `ls_accomodating.html` (field shown `X_LS_SUPPORT_LEVEL`, operand `0`) | | Accomodations Only | `accommodations_only` |
| 10593855 | adv | `allergies.html` (field shown `X_ALLERGYCNF`, operand `Y`) | | Allergies | `allergies` |
| 10593867 / 10593869 | sf | `X_APIABOVE100` | in `1` / in `3` | AQHI 6 or Above Inside At All Times / Except Events | |
| 10593864 / 10733416 | sf | `X_G1DECEASED` / `X_G2DECEASED` | in `1` | Deceased Guardian 1 / 2 | raw value stored (#66) |
| 10593857 | sf | `X_G1G2Relationship` | in `Divorced,Separated` | Divorced | `divorced` (family) |
| 10672509 / 10672510 | sf | `X_DNC_G1` / `X_DNC_G2` | notblank | Do Not Contact Guardian 1 / 2 | raw value stored (#66) |
| 11290939 | man | | | Early Dismissal | |
| 10672527 | sf | `X_ELEVATORALERT` | notblank | Elevator Alert | `elevator` |
| 39945753 | sf | `U_STUDENTS_EXTENSION3.X_HEALTHCAREPLANACTIVE`, ext table **`U_DEF_EXT_STUDENTS0`** | in `X` | Emergency Health Care Plan | `health_care_plan` |
| 27330244 | adv | `employee_child.html` | | Employee Child | `employee_child` (family) |
| 10593828 | sf | `X_ALLERGYEPI` | in `Y` | EpiPen | `epipen` |
| 32012482 / 32012479 / 32012481 | sf | `X_HomeEmail` | in `3` / `1` / `2` | G1 and G2 / G1 / G2 Correspondence | `correspondence_both` / `_g1` / `_g2` (family) |
| 10593859 | sf | `X_ILP` | in `1` | Individual Learning Plan | `ilp` |
| 10593862 / 10593861 / 10593863 | sf | `X_LS_SUPPORT_LEVEL` | in `1` / `2` / `3` | Learning Support Level 1 / 2 / 3 | `learning_support_1/2/3` |
| 10672526 | sf | `X_LIBRARYALERT` | notblank | Library Alert | |
| 27462703 | adv | `nwea_map.html` | | MAP Test | |
| 11361898 | sf | `X_MedicalConfirm` | notin `1` | Missing Health Form | |
| 39472338 | man | | | Mobility | `mobility` |
| 10593856 | sf | `X_PublicityNotice` | in `N` | No Photo | `no_photo` |
| 11290961 | adv | `sibling.html` | | Siblings List | `siblings` (family) |
| 11290981 | adv | `studentsupportsummary.html` | | Student Support Summary | `support_summary` |

Unless shown, an sf entry's `student_field` is `U_Students_Extension.{FIELD}` and its `ext_table_name` is
`U_DEF_EXT_STUDENTS`: the catalogue now carries the table to read (the 2026-05-30 table-name gotcha). The new Emergency
Health Care Plan alert reads a **different** extension table, `U_DEF_EXT_STUDENTS0`. `stub_url` is each alert's popup
(`mbapop_*.html`, e.g. SPP → `mbapop_spp.html`); Prism does not read popups. The plugin's sf rule (from its code): the
operand is a comma list, trimmed and lower-cased, an empty item matching an empty value; operators `notblank` /
`blank` (value null or not), `in` / `notin`, `contains` / `notcontain` (first operand). Prism evaluates the live
catalogue's rule each sync, never a copy, and keeps the alerts by `id` (`ALERT_DEFS` in `server/lib/psAlerts.js`).

**4. Roster — `POST getStudentsInSection.json`** (`sectionIds={sectionDcid}`) → array of
`{ ccid, sectionid, lastfirst, studentid, studentdcid }` (all strings) **plus a trailing `{}`** (19 entries for 18
students).

**5. Field values — `GET stuFieldValues.json`** (POST answered the same). Params, as the plugin builds them:
`stuList` and `student_id` = comma list of **PowerSchool `studentid`s** (passing dcids returns other students);
`field{n}` = the field name **lower-cased** (`x_spp`); `fieldTbl{n}` = its `ext_table_name` (`students` for a column
of `students`); `table{n}` = each distinct extension table once. **One call per section works** (18 studentids → 18
records). Answer: array of `{ id: number, dcid: number, <field>: string | null, … }` plus a trailing `{}`; `id` is the
`studentid` and `dcid` the roster's `studentdcid` (18 of 18 matched); every requested field is on every record,
`null` = not set. Value types in one section of 18: `x_spp` string(1) | null; `x_apiabove100` string(1) | null;
`x_allergyepi` string(1) | null; `x_g1g2relationship` string(7 to 16) on all 18; `x_homeemail`, `x_medicalconfirm`,
`x_publicitynotice` string(1) on all 18; `x_dnc_g1/g2`, `x_g1deceased/g2deceased`, `x_ilp`, `x_ls_support_level`,
`x_elevatoralert`, `x_libraryalert`, `x_healthcareplanactive` null on all 18. The four contact fields were null for
all 96 students synced, so the only set value seen is still the 2026-05-30 `X_G2DECEASED` → `1`.

**6. Advanced alerts — `POST getAdvTriggerMatches.html{?querystring}`** (form `trigger_url`, `studentIds`, `frn`,
`querystring`). `studentIds` takes a **comma list** (the plugin sends one student with `frn=001{dcid}`; Prism sends the
section with `frn` empty). Answer: `text/html` content type, but a **JSON object keyed by each matched `studentid`**
(string values, not read by Prism) plus a `"-1": ""` meta key. In one section of 18: Allergies 3 keys, Student
Support Summary 1, MAP Test 17, Siblings List 14; Accomodations Only, Employee Child and the four Absence Alerts 0.

**7. Manual alerts — `POST getAlerts.json`** (`typeIds`, `studentIds`) → array plus a trailing `{}`; only that meta
element came back in the probed section (no manual alerts there), so the row shape is **from the plugin code, not
observed**: `id`, `u_aet_customalerts_typesid`, `studentsdcid`, `expired`, `inactive`.

**Live sync, 2026-10-17** (`scripts/parity-ps-alerts.js`, dev database copy): 9 active courses, 9 read, 0 failed;
96 students stored, 39 with at least one kept alert (accommodation_plan 8, allergies 27, epipen 2,
learning_support_2 2, no_photo 3, support_summary 13). One active Prism student was on no PowerSchool roster read
(a roster difference, not a read failure). **2026-10-18, with the family alerts added** (same 96 students, 8.2 s):
correspondence_both 84, correspondence_g1 7, correspondence_g2 5 (exactly one each: 84 + 7 + 5 = 96), divorced 3,
siblings 69, employee_child 0; the other counts unchanged.

**Still open:** the alert *detail* (what the accommodation is, the extra-time amount) lives in the SPP and Student
Support Summary popups (`aet_customalert_custompopup.html?url=mbapop_spp.html` / `mbapop_studentsupportsummary.html`),
HTML, not shape-probed: a follow-up to #117.

**Alert pop-ups, probed 2026-10-18 (#163, read only, one student each, values masked; each read approved by Graham).**
Probe: `scripts/probe-ps-alert-popups.js` (`catalogue`, `pick`, `popup`).
- **How the plugin builds the link** (`api.makeAlert` in the plugin code from `/ws/pagecustomizations/insertions`):
  with a `stub_url`, `href = /teachers/alerts/aet_customalert_custompopup.html?url={stub_url}&frn=001{dcid}&id={alertId}`;
  without one, `/teachers/alerts/{aet_customalert | aet_customalert_sf | aet_customalert_adv}.html?mba_frn=001{dcid}&id=…`
  by `trigger_type` (`man` / `sf` / `adv`). An `sf` alert then appends `frn`, `mba_frn`, `student_field`
  (`{ext_table_name}.{FIELD}`) and `tableName`; an `adv` alert appends its `querystring` and, when the plugin has them,
  `sectionid`, `studentid`, `frn`. The link has class `dialogC`: PowerSchool opens it as a dialog from the attendance page.
- **Catalogue entries** (`getAlertTypes.json`): `10593860` "Accomodation Plan", `sf`, `stub_url` `mbapop_spp.html`,
  `student_field` `U_Students_Extension.X_SPP`, `ext_table_name` `U_DEF_EXT_STUDENTS`; `11290981` "Student Support
  Summary", `adv`, `stub_url` `mbapop_studentsupportsummary.html`, `trigger_url` `studentsupportsummary.html`, empty
  `querystring`.
- **The read:** after the attendance LTI launch over plain HTTP, a GET of the link with `Referer:
  /integrations/attendance/index.html` and `X-Requested-With: XMLHttpRequest` (as the dialog sends) answered **200
  `text/html`**, no security violation, for both.
- **SPP pop-up** (`url=mbapop_spp.html`, one student with `x_spp` = `1`): **77 bytes**, a single empty
  `<p style="margin-left:10px">`. Blank plan text or not readable this way: not told apart (one student only).
- **Student Support Summary pop-up** (`url=mbapop_studentsupportsummary.html&frn=001{dcid}&id=11290981&studentid={studentid}`,
  the one matching student in the section): **959 bytes**, a two-column table, headers **Category | Description**, 9 rows
  in this order: Academic Support, SEL/Behavioral Support, Case Manager, Accommodation Plan, TLI, Intervention Plan,
  ILP, Support Plan URL, Support Notes. Description lengths in this student's table: 1, 6, 1, 3, 3, 1, 1, 10, 89
  characters; only **Support Notes** held a number with `%` or a time word (the probe's "measure-like" test), so the
  extra-time amount is most likely free text in Support Notes (not confirmed: values were not read).
- **`pick`** (roster + `stuFieldValues` `x_spp` + `getAdvTriggerMatches`): `stuFieldValues` rows have keys `id`,
  `dcid`, `x_spp`. Section of 6: 1 with `x_spp` = `1`, 1 Support Summary match.

### Endpoint-discovery crawl (2026-05-30): attendance-app surface + #66 resolution

A read-only LTI-launch capture + grep of the attendance app's Angular bundle
(`/scripts/sgy-att-scripts/main.*.js`, ~923 KB) surfaced the **full client-side endpoint
surface of the Schoology→PowerSchool "attendance" LTI app**. Scope caveat: this is the
*attendance integration's* surface only — a lower bound on PowerSchool's `/ws/`, not all of it.

**Launch mechanism note:** the LTI run URL (`GET /apps/lti/4980125287/run/course/{sgySectionId}`)
returns an auto-submitting form whose `action` is `https://powerschool.hkis.edu.hk/ltigw/launch`
(`target=_self`). *(2026-10-17, #117: a plain-HTTP GET of the run URL returned a form whose `action` was
`https://powerschool.hkis.edu.hk/integrations/attendance/index.html`, and POSTing its fields there started the
session without a browser; see "Student alerts over plain HTTP (#117)".)* Under Playwright the inline auto-submit does **not** fire on `page.goto`; you
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
- `/ws/pt/v1/student/...` — student data (PT v1; PII — probe carefully). *(Probed 2026-10-17, #116: `GET /ws/pt/v1/student/{psmStudentId}`
  → `{ student: { id, firstName, lastName, gender, photoURL, gradeLevel } }`; also `GET /ws/pt/v1/section/{psmSectionId}/students_integration`.
  See "Student grade level, gender and postal address (#116)".)*
- `/ws/pt/v1/seating_chart/config/integration`, `/ws/pt/v1/seatingchart/objects/layout_integration/...`
- `/ws/seatingchart/config`, `/ws/seatingchart/objects/layout/...`, `/ws/seatingchart/section/attendance`, `/ws/seatingchart/section/multi_section_attendance`, `/ws/seatingchart/section/section_info`
- `GET /ws/preferences/core/user/pref/{prefName}` — per-user preference read
- `GET /ws/session/last-hit`, `POST /ws/session/terminate-session` — session keep-alive / logout

The `/ws/pt/v1/...` ("PowerTeacher v1") namespace is new here and is the modern read/write
attendance API — likely a cleaner attendance source than the legacy `/ws/attendance/...` calls,
pending shape probes.

#### #66 resolution — "G1/G2 Correspondence" alerts are NOT per-guardian identities

*(Superseded in part 2026-10-21: the per-guardian names and emails are on the Emergency Contact List, and `X_HomeEmail` is a one-character code. See "Guardian contacts (#66, verified 2026-10-21)" below. The 2026-05-30 findings are kept below.)*

Verified via **GET-only** `aet_customalert_sf.html` reads (no POSTs): the three correspondence
alerts — `G1 Correspondence` (32012479), `G2 Correspondence` (32012481), `G1&G2 Correspondence`
(32012482) — **all reference the same single student-extension field, `X_HomeEmail`** (per the
documented catalog above). They do **not** resolve distinct per-guardian identities; the
G1/G2/G1&G2 distinction is encoded in each alert's trigger match against that one field's value,
not via separate guardian records. Live reads of `U_DEF_EXT_STUDENTS.X_HomeEmail` (dcid 44467,
2-guardian; dcid 38590 Claire Tse, G2 deceased) both returned 200 with a single, **heterogeneous,
PII-bearing** value per student — so exact value decoding was left for a careful PII-safe pass. *(Decoded 2026-10-21: a one-character code, `1`, `2` or `3`.)*

**Takeaway for Prism:** the genuinely *per-guardian* flags are the **paired** fields already in
the catalog — `X_DNC_G1`/`X_DNC_G2` (do-not-contact) and `X_G1DECEASED`/`X_G2DECEASED` — not the
Correspondence alerts. Distinct per-guardian *contact details* (names/emails) are not exposed by
these alerts; they live in PowerSchool's guardian/contact tables (see Frontier). *(Found 2026-10-21: the Emergency Contact List; see "Guardian contacts (#66)" below.)*

### Student grade level, gender and postal address (#116, verified 2026-10-17)

Read only, values masked: the probe printed status codes, key paths, value types, lengths and counts, never a value,
a name or an id. Probe: `scripts/probe-ps-student-fields.js <schoologySectionId> [bundle|roster|student|demo|schema|page] [n]`
(every request a GET except the LTI launch POST). Session: the plain-HTTP attendance LTI launch of #117
(`PowerSchoolWeb.launch`, "Student alerts over plain HTTP (#117)" step 1). Sections probed: two active 2026-27 sections
(18 and 9 students); per-student reads on 3 students in each, 6 in all.

**Verdicts**

| Field | Verdict | Where (key path) | Coverage seen |
|---|---|---|---|
| Grade level | **Available, plain HTTP, no date** | `GET /ws/pt/v1/section/{psmSectionId}/students_integration` → `$["student-list"].students[].gradeLevel` (string, 2 chars); `GET /ws/pt/v1/student/{psmStudentId}` → `$.student.gradeLevel` (number) | 27/27 on the section lists; 6/6 by student; equal to the Demographics screen's Grade Level for 6/6 |
| Gender | **Available, plain HTTP** | the same two reads: `…students[].gender`, `$.student.gender` (string, 1 char; 2 distinct values in each section) | 27/27 on the section lists; 6/6 by student; equal to the Demographics screen's Gender for 6/6 |
| Postal address | **Available, but only on an HTML screen** (no JSON source found) | PowerTeacher student **Demographics** screen, `GET /teachers/studentpages/demo.html?frn=001{dcid}&sectionid={sectionDcid}`: rows **Address** and **Mailing Address**, each a 2-line cell (`<td>line<BR>line</td>`) | both rows set for 6/6 |

**Not found on these surfaces (scope of the negatives):**
- `/ws/pt/v1/student/{id}` and `students_integration` carry exactly `id, firstName, lastName, gender, photoURL,
  gradeLevel`: **no address**, no date of birth.
- `GET /ws/schema/query/api`, `GET /ws/schema/table/students[/{dcid}]?projection=…` and
  `GET /ws/v1/student/{dcid}?expansions=addresses,…` all answer **401** `"You do not have permission on the resource"`
  on the teacher session (the OAuth plugin surface; unchanged). **Named PowerQueries were not run**: they are POSTs
  (`POST /ws/schema/query/{name}`), outside this probe's GET-only rule, and no student/address query name was found in
  the attendance app (its only `/ws/schema/query/` literals are `com.pearson.core.schools.grade_levels` and
  `com.powerschool.core.health.get_student_health_plans_for_alert`).
- The class **Emergency Contact List** (`/teachers/StudEmgContacts.html?sectionid={sectionDcid}`, linked from
  PowerTeacher home) has columns Student, Guardian 1/2, G1/G2 Phone, Email, Faculty: no address.

**How the routes were found (not guessed).** The attendance app's bundle (`/scripts/sgy-att-scripts/main.*.js`) defines
`getStudent(t)` → `GET /ws/pt/v1/student/{t}?_={unix}` (defined, never called in the bundle) and `getPsmStudents` →
`GET /ws/pt/v1/section/{psmSectionId}/students_integration?_={unix}` (the seating chart's roster; the app keys
`psmStudents` by `.id` and reads `gradeLevel` and `photoURL`). `psmSectionId` is a field of `section_info`.

**Ids.** The PT `id` is a **PSM student id** (a string of length 7 or 8 in the list, a number in `/student/`): it equals
neither the roster `studentid` nor the `dcid` (0 of 27). The join is through `photoURL`, `/teachers/stpnormal/{studentid}ph.jpeg`:
its number is the PowerSchool `studentid` for 27/27, and `getStudentsInSection.json` (GET works as well as POST) maps
`studentid` → `studentdcid` → Prism `school_uid = "1_" + dcid`. A `/ws/pt/v1/student/` read needs the PSM id; it was not
tried with a dcid or a studentid, since the PSM id answered.

**The Demographics screen (address).** It sits in PowerTeacher's student frameset (home → class "Student Info" =
`summary.html?sectionid={sectionDcid}&frn=003{sectionDcid}` → frame `menu.html?…` → per student
`studentpages/home.html?ac=laststudpage&sectionid={sectionDcid}&frn=001{dcid}` → screen picker → `demo.html`). The
screen picker lists 20 screens (Demographics, Quick Lookup, Schedule, Meeting Attendance, Term Grades, Student Photo, …) plus Student Support and Student Forms.
⚠️ **Order matters, and a wrong order is logged.** A first GET of `studentpages/home.html` with no Referer answered
**403** (empty); with the menu as Referer but no summary/menu loaded in that session it answered 200 with PowerSchool's
**"Security Violation Logged: Attempted to run an unauthorized action"** page. Loading `home.html` → `summary.html` →
`menu.html` first, each sent with the previous page as Referer, worked for 6/6 students (the probe follows that path and
stops at once on a violation page). `ac=laststudpage` returns the screen last viewed, so after the first student it
returns Demographics itself. The Demographics rows seen (labels only): Name (Last, First MI), Address, Home Phone, Age, DOB, Ethnicity,
Father's / Mother's Name, Employer, Home Phone, Day Phone, Gender, Grade Level, Graduation Year, Guardianship,
Guardian Email, Home Room, Locker Number / Combination, Mailing Address, Student ID, Student number, State Student
Number, PowerSchool Learning. HTML, not JSON: a feature would parse `<tr><td><strong>{label}</strong></td><td>{value}</td></tr>` rows.

**Leads, not done:** `students_integration` is a **date-free** grade-level source (one call per section, no in-session
date range), which could replace the `section_attendance` range in `server/lib/psGradeLevel.js`; Graduation Year is also on
the Demographics screen. Building any feature on these fields is a new issue (#116 is the probe only).
*(Done 2026-10-18 for grade level, #164: see "Grade level from the section student list (#164)" below.)*

### Grade level from the section student list (#164, verified 2026-10-18)

Prism's grade-level read is now the section student list, over plain HTTP on the attendance LTI session
(`PowerSchoolWeb`, no browser); the `section_attendance` range read ("Step 3" above) is kept as the fallback.
Code: `server/services/psGradeLevelRead.js`, helpers in `server/lib/psGradeLevel.js`. Parity probe (read only, counts
and timings only): `scripts/parity-ps-grade-level.js`.

Per section, three GETs, each with `Accept: application/json` alone for the `/ws/` reads:
1. `GET /ws/attendance/section_info?sectionDcid={dcid}&multiSections=false&startDate={today}&endDate={today}` → `[0].psmSectionId`
   (the block sync already holds this answer and passes it in).
2. `GET /ws/pt/v1/section/{psmSectionId}/students_integration` → `$["student-list"].students[]` (`gradeLevel` a 2-character
   string; parsed to an integer).
3. `GET /teachers/mba_alerts/queries/getStudentsInSection.json?sectionIds={dcid}` → `studentid` → `studentdcid`, joined to the
   list through `photoURL` (`/teachers/stpnormal/{studentid}ph.jpeg`), then `school_uid = "1_" + dcid`.

Fallback, per section, when the list read fails, the section has no `psmSectionId`, or the list joins no student:
`GET /ws/attendance/section_attendance` over ~15 in-session days (as before; over plain HTTP since #164, GET with
`Accept: application/json`, answered JSON).

**Parity, 2026-10-18 (9 active 2026-27 sections, both reads over plain HTTP, the same session):** 110 student rows (96
distinct students) from each read; 110 match, **0 mismatches**, 0 only on the list, 0 only in `section_attendance`; the list
joined 110 of 110 rows (0 unjoined, 0 without a grade); all 110 are Prism students; the `grad_year` Prism had stored
agreed with the list for 110 of 110. Every section came from the list in the sync (0 fallbacks, 0 failures).

**Timing (same machine, same DB copy):** per-read sums over the 9 sections: list + roster 653 ms, `section_attendance`
632 ms, `section_info` 1111 ms; the plain-HTTP launch 504 ms. Whole block + grade pass (`syncPsAttendance`): before 9.8,
8.6, 7.4 s; after 8.5, 8.3, 8.3 s. The grade pass itself is now 1.7 s (its own HTTP launch plus 9 x 2 reads); the old read
ran inside the browser loop on the browser's session and measured about 0.6 s over plain HTTP, so no wall-time gain: the gain is no in-session date range and no browser for this read.
*(2026-10-18, #141: the block loop is now plain HTTP too and the grade pass runs on its PowerSchool session, so the
second launch is gone: the grade pass took 480 ms for 9 sections, all from the list; whole pass 4.9-5.0 s. See "Block
number", "Plain HTTP, no browser".)*

Gender is in the same list (`…students[].gender`); Prism stores nothing from it (#164).

### Guardian contacts (#66, verified 2026-10-21)

Which Prism parent is PowerSchool's Guardian 1 or Guardian 2, and what PowerSchool says about each. Read only, over plain
HTTP on the attendance LTI session, no browser. Every value was masked: the probe printed headers, lengths and counts, never
a name, email or phone number. Probe: `scripts/probe-ps-guardian-contacts.js`. Data: the 9 active sections, 110 roster rows
and 219 Prism parents (Prism's parents read from prod's database, opened read only).

- **Contact fields** (`stuFieldValues.json`, already read by the alert sync above): `x_dnc_g1`, `x_dnc_g2`, `x_g1deceased`
  and `x_g2deceased` were null for all 110 rows. `x_homeemail` is a one-character code on all 110: `3` for 97, `1` for 7 and
  `2` for 6. The alert catalogue confirms the codes: G1 Correspondence is `in 1`, G2 Correspondence is `in 2`, G1 and G2
  Correspondence is `in 3`.
- **Catalogue rules** (`getAlertTypes.json`): Do Not Contact Guardian 1 / 2 (10672509 / 10672510) are `notblank`; Deceased
  Guardian 1 / 2 (10593864 / 10733416) are `in 1`. Their pop-ups are `mbapop_dnc1.html`, `mbapop_dnc2.html` and
  `mbapop_deceasedg2.html` (Deceased Guardian 1 has none). Every current student has these fields blank, so those pop-ups
  were left unread.
- **The Emergency Contact List is the slot map.** `GET /teachers/StudEmgContacts.html?sectionid={sectionDcid}`, reached the
  way a teacher clicks to it: `GET /teachers/home.html` first, then the list with home as the Referer. It answered 200 for 9
  of 9 sections, with no security violation. Each page holds one HTML table, with the header
  `Student | Guardian 1 | G1 Email | G1 Phone | G1 Faculty | Guardian 2 | G2 Email | G2 Phone | G2 Faculty`, one row per
  student, one email per email cell. Every name, email and faculty cell was set on all 110 rows; G1 Phone on 108 and G2 Phone on 107 (corrected 2026-10-21: the first count covered one section only). A phone cell holds one number: of 220 cells, 208 are 8 digits, 7 have another format (10 to 14 digits, one with a space, one with a hyphen) and 5 are empty. Guardian names have the shape `Last, First`. All 110
  rows joined to the section roster by the `Student` cell equal to the roster's `lastfirst`.
- **Matching Prism parents to slots** (219 parents):
  - by email to exactly one slot: 188; for each of these, first name plus surname named the same slot when it named any (178
    agree, **0 disagree**);
  - the same email in both slots: 3 parents (3 students), each placed by first name plus surname;
  - a Prism email that is in neither slot: 19 parents, of whom 18 were placed by first name plus surname;
  - no Prism email: 9 parents, all placed by first name plus surname;
  - placed by surname alone, or not at all: **1 parent**, who would show as "not matched".

  Surnames are shared between the two slots for 31 of 110 students, so surname alone is not enough.
- **The correspondence pop-up** (`mbapop_emailcorr.html`, opened from the attendance page the way #163's Support Summary
  read is): one table `Guardian | Email | Phone`, with one row for code 1 or 2 and two rows for code 3; 9 of 9 had no other
  text. It lists the correspondence guardians without their slot. The code and the Emergency Contact List hold the same
  answer with one read per section instead of one per student, so Prism leaves the pop-up unread. The free-text note the
  issue quoted in May was not on any of the 9.
- **No notes name a contact guardian.** The Divorced pop-ups (3 students) hold a single line of 41 to 49 characters; none of
  19 Student Support Summaries has a contact word (G1, G2, both, contact, correspondence, custody, mother, father, email) in
  any row.
- **Phones and which email is which (#173, probe 2026-10-21, 27 students).** The phone columns are G1 Phone and G2 Phone, one
  number per cell (counts above). Each guardian has one address: every address on the correspondence pop-up equals that
  guardian's address on the Emergency Contact List. The correspondence code (`x_homeemail`) chooses a guardian, not an
  address: 1 or 2 names one guardian, 3 names both. Where a Prism parent's email differs from PowerSchool's (19 of 219
  parents), it is the email on that parent's Schoology account, which appears on no PowerSchool list.

How Prism uses this: the alert sync reads the list once per section on its session (`server/lib/psEmergencyContacts.js`),
stores the slots with their email and phone, and decides each parent's status when a page requests it
(`server/lib/guardianContacts.js`). Since 2026-10-21 (#173) a parent placed in a slot of their own shows that slot's email and
phone; the Schoology email is the fallback. A live check on a database copy, counts only:
`DB_PATH=<copy> node scripts/parity-ps-guardians.js`.

### Student home / postal address (#68 — wanted feature; feasibility, live probe pending)

*(Superseded 2026-10-17 by "Student grade level, gender and postal address (#116)" above: the address is on the
PowerTeacher Demographics screen, HTML only; `/ws/pt/v1/student/` has no address. #68 was merged into #116 and closed.
The 2026-05-30 analysis is kept below.)*

The user wants student **home / postal address** surfaced in Prism. Where it lives (2026-05-30 analysis; no live read yet — tracked in **#68**):

- **Schoology cannot provide it.** `GET /v1/users/{uid}` exposes email / parents / names / photo / role but **no postal address** — Schoology is not the demographics system of record.
- **PowerSchool is the source** (SIS — standard `students` street/city/state/zip). Reachable surface **unconfirmed**: the clean OAuth `GET /ws/v1/student/{id}?expansions=addresses` is blocked (needs admin `client_id`/`secret` — see "What's Needed to Get Access"); the near-term lead is the session-auth **`/ws/pt/v1/student/...`** namespace (or a `/ws/schema/query` named query), riding the mastery-sync browser session. The `/ws/pt/v1/student/...` literal is already listed under "Referenced in the app bundle but NOT exercised on load" above (PT v1; PII — probe carefully). Join is deterministic: `students.school_uid == "1_" + dcid`.
- **Safeguarding-tier PII** — addresses for minors are highly sensitive. Probe PII-safe (masked / shape only; never commit a real address) and gate behind a feature flag + human implementation, exactly like the do-not-contact / deceased-guardian flags (#65). The clean long-term fix waits on PowerSchool OAuth `/ws/v1/` credentials.

### Relevance to other issues

- **#68 (student home/postal address):** Schoology has none; PowerSchool is the source — see "Student home / postal address" above (session-auth `/ws/pt/v1/student` lead, safeguarding-tier PII, live probe pending). *(Probed 2026-10-17 in #116, which
  #68 was merged into: the address is on the PowerTeacher Demographics screen (HTML), not in `/ws/pt/v1/student`.)*
- **#39 (attendance marking):** `section_info` + `section_attendance` are the attendance endpoints that issue
  asks to probe; `section_attendance` is read here, and the same surface (`pss-integration-attendance-picker`)
  is what writes attendance codes. The "no page on non-timetabled dates" behavior #39 notes = the in-session-date
  requirement above.
- **#42 (parent-contact flags):** `includeStudentAlerts=true` returns `studentAlerts`, and the app's alert
  links expose siblings, MAP scores, Student Support Summary, and Accommodation Plan (SPP) popups — but the
  "do not contact this parent" flag is more likely a Schoology field; not yet confirmed here. *(Superseded 2026-10-17:
  the flag is PowerSchool's `X_DNC_G1`/`X_DNC_G2`, read through `sf` (see the safeguarding fields above); #42 was
  closed as a duplicate of #66.)*

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
