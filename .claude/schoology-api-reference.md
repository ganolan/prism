# Schoology API Reference

Complete reference for Schoology API behavior discovered during Prism development. Includes verified endpoints, known quirks, and standards-based grading (SBG) findings.

Last full discovery scan: 2026-04-05 (110 endpoints tested, 48 working)
Last live re-verification: 2026-05-30 — spot-checked the public REST inventory (44/51 probed endpoints OK, same 403/404/400 set as documented) and the internal `district_mastery` endpoints end-to-end (aligned-objectives, material-observations/search, alignments/search, outcomes/objectives rollup, iapi2 materials all 200) against a fresh browser session. No drift from this doc except the `building_id` constant fix below.

**For Claude:** Comprehensive API testing has been completed. Before implementing any new API integration, check `scripts/api-discovery-results.json` for the full machine-readable results (endpoint status, response shapes, error codes). Discovery scripts in `scripts/` (`test-api-discovery.js`, `test-api-deepdive.js`) can be re-run to probe additional endpoints or verify behavior — they are well-commented and self-contained. This file captures the key findings; the JSON has the raw detail.

## Authentication

- **OAuth 1.0a** two-legged auth with PLAINTEXT signature via `oauth-1.0a` package
- Token is empty (`{ key: '', secret: '' }`) for two-legged flow
- All requests go to `https://api.schoology.com/v1/...` — never the school domain (`schoology.hkis.edu.hk`), which redirects to Microsoft SSO
- Three-legged OAuth request tokens CAN be obtained (`GET /v1/oauth/request_token` returns 200), but the authorize step is blocked by HKIS's Microsoft SSO redirect — may require Schoology admin intervention
- Current API user: UID `114956593`, role `263181` (Staff), school ID `94044023` (HKIS)
- Rate limit: ~50 requests/minute for OAuth 1.0a apps

## API Quirks

- **`/users/me` redirects** (303) to `/users/{uid}`. Must follow redirects manually with fresh OAuth headers per hop — reusing the same nonce/signature on the redirected URL fails.
- **Per-assignment grade endpoint is 403**: `GET /sections/{id}/assignments/{aid}/grades` returns 403. Use the section-level `GET /sections/{id}/grades` instead, which returns all assignment grades including the target.
- **Grade `comment` field**: Present on grade objects from the section-level grades endpoint. `comment_status: 1` means visible to student; `null` means no comment. Cannot be written via `PUT /sections/{id}/assignments/{aid}/grades/{uid}` (returns 405). **CAN be written via bulk `PUT /sections/{id}/grades`** — wrap in `{ "grades": { "grade": [{ assignment_id, enrollment_id, grade, comment, comment_status: 1 }] } }`. Returns 207 with per-entry `response_code: 204`. Works for single or multiple students.
- **`comment_status` is the per-student "Display to student" flag.** Same field name, two surfaces:
  - **Public OAuth API** (`PUT /sections/{id}/grades`): integer — `1` = visible, `null` = hidden. What Prism uses for its comment-write path.
  - **Internal gradebook UI** (`PUT /iapi/grades/grader_grade_data/{sectionId}/{?}` — verified via DevTools probe 2026-05-07): boolean — `true` = visible, `false` = hidden. Payload shape: `{ "grades": { "<enrollment_id>": { "<assignment_id>": { grade, exception, comment, comment_status, flags, updateSequence } } }, "sequence": <int> }`. The `sequence` is a per-tab incrementing counter (start at 1). The toggle in Schoology's gradebook comment popup writes via this endpoint; only `comment_status` (and `sequence`) change between OFF and ON.
  - Both surfaces hit the same underlying record. No separate field controls mastery-observation visibility — toggling `comment_status` on the grade record is what teachers use to publish/unpublish a student's feedback in the Schoology UI. Use the public API form when writing from Prism.
- **`PUT /sections/{id}/grades` is destructive — replaces the whole grade record** ⚠️: Each entry in the bulk PUT *replaces* the grade record for that (enrollment, assignment), it does not patch it. Fields you omit get cleared. Two specific traps that bit us in issue #46:
  - **Omitting `grade` wipes the score.** For rubric-aligned assignments, the wiped score also takes the underlying *mastery observations* with it on Schoology's side — so a comment-only PUT silently nukes a teacher's rubric work. Always echo the existing `grade` (e.g. read it from `grades.score` first) even when you only want to update the comment.
  - **Omitting `comment_status` unticks "Display to student".** The default appears to be hidden, so any comment write that doesn't explicitly set `comment_status: 1` will hide the comment from the student — even if a previous write had set it to visible. Always include `comment_status` (and pass through the user's intended visibility — see future "display to student" toggle work).
  - General rule: when writing comments via this endpoint, **read the current grade row first and echo every field you don't intend to change** (`grade`, `comment_status`, and `exception` at minimum). Treat this as a full-record replace, not a patch.
  - **Read the echo-back fields fresh from Schoology, not from your local cache.** If the same user action wrote rubric observations moments earlier (or the student is new and has no synced grade row yet), the local DB is stale and echoing a stale/null `grade` re-triggers the wipe. `GET /sections/{id}/grades` immediately before the PUT is the safe baseline.
- **Two comment systems**: (1) Submission comments: `POST /sections/{id}/submissions/{aid}/{uid}/comments` — per-student dropbox comments. (2) Assignment comments: `POST /sections/{id}/assignments/{aid}/comments` — discussion-thread style.
- **Comment POST body must be flat**: Use `{ "comment": "text" }`, NOT `{ "comment": { "comment": "text" } }`. The nested form causes PHP to cast the inner object to the string `"Array"`, resulting in a blank comment.
- **Enrollments**: `GET /sections/{id}/enrollments` returns all members. Filter by `admin !== 1` to get students only.
- **User profiles**: `GET /users/{uid}` returns full profile including `primary_email`, `name_first_preferred`, and `parents.parent[]` array with parent/guardian names and emails. Enrollment records only have basic name info — must fetch full profile separately per student for contact details.
- **Misleading 200 responses**: Many endpoints return 200 but just echo back the parent object (section or assignment) instead of the requested sub-resource. This is a significant trap — always check that the response contains the expected data structure, not just a 200 status.
- **Pagination**: List endpoints use `?start=N&limit=N` parameters. Response includes `links.next` URL when more pages exist. Default limit is 20.
- **Attendance is gone**: The attendance API endpoints return HTTP 410 (Gone) — these have been deprecated/removed from Schoology's API.

## Verified Endpoints — Full Inventory

### User Endpoints

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/users/me` | 200 (via redirect) | Follow 303 manually. Returns full profile. |
| GET | `/v1/users/{uid}` | 200 | Full profile: `uid`, `name_first`, `name_first_preferred`, `name_last`, `name_display`, `primary_email`, `role_id`, `school_id`, `building_id`, `picture_url`, `gender`, `position`, `grad_year`, `tz_offset`, `tz_name`, `parents`, `child_uids`, `permissions`, `language`. **Note:** `grad_year` is only present on teacher/staff profiles (and typically empty). Student profiles do NOT include `grad_year` — that data must come from PowerSchool. Student profiles also lack `position`, `password`, `username`. |
| GET | `/v1/users/{uid}/sections` | 200 | Array of section objects with `course_title`, `section_title`, `course_id`, `id`. |
| GET | `/v1/users/{uid}/grades` | 200 | Grade overview per section. Empty for teacher accounts. |
| GET | `/v1/users/{uid}/updates` | 200 | Feed/update posts for the user. |
| GET | `/v1/users/{uid}/events` | 200 | Calendar events across all sections and schools. Paginated, includes assignment due dates and school events. Fields: `id`, `title`, `description`, `start`, `end`, `all_day`, `type` (event/assignment), `assignment_id`, `realm`, `section_id`/`school_id`. |
| GET | `/v1/users/{uid}/groups` | 200 | Groups the user belongs to. |
| GET | `/v1/users?uids=...` | 200 | Multi-get. Note: returns paginated list of ALL users (ignores uids param?). `total: 1914`. |
| GET | `/v1/app-user-info` | 200 | Returns `api_uid` and `web_session_timestamp`. |

### Section Endpoints — Core

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/sections/{id}` | 200 | Full section detail: `id`, `course_title`, `course_code`, `course_id`, `school_id`, `building_id`, `section_title`, `section_code`, `section_school_code`, `active`, `grading_periods[]`, `profile_url`, `meeting_days`, `weight`, `options` (grading visibility, permissions), `admin`. |
| GET | `/v1/sections/{id}/enrollments` | 200 | All enrolled users. Fields: `id` (enrollment_id), `uid`, `school_uid`, `name_first`, `name_first_preferred`, `name_last`, `name_display`, `admin` (1=teacher/TA, 0=student), `status`, `picture_url`, `enrollment_source`. Paginated. |

### Section Endpoints — Content & Materials

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/sections/{id}/updates` | 200 | Section feed posts. Fields: `id`, `body` (HTML), `uid` (author), `created` (timestamp), `last_updated`, `likes`, `num_comments`, `realm`, `section_id`. |
| GET | `/v1/sections/{id}/documents` | 200 | Course materials/resources. Fields: `id`, `title`, `course_fid` (folder ID), `available`, `published`, `display_weight`, `grade_item_id`, `attachments` (with nested `links.link[]` containing `url`, `title`, `type`). Paginated. |
| GET | `/v1/sections/{id}/discussions` | 200 | Discussion threads. Fields: `id`, `uid`, `title`, `body`, `weight`, `graded`, `grading_scale`, `max_points`, `comments_closed`. |
| GET | `/v1/sections/{id}/pages` | 200 | Course pages. Fields: `id`, `title`, `body` (full HTML), `published`, `created`, `folder_id`, `display_weight`, `num_assignees`. |
| GET | `/v1/sections/{id}/folders` | 200 | Folder/topic structure. Fields: `id`, `title`, `body`, `available`, `type` ("folder"), `color` (blue/red/etc), `display_weight`, `parent_id` ("0" for root), `has_rules`, `status`. Reveals the full course organization hierarchy. |
| GET | `/v1/sections/{id}/events` | 200 | Calendar events including assignment due dates. Fields: `id`, `title`, `start` (datetime), `end`, `has_end`, `all_day`, `type` (assignment/event), `assignment_type`, `assignment_id`, `web_url`. |

### Section Endpoints — Grades & Assessments

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/sections/{id}/assignments` | 200 | All assignments. Paginated. Fields: `id`, `title`, `description`, `due`, `grading_scale`, `grading_period`, `grading_category`, `max_points`, `factor`, `is_final`, `show_comments`, `allow_dropbox`, `allow_discussion`, `published`, `type`, `grade_item_id`, `available`, `dropbox_locked`, `grading_scale_type`, `show_rubric`, `folder_id`, `assignment_type` (lti_submission, etc), `web_url`, `count_in_grade`, `auto_publish_grades`, `num_assignees`, `assignees[]`, `last_updated`. |
| GET | `/v1/sections/{id}/assignments/{aid}` | 200 | Single assignment detail. Same fields as above. |
| GET | `/v1/sections/{id}/grades` | 200 | All grades in section. Structure: `{ grades: { grade: [...] }, period: [...], final_grade: [...] }`. Grade fields: `enrollment_id`, `assignment_id`, `grade` (numeric %), `exception`, `max_points`, `is_final`, `timestamp`, `comment`, `comment_status`, `override`, `type`, `scale_id`, `scale_type`, `assignment_type`, `web_url`, `category_id`, `school_uid`. Final grade fields: `enrollment_id`, `period[]` with `period_id`, `grade`, `comment`, `comment_status`, `scale_id`. |
| GET | `/v1/sections/{id}/grade_items` | 200 | Same as assignments, with `links.self`. |
| GET | `/v1/sections/{id}/grading_scales` | 200 | All grading scales with levels. |
| GET | `/v1/sections/{id}/grading_categories` | 200 | Formative/summative categories. |
| GET | `/v1/sections/{id}/grading_periods` | 200 | Period dates and titles. |
| GET | `/v1/sections/{id}/grading_groups` | 200 | Grading groups. Returns `{ grading_groups: [], count: 0 }` — typically empty. |
| GET | `/v1/sections/{id}/mastery` | 200 | Per-enrollment mastery structure: `{ period: [...], final_grade: [{ enrollment_id, period: [{ period_id, grades: [] }] }] }`. **Grades arrays always empty** — per-topic mastery data not accessible via API. |
| GET | `/v1/sections/{id}/completion` | 200 | Student completion tracking. Fields per student: `uid`, `school_uid`, `total_rules`, `completed_rules`, `percent_complete`, `completed`. |
| GET | `/v1/sections/{id}/completion/user/{uid}` | 200 | Per-student completion. Same fields as above. |
| PUT | `/v1/sections/{id}/grades` | 207 | Bulk grade+comment update; per-entry 204. |

### Section Endpoints — Submissions & Comments

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/sections/{id}/submissions/{aid}/{uid}` | 200 | Submission revisions. Returns `{ revision: [{ revision_id, uid, created, num_items, late, draft }] }`. `late: 0/1`, `draft: 0/1`. |
| GET | `/v1/sections/{id}/submissions/{aid}/{uid}/comments` | 200 | Per-student submission comments. |
| POST | `/v1/sections/{id}/submissions/{aid}/{uid}/comments` | 201 | Post submission comment. Body: `{ "comment": "text" }`. |
| GET | `/v1/sections/{id}/assignments/{aid}/comments` | 200 | Assignment-level discussion comments. |
| POST | `/v1/sections/{id}/assignments/{aid}/comments` | 201 | Post assignment comment. |

**⚠️ `lti_submission` (OneDrive / Google Drive) submission-status ambiguity.** For LTI dropbox
assignments the revision array does not reliably reflect post-submit state. A `draft=1` revision means
"opened, work in progress, not submitted", but an **empty `revision` array means *either* "never
opened" *or* "submitted"** — Schoology's public API does not expose post-submit revisions for
OneDrive/GDrive. `server/services/schoology.js` `getSubmissionStatus` disambiguates by grade-row
presence, which leaves one case unresolved: **submitted + ungraded is indistinguishable from
never-opened**. Same gap undercuts #49's resubmission auto-detect for LTI assignments — there is no
visible post-submit revision to baseline against (`isResubmitted` / `latestRevisionAt`).

**RESOLVED (2026-05-30 probe): the internal gradebook bootstrap `GET /iapi/grades/grader_header_data/{sectionId}`
exposes submission state per (student, assignment).** ⚠️ Keying corrected 2026-05-31 (live re-probe, section
7899896088): the cell map is **`body.grades[{uid}][{gradeItemId}]`** — the outer key is the **schoology user uid**
(matches `enrollment.uid`; an earlier revision wrongly said "enrollmentId"), and the inner key is the **grade-item id,
which equals the public REST `assignment.id` *and* `grade_item_id`** (verified 30/30 against both sets), so it joins
straight to `assignments.schoology_assignment_id` — no extra join column needed. Each cell carries an optional
**`submission`** key: a non-null `submission` means a submission exists (**submitted** — present even for OneDrive/GDrive
LTI, where the public revisions API is blind); a bare cell (`{uid, grade_item_nid}` only) means **not submitted / never
opened**; a non-null `grade` means graded; `not_assigned` = individually not assigned (#54); `exception` =
excused/missing/etc. Full verified cell key union: `{uid, grade_item_nid, grade?, submission?, exception?, comment?,
not_assigned?, has_assessment?}`. Verified across 3 LTI-heavy sections that *submitted-but-ungraded* LTI cells genuinely
occur (`submission` present, no `grade` — e.g. one APCSP LTI item had 18/28 cells in exactly that state; `hasGradeNull`
was 0 everywhere, so "ungraded" = `grade` simply absent). `grade_item_data` carries `is_lti_assignment` + `option_dropbox`
to isolate the dropbox/OneDrive items. **The `submission` value is a short enum naming the submission *type*** — decoded
2026-05-30 as `"drop"` (file dropbox: OneDrive / GDrive / upload) and `"assessment"` (Schoology assessment) — **not a
timestamp**, so its *presence* (not its value) is the submitted signal. Note `submission` and `grade` are independent: a
cell can carry a `grade` with **no** `submission` (manually-entered / non-dropbox grades — 41 / 40 / 2 such cells across
the 3 sections). The home reminders drill-down does **not** help here: it is per-assignment-with-counts only (no
per-student rows — see "Three high-priority surfaces" #3). **One `grader_header_data` fetch per section is the clean fix
for the submitted-vs-never-opened display** (#62), and a bulk pre-filter to skip the expensive per-(assignment,student)
submission-status calls for never-submitted cells (#55). ⚠️ It does **not** solve resubmission *timing*: `submission` has
no timestamp, so #49/#53's OneDrive resubmission detection still needs a time-bearing source (the public revisions API
hides post-submit OneDrive revisions; the uncaptured per-cell grade-data POST is the remaining lead).

### Course Endpoints

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/courses/{id}/sections` | 200 | All sections for a course. Returns section objects with full detail. |

### School Endpoints

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/schools` | 200 | School list. Returns `{ school: [{ id, title, address1, city, country, website, phone, building_code, picture_url }] }`. |
| GET | `/v1/schools/{id}/events` | 200 | School-level calendar events. |
| GET | `/v1/roles` | 200 | All roles: Parent (263109), Staff (263181), Student (263107), System Admin (263103), Teacher (263105), Counselor (293908), School Admin (279440), Student TA (896373). Each has `faculty` flag. |

### Group Endpoints

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/groups` | 200 | All school groups. Paginated. Total: 507. Fields: `id`, `title`, `description`, `category`, `privacy_level`, `school_id`, `building_id`, `options` (member_post, create_discussion, invite_type). |
| GET | `/v1/users/{uid}/groups` | 200 | Groups the user belongs to. |
| GET | `/v1/groups/{id}/updates` | 200 | Group feed posts. Same structure as section updates. |
| GET | `/v1/groups/{id}/events` | 200 | Group calendar events. |
| GET | `/v1/groups/{id}/discussions` | 200 | Group discussion threads. Fields: `id`, `uid`, `title`, `body`, `weight`, `graded`, `comments_closed`. |
| GET | `/v1/groups/{id}/documents` | 200 | Group shared documents. |

### Messaging Endpoints

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/messages/inbox` | 200 | Inbox messages. Paginated. Fields: `id`, `subject`, `recipient_ids`, `last_updated`, `author_id`, `message_status` (read/unread), `message` (null in list, need individual fetch). Also returns `unread_count`. |
| GET | `/v1/messages/sent` | 200 | Sent messages. Same structure. |

## Blocked / Non-Working Endpoints

### Forbidden (403) — Requires Higher Permissions

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/v1/sections/{id}/grading_rubrics` | **Critical** — documented endpoint for rubric criteria + ratings. Blocked with two-legged OAuth. Same block across all tested sections. |
| GET | `/v1/courses/{id}/grading_rubrics` | Same block at course level. Returns course object (misleading 200). |
| GET | `/v1/sections/{id}/assignments/{aid}/grades` | Use section-level `/grades` instead. |
| GET | `/v1/courses` | Global course catalog. Requires admin. |
| GET | `/v1/courses?building_id=...` | Same. |
| GET | `/v1/courses/{id}/events` | Course-level events blocked. Use section-level instead. |
| GET | `/v1/schools/{id}/buildings` | Building list blocked. |
| GET | `/v1/schools/{id}/enrollments` | School-wide enrollment blocked. |
| GET | `/v1/search?keywords=...` | Global search blocked. |
| GET | `/v1/attendance` | Global attendance blocked. |

### Deprecated / Gone (410)

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/v1/sections/{id}/attendance` | **410 Gone** — endpoint removed from API. |
| GET | `/v1/sections/{id}/attendance/summary` | **410 Gone** — same. |

### Not Found (404)

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/v1/districts` | Not available. |
| GET | `/v1/standards` | Not available globally. Must use section-level. |
| GET | `/v1/grading_scales` | Must use section-level. |
| GET | `/v1/grading_periods` | Must use section-level. |
| GET | `/v1/analytics` | Not available. |
| GET | `/v1/analytics/users` | Not available. |
| GET | `/v1/realms` | Not available. |
| GET | `/v1/resources` | Not available. |
| GET | `/v1/likes` | Not available. |
| GET | `/v1/blogs` | Not available. |

### Bad Request (400)

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/v1/users/{uid}/blogs` | Endpoint exists but not accessible. |
| GET | `/v1/users/{uid}/notifications` | Same. |
| GET | `/v1/users/{uid}/requests` | Same. |
| GET | `/v1/users/{uid}/activity` | Same. |
| GET | `/v1/users/{uid}/grading_rubrics` | Same. |

### Not Allowed (405)

| Method | Endpoint | Notes |
|--------|----------|-------|
| PUT | `/v1/sections/{id}/assignments/{aid}/grades` | Use section-level bulk PUT. |
| PUT | `/v1/sections/{id}/assignments/{aid}/grades/{uid}` | Use section-level bulk PUT. |
| GET | `/v1/messages` | Must use `/messages/inbox` or `/messages/sent`. |
| GET | `/v1/multiget` | Multiget requires POST with request body. |

## Misleading Endpoints (200 but wrong data)

These return HTTP 200 but echo back the parent object (section, course, school, or group) instead of the requested sub-resource:

### Section Sub-Resources (return section object)

- `GET /v1/sections/{id}/info`
- `GET /v1/sections/{id}/links`
- `GET /v1/sections/{id}/media-albums`
- `GET /v1/sections/{id}/members` — use `/enrollments` instead
- `GET /v1/sections/{id}/final_grades` — final grades ARE available nested inside `/grades` response
- `GET /v1/sections/{id}/rules`
- `GET /v1/sections/{id}/standards`
- `GET /v1/sections/{id}/outcomes`
- `GET /v1/sections/{id}/learning_objectives`
- `GET /v1/sections/{id}/alignments`
- `GET /v1/sections/{id}/rubrics`

### Assignment Sub-Resources (return assignment object)

- `GET /v1/sections/{id}/assignments/{aid}/rubric`
- `GET /v1/sections/{id}/assignments/{aid}/standards`
- `GET /v1/sections/{id}/assignments/{aid}/alignments`
- `GET /v1/sections/{id}/assignments/{aid}/learning_objectives`
- `GET /v1/sections/{id}/assignments/{aid}/criteria`

### Course Sub-Resources (return course object)

- `GET /v1/courses/{id}/grading_rubrics`
- `GET /v1/courses/{id}/grading_scales`
- `GET /v1/courses/{id}/grading_categories`
- `GET /v1/courses/{id}/standards`
- `GET /v1/courses/{id}/outcomes`
- `GET /v1/courses/{id}/learning_objectives`
- `GET /v1/courses/{id}/folders`

### School Sub-Resources (return school object)

- `GET /v1/schools/{id}/courses`
- `GET /v1/schools/{id}/sections`
- `GET /v1/schools/{id}/users`
- `GET /v1/schools/{id}/grading_periods`

### Group Sub-Resources (return group object)

- `GET /v1/groups/{id}/members` — no way to list group members
- `GET /v1/groups/{id}/folders`

Grade sub-endpoints (`/grades/{eid}/rubric`, `/grades/{eid}/standards`, etc.) also just return the normal grade list — they ignore the trailing path segment.

## Data We CAN Read (Summary for Prism)

With our current two-legged OAuth access, we can read:

| Data Type | Endpoint | Useful For |
|-----------|----------|------------|
| **Student roster** | `/sections/{id}/enrollments` | Student names, UIDs, photos |
| **Student profiles** | `/users/{uid}` | Email, parents, preferred name |
| **Assignments** | `/sections/{id}/assignments` | Assignment list, due dates, scales, categories, folder structure |
| **Grades** | `/sections/{id}/grades` | All grades + comments + final grades in one call |
| **Submissions** | `/sections/{id}/submissions/{aid}/{uid}` | Revision count, late/draft status |
| **Submission comments** | `/sections/{id}/submissions/{aid}/{uid}/comments` | Per-student feedback thread |
| **Grading config** | `/sections/{id}/grading_scales`, `/grading_categories`, `/grading_periods` | Scale levels, category names, period dates |
| **Course materials** | `/sections/{id}/documents`, `/pages`, `/discussions` | All course content with attachments |
| **Folder structure** | `/sections/{id}/folders` | Course organization hierarchy with colors |
| **Calendar** | `/sections/{id}/events`, `/users/{uid}/events` | Due dates, school events |
| **Section feed** | `/sections/{id}/updates` | Announcements and posts |
| **Completion** | `/sections/{id}/completion` | Student progress tracking |
| **Mastery (REST)** | `/sections/{id}/mastery` | Structure exists but grades arrays always empty |
| **Mastery rollups (internal)** | `POST /course/{id}/district_mastery/api/outcomes/objectives` | Schoology's own per-(student, objective) rollup — the level shown in the UI. Works for topics or categories. |
| **Messages** | `/messages/inbox`, `/messages/sent` | Schoology messaging |
| **Groups** | `/groups`, `/groups/{id}/updates`, `/discussions` | School groups and content |

## Data We CANNOT Read (via REST API)

| Data Type | Why | Workaround |
|-----------|-----|------------|
| **Rubric criteria & ratings** | `grading_rubrics` endpoint returns 403 | **SOLVED**: Use internal API (`/course/{id}/district_mastery/api/...`) via Playwright browser session |
| **Per-topic mastery ratings** | Mastery endpoint grades arrays always empty | **SOLVED**: Internal API `material-observations/search` returns per-student per-topic scores |
| **Attendance** | Endpoints return 410 (deprecated/removed) | None via API |
| **Global course catalog** | 403 — requires admin | Use `/users/{uid}/sections` for own courses |
| **School user directory** | Returns school object, not user list | Enumerate via section enrollments |
| **Search** | 403 | None via API |

## Internal API (Schoology School Domain)

Per-topic mastery data is accessible via Schoology's internal API on the school domain (`schoology.hkis.edu.hk`), authenticated via a live browser session (Playwright). These endpoints are used by Prism's mastery sync service.

### Confirmed Internal Endpoints

| Endpoint | What it returns |
|---|---|
| `GET /course/{id}/district_mastery/api/aligned-objectives?building_id=...&section_id=...` | Reporting categories + measurement topics (hierarchy, IDs, titles). `is_parent: true` → reporting category; children are measurement topics. |
| `GET /course/{id}/district_mastery/api/aligned-objectives/{objectiveId}/?building_id=...&section_id=...` | Single aligned objective detail. |
| `GET /course/{id}/district_mastery/api/objectives/search?ids={uuid1,uuid2,...}` | Multi-get objective details (topic or category) by UUID. |
| `GET /course/{id}/district_mastery/api/material-observations/search?building_id=...&objective_id=...&section_id=...` | Per-student per-assignment raw scores for a specific measurement topic. |
| `GET /course/{id}/district_mastery/api/material-observations/search?building_id=...&section_id=...&student_uids={uid}` | **All observations for one student across all topics** in a single call — far more efficient than per-topic looping when you only need one student's data. |
| `GET /course/{id}/district_mastery/api/observations/search?student_uids={uid}&section_id={id}&material_type=ASSIGNMENT&material_id={id}` | All topic scores for one student + one assignment. |
| `POST /course/{id}/district_mastery/api/alignments/search` | Objective → assignment alignment mappings. Body: `{ building_id, section_id, objective_ids: "uuid1,uuid2", include_gradeable_materials_only: true }`. **Requires CSRF headers** (same as `outcomes/objectives`). Authoritative alignment source; Prism syncs this into `mastery_alignments`. |
| `GET /course/{id}/district_mastery/api/student-alignments/search?building_id=...&section_id=...` | All active objective ↔ assignment alignments in the section. |
| `POST /course/{id}/district_mastery/api/outcomes/objectives` | **Schoology's rollup** per (student, objective) — the level displayed in the mastery gradebook UI. Works for both topic UUIDs (per-topic rollup) and category/parent UUIDs (per-reporting-category rollup). Includes teacher overrides in `outcome_override`. See below for body/response shape. |
| `GET /iapi2/district-mastery/course/{id}/grading-scales?grading_scale_ids={id}[,{id}...]` | Scale level definitions (levels, points, labels). |
| `GET /iapi2/district-mastery/course/{id}/materials?material_id_types[0]={id}|ASSIGNMENT...` | Assignment metadata (title, grading period/category) for a list of material IDs. |
| `GET /iapi2/district-mastery/course/{id}/materials?student_uid={uid}&materials=ASSIGNMENT:{id},ASSIGNMENT:{id},...` | Same but scoped to one student's materials. |
| `POST /iapi2/district-mastery/course/{id}/observations` | Write raw mastery scores back to Schoology (per assignment, per topic). |
| `POST /iapi2/district-mastery/metrics` | Client telemetry — **ignore**. |

### `outcomes/objectives` — per-student rollups (the UI's reported level)

**Request (POST):**
```json
{
  "building_id": 97989879,
  "section_id": 7899896088,
  "student_uids": "uid1,uid2,...",
  "ids": "objectiveUuid1,objectiveUuid2,..."
}
```

Pass **category UUIDs** (parent objectives) for per-reporting-category rollups, **topic UUIDs** (child objectives) for per-topic rollups, or mix both in one call.

**Response:**
```json
{
  "data": [{
    "objective_id": "uuid",
    "student_outcomes": [{
      "student_uid": 23814283,
      "outcome": {
        "grade_percentage": 95,
        "grade_scaled": "95.00",
        "grade_scaled_rounded": "87.50"
      },
      "outcome_override": null
    }],
    "material_outcomes": null
  }]
}
```

- `grade_scaled_rounded` is the level boundary: `87.50 → ED`, `62.50 → EX`, `37.50 → D`, `12.50 → EM`, `0.00 → IE`.
- `grade_percentage` is the raw averaged percent.
- `outcome_override` is populated when a teacher has manually overridden the rollup in the UI. Exact shape is **not yet confirmed** — observed values are all `null`; an override capture pass is required to document the structure and find the write-back endpoint.

### Writing mastery overrides

**Endpoint:** `POST /course/{sectionId}/district_mastery/api/nodes/{objectiveId}/outcome-override`

`objectiveId` can be either a reporting-category (parent) UUID or a measurement-topic (child) UUID. Requires the same CSRF pair as other district_mastery POSTs.

**Set body:**
```json
{
  "building_id": 97989879,
  "section_id": 7899896088,
  "grading_period_id": 0,
  "student_uid": 123693316,
  "grade_scaled": "87.50",
  "grading_scale_id": 21337256
}
```

`grade_scaled` must be one of `"0.00"`, `"12.50"`, `"37.50"`, `"62.50"`, `"87.50"` (IE/EM/D/EX/ED) — string, not number.

**Clear body:** same payload with `"grade_scaled": null`.

**Response:**
```json
{
  "data": {
    "objective_id": "...",
    "student_uid": 123693316,
    "outcome_override": {
      "grade_percentage": 87.5,
      "grade_scaled": "87.50",
      "grade_scaled_rounded": "87.50"
    }
  }
}
```

Prism exposes this as `POST /api/mastery/:courseId/override` (body `{ studentUid, objectiveId, gradeScaled }`) and `writeMasteryOverride()` in `server/services/masterySync.js`.

### Authentication

- Requires a live browser session — use `npm run mastery:login` to authenticate via Playwright
- Session is stored locally and reused across syncs until it expires
- No OAuth needed — uses the teacher's browser cookies
- **POSTs to `/course/{id}/district_mastery/api/...` require CSRF headers**: `X-CSRF-Token` and `X-CSRF-Key`, both read from `window.Drupal.settings.s_common.csrf_token` / `.csrf_key` after the page loads. Also add `X-Requested-With: XMLHttpRequest`. Without both headers the response is `403 {"data":null}`. GETs under `/district_mastery/api/` and calls to `/iapi2/district-mastery/...` do not require these headers.

### Key Constants

- `building_id`: `97989879` (HKIS HS building) — this is what the internal `district_mastery` endpoints expect (matches the body examples above). **Not** `94044023`, which is the *school_id* (`/schools` `id`, also `/users/me.school_id`). Earlier revisions of this doc listed the school_id here by mistake.
- `school_id`: `94044023` (HKIS)
- `gradingScaleId`: `21337256` (General Academic Scale — used for ALL mastery writes)
- Points mapping: ED=100, EX=75, D=50, EM=25, IE=0

## Internal Web Endpoints — general (browser-session, 2026-05-30 crawl)

A read-only crawl of the logged-in web UI (`scripts/crawl-schoology.mjs`, seeds
`/home /courses /grades /messages /calendar`, 40 pages) surfaced internal AJAX endpoints on
`schoology.hkis.edu.hk` beyond the `district_mastery`/`iapi2` set. All are browser-session-auth
(same Playwright session as mastery sync), GET, 200. **Scope:** the home/course/calendar/feed
surface only — not exhaustive, and a *lower bound* (see grep-js caveat below).

| Endpoint | Returns |
|---|---|
| `GET /iapi/course/active` | JSON `{response_code, body:{courses:{courses[],sections[]}, permissions:{is_verified, can_browse_courses, can_join_courses, can_create_courses, school_has_grading_periods}}}` — the user's active courses+sections + capability flags. The cleanest JSON of the new set. |
| `GET /home/upcoming_ajax`, `/home/upcoming_submissions_ajax`, `/home/overdue_submissions_ajax` | `{html:"…"}` rendered fragments — upcoming events / upcoming & overdue submissions (overdue empty when none). |
| `GET /home/course_reminders_ajax`, `/course/{id}/course_reminders_ajax` | `{html}` reminder fragments (home-wide / per-course). |
| `GET /home/feed`, `GET /user/{uid}/feed` | Recent-activity feed (Drupal AJAX-command JSON: `{output, js:{setting:{s_edge:{feed_url,…}}}}`). |
| `GET /course/{id}/calendar_ajax` | JSON course-calendar payload. |
| `GET /calendar/{uid}/{year}-{week}` | JSON calendar feed (e.g. `/calendar/114956593/2026-41`). |
| `GET /alignment/browse` | `{html, data:[]}` — standards/objective alignment browser (data empty without query params). |
| `GET /course/administrators_info` | `{data:[]}` — course administrators. |
| `GET /update_post/{id}/show_more/{hash}` | JSON — expands a truncated feed post. |
| `GET /enrollments/edit/invite/course/{id}` | JSON — enrollment-invite data. |
| `GET /iapi/enrollment/member_enrollments/course/{sectionId}` | `{response_code, body:{<enrollmentId>:{id, uid, type, status, realm, realm_id, school_uid, school_nid, created, name_first, name_last, name_first_preferred, use_preferred_first_name, name, picture_fid, picture, …}}}` — section roster keyed by enrollment id. Includes `school_uid` (the PowerSchool join key `1_{dcid}`) and preferred-name fields. Fired when a course page loads. **Verified 200** (ACSS, 10 members). |
| `GET /iapi/grades/grader_header_data/{sectionId}` | **Rich one-call gradebook bootstrap.** `{response_code, body:{ grade_item_nids[], uids[], grading_period, grading_periods[], grading_categories[], grading_groups[], grading_category_setting, user_data{<enrollmentId>:{enrollment_id, name, name_last_first, school_uid, picture, grades:{gp:{display,numeric,scaled}, overall:{display,numeric,scaled}, overall_override}}}, grade_item_data{<itemNid>:{id, title, category_title, scale_type, scale_title, max_points, grading_scale_id, grading_category_id, grading_period_id, use_district_mastery_grading, district_mastery_material_type, auto_publish_grades, …}}, grades{<uid>:{<gradeItemId = public assignment.id = grade_item_id>:{uid, grade_item_nid, grade?, submission?, exception?, comment?, not_assigned?, has_assessment?}}}, grading_scale{id, title, scale{0,12.5,37.5,62.5,87.5, averages{…}}, colors, description}, realm_settings, … }}` — per-student **overall + per-grading-period grade** (display/numeric/scaled), full assignment metadata incl. the district-mastery flags, and the grading-scale level map, in a single fetch. **Verified 200** (ACSS: 26 items × 10 students). **Per-cell submission state (verified 2026-05-30; keying re-verified 2026-05-31):** `body.grades` is keyed by **uid** (the schoology user id, = `enrollment.uid`), and each inner key is the **grade-item id, which equals the public `assignment.id`/`grade_item_id`** — join directly to `assignments.schoology_assignment_id`. A non-null **`submission`** key (a string enum, **`"drop"`** = file dropbox incl. OneDrive/GDrive, **`"assessment"`** = Schoology assessment) = student has submitted (present even for OneDrive/GDrive LTI, where the public revisions API is blind); a bare `{uid, grade_item_nid}` cell = not submitted / never opened; non-null `grade` = graded; `not_assigned`/`exception` as named. `grade_item_data` is keyed by the same grade-item id and carries `id`, `item_nid`, `is_lti_assignment`, `option_dropbox`, `link`, `title`, `status`, `has_assessment` — use these to isolate dropbox/OneDrive items. (`grader_header_data` returns only the current grading period — ~30 of 81 assignments in the probed section — so cells outside it fall back to the public revisions API.) Together these close the public API's submitted-vs-never-opened gap (see the `lti_submission` note under Submissions & Comments). |
| `GET /iapi/grades/all_rubrics/course/{sectionId}` | **Classic-rubric criteria + ratings — a workaround for the 403-blocked public `grading_rubrics`.** Verified shape (PII-free; rubric *definitions*): `{response_code, body:{<rubricId>:{id, created, created_by, title, total_points, realm, realm_id, is_tracked, rows:[{id, is_published, term_id, guid, title, description, columns:[{pts, description}], max_points, weight}], num_assigned_gi, num_printed_gi}}}` — `rows[]` = criteria, `rows[].columns[]` = rating levels (each just `{pts, description}` — the point value + the level's text; one APCSP rubric had 4 columns). **Verified:** APCSP (`7899896088`) → **27 rubrics, populated**; the SBG/district-mastery sections (ACSS/AIML/MAD/Robotics) return `body:[]` (empty) because they grade via measurement topics, not classic rubrics. ⚠️ Section-id in the **path** (`/course/{id}`); the bare `/all_rubrics/{id}` form 500s. See SBG section for why this matters. |

HTML app-shells also seen (data loaded via sub-XHRs, not isolated): `/grades/grades`,
`/gradebook` routes, `/home/course-dashboard`, `/home/recent-activity`, `/messages/view/{id}`,
`/resources`, `/course/{id}/materials`, `/courses/browse`, `/courses/mycourses/past`.

### Three high-priority surfaces (probed 2026-05-30; row structures parsed 2026-05-30 — PII-masked)

Probed read-only for a teacher-workflow build. Captures are **value-masked** (tag/class/href skeletons only; no
names/PII printed or persisted). ⚠️ keyword signals are only trustworthy on isolated `{html}` *fragments* — full
pages false-positive on nav chrome.

**1. User search (find people NOT in your sections) — WORKS TODAY; row structure confirmed, buildable.**
`GET /search/user?s={query}&page={n}` → **200 text/html**. **Page size = 10** results (`li.search-summary`) per page —
*not* 20 (the earlier "20" was wrong). Pagination: `page` absent (or `page=0`) = first 10; `page=1` = next 10;
out-of-range pages return **200 with 0 rows** (no error). Terminate when a page yields `< 10` rows. (Verified
2026-05-30: `s=liu` → 10 + 4 = 14 total then page 2/3 empty; `s=chan` → 10/10/10/10 across pages 0–3, i.e. ≥40.)
No JSON endpoint — parse the HTML. **Result-row structure (masked capture):**

```
li.search-summary > div.item.user-list-item
  a[href="/user/{id}"] > … img.imagecache-profile_sm[src]      ← profile photo (may be a default/missing)
  div.item-title  > a[href="/user/{id}"]                        ← display name (text) + user id (href)
  div.item-info   > span.item-type                              ← entity-type label — observed "Person" for ALL rows
                  > span.item-school > a[href="/{schoolId}"]    ← school name (text) + school id (href)
  div.network-button-links > a.action-message[href="/messages/new/{id}"]
```

Per result: user id from `.item-title a` href (`/user/(\d+)`), name from its text, school from `.item-school a`.
⚠️ `.item-type` is **not** the user's role — it is the generic entity type, and was **"Person" for every row** when
verified live (an earlier draft of this doc guessed "Parent/Student/Staff" from a masked length — wrong; "Person" is also
6 chars). The actual role (Parent/Student/Staff) is **not** in the search row — read it from the profile
(`GET /v1/users/{uid}.role_id`) per user. This is the only confirmed way to reach users outside your enrollments (public REST `/search` 403s;
`/users` multi-get ignores filters). Browser-session auth (same Playwright session as mastery sync), not OAuth. Each
`/user/{id}` then joins to the documented public profile read (`GET /v1/users/{uid}`, 200 via OAuth).

**2. Archived / past courses — HTML parse confirmed; NO clean JSON exists; archived sections ARE API-readable.**
`GET /courses/mycourses/past` → **200 text/html** (~338 KB). Verified structure: **45 `li.course-item.list-item`** rows
(`id="course-{courseId}"`, `.course-title`, `.course-code`) containing **49 `div.section-item`**
(`id="section-{sectionId}"` + view link `a[href="/course/{sectionId}"]`) — i.e. the archived inventory is
**~45 courses / 49 sections**. (The earlier "233 `/course/{id}` links" was the *raw* action-link count — each section
row carries ~5 admin links: edit / invite / members / link-existing / copy — not the course count.) **No JSON flag for
past courses:** `GET /iapi/course/active` returns the *same* 9 courses / 10 sections under every variant tried
(`?include_past=1`, `?past=1`, `?archived=1`, `?all=1`, `?show_past=1`) — so the active-courses JSON cannot be coaxed to
include past courses; parse the HTML. **Section-level reads work on archived sections** (verified 2026-05-30, public
OAuth): for 5 archived `{sectionId}` (all `active:0`), `GET /v1/sections/{id}`, `/assignments`, `/grades`,
`/enrollments` all returned 200 with real data (one section: 12 assignments / 192 grades / 17 enrollments; an empty
template section: 0 / 0 / 3). So once you scrape a past `{sectionId}`, all the normal Prism section reads apply (feeds #5).

**3. Reminders pane (ungraded + resubmissions) — headline COUNTS captured; per-item drill-down deferred.**
`GET /home/course_reminders_ajax` → **200 JSON `{html}`** (~598-byte fragment). Verified structure: two rows under
`div.reminders-content`:
- `div.ungraded-dropbox.reminder > span.reminder-link` — **ungraded work (#63)**; text is a headline count, observed
  `"233 ungraded assignment submissions"`.
- `div.ungraded-resubmissions.reminder > span.reminder-link` — **resubmissions (#49)**; observed `"29 re-submitted assignments"`.

Each `span.reminder-link` has `href="home/reminders_list/{grade-item|resubmission}?get_selector=grade-item,resubmission"`
(a click-to-open drill-in; `get_selector` is the static reminder-type list, **not** a per-row token). The reminder rows
themselves carry **no** `/assignment/{id}` or `/course/{id}` links — just the count + the drill path. **Drill-down shape
(verified 2026-05-30):** `GET home/reminders_list/grade-item?get_selector=grade-item,resubmission` (and `…/resubmission`)
returns **200 with a JSON-encoded HTML *string*** — a bare JSON string, not `{html}`/`{output}` (that's why an earlier
pass mis-read its length, 28,386 / 6,730 chars, as "entries": `Object.keys()` on the parsed string gave char indices).
Parsed, it is a **per-assignment list**: rows of `a.list-item-link[href="/assignment/{id}/info"]` →
`span.reminder-list-count` (the count) + `.reminder-list-title` + course title. **No per-student rows** (0 `/user/` links,
no data-student attrs) — so it yields assignment-level ungraded / resubmission counts (39 assignments ungraded, 9
resubmitted at probe time), **not** which students. For per-student submission status use `grader_header_data` (see the
`lti_submission` note under Submissions & Comments). Companions: `GET /home/overdue_submissions_ajax` (`{html}`, empty body when none),
`GET /home/upcoming_submissions_ajax` (`{html}`; `div.upcoming-event` rows with `a[href="/assignment/{id}"]` +
`.event-title`). **Net for the build:** `course_reminders_ajax` gives the two top-line counts and the drill-downs give
per-assignment counts (feeds #63 / #49 at the assignment level); **per-student** submission status comes from
`grader_header_data`'s per-cell `submission` key, not from these reminder fragments.

**React-bundle literal-grep (2026-05-30).** The crawler's `--grep-js` returns **0** because the
React bundles live on cross-origin `asset-cdn.schoology.com` (the crawler only fetches same-origin
JS). Fetching the bundles **directly** (public CDN, no auth) and grepping the `react-common/*` +
`common-*` + the `s_grades_*` Drupal-Angular bundles yielded **~60 route literals** — and the
`/iapi/...` / `/iapi2/...` ones are **mostly live**. Verified 200 from this grep: `/iapi/grades/all_rubrics/course/{id}`
(the rubric workaround above), `/iapi/grades/grader_header_data/{id}`, `/iapi/grades/grader_grade_data/{id}`,
`/iapi/enrollment/member_enrollments/course/{id}`, `/iapi/course/grading_groups/{id}`, `/iapi/course/active`.
Other notable literals not yet probed: `/iapi/grades/rubric/`, `/iapi/library/rubric/`,
`/iapi/grades/rubric_grade_info/{section}/{enrollment}` (500'd with a guessed enrollment id — needs the
right id/headers), `/iapi/grades/assessment_component_submission_rubric_grade_info/`, the
`/iapi2/common-assessments/*` family (common assessments / question banks), `/iapi2/learning-objectives`,
`/iapi2/auto-export-*` (SFTP grade exports). Bare-`.json` SDK literals (e.g. `manifest.json`) are framework
noise. **Net:** bundle grep here is a *strong* signal for `/iapi(2)/...` routes — pair it with a live
shape-probe per route (some need POST/CSRF or specific ids). This is how the rubric/gradebook endpoints
above were found.

Now characterized (2026-05-30): `grader_header_data.grades` per-cell shape carries
`grade`/`submission`/`exception`/`comment`/`not_assigned` (the gradebook per-cell state — a separate
grade-data POST may add further detail, but the core state incl. submission presence is here); and the
`home/reminders_list/{grade-item,resubmission}` drill-down is a JSON-string per-assignment count list.
Still open: the `/iapi/grades/rubric*` per-student rubric-score reads (need correct ids); the
`/iapi2/common-assessments/*` and `/iapi2/learning-objectives` families. (The `submission` value is now
decoded — a type enum `drop`/`assessment`, **not** a timestamp — so it gives submission *existence* but
no resubmission *timing*; OneDrive resubmission timing still needs another source, e.g. the uncaptured
per-cell grade-data POST — see #53.)

## Standards-Based Grading (SBG) Findings

### How HKIS Uses Standards-Based Grading

- Standards (called **Measurement Topics** in the UI) are defined in **PowerSchool** and provisioned to Schoology via the District Mastery sync
- Each summative assignment is aligned to a subset of measurement topics from a course-level pool
- Teachers rate students on each topic using the **General Academic Scale** (5 levels)
- Schoology computes a single averaged grade per assignment and stores it as the `grade` field
- Per-topic mastery ratings are accessible via the internal API (see above) and synced by Prism's mastery sync service
- Measurement topics are grouped into **Reporting Categories** (buckets) in Schoology's mastery gradebook

### Summative vs Formative Detection

**Rule**: An assignment is **summative** if its `grading_scale_id` is `21337256` (General Academic Scale). All other assignments are **formative**.

- Do NOT use `grading_category` title matching — category names vary by course and are unreliable
- The General Academic Scale is the ONLY scale used for summative mastery grading at HKIS
- Only summatives count towards overall student performance (mastery gradebook)
- Formatives still matter and should be displayed but are secondary to summative data

### Grading Scales

| Scale | ID | Levels | Use |
|-------|-----|--------|-----|
| General Academic | `21337256` | IE (0%), EM (12.5%), D (37.5%), EX (62.5%), ED (87.5%) | Summative assessments |
| General Academic (Unaligned) | `23495360` | Same levels | Formative assessments |
| Completion | `7165818` | Incomplete (0%), Completed (80%) | Completion-based tasks |
| Approaches to Learning | `25951428` | S (0%), I (40%), C (80%) | ATL skills |

Full scale level names: Insufficient Evidence (IE), Emerging (EM), Developing (D), Exhibiting (EX), Exhibiting Depth (ED).

### Grade Value Encoding

Each measurement topic maps to a 0-4 point scale: IE=0, EM=1, D=2, EX=3, ED=4.

The Schoology grade percentage is computed as:
```
grade% = (sum of topic ratings) / (numTopics * 4) * 100
```

This means the number of measurement topics per assignment can be reverse-engineered from the grade values:

| Grade % | 3 topics (max 12) | 4 topics (max 16) | 5 topics (max 20) |
|---------|-------------------|--------------------|--------------------|
| 66.67% | 8/12 | — | — |
| 68.75% | — | 11/16 | — |
| 75% | 9/12 | 12/16 | 15/20 |
| 83.33% | 10/12 | — | — |
| 87.5% | — | 14/16 | — |
| 91.67% | 11/12 | — | — |
| 93.75% | — | 15/16 | — |
| 95% | — | — | 19/20 |
| 100% | 12/12 | 16/16 | 20/20 |

Verified topic counts from live data:
- ACSS Design (S): **3 topics** (grades: 66.67, 83.33, 91.67, 100)
- ACSS Dev+Eval (S): **4 topics** (grades: 68.75, 87.5, 93.75, 100)
- ACSS Single Page (S): **4 topics** (grades: 93.75, 100)
- ACSS Client Design (S): **5 topics** (grades: 95, 100)
- AIML AI Content Creator (S): **5 topics** (grades: 70, 75, 80, 85, 90, 95, 100)

### Measurement Topics (from Schoology UI)

From a screenshot of the ACSS Design rubric popup, the measurement topics are adapted National Core Media Arts standards:
- "Generate and conceptualize artistic ideas and work" (Creating: Conceiving)
- "Organize and develop artistic ideas and work" (Creating: Developing)
- "Refine and complete artistic work" (Creating: Presenting/Producing)

Per-topic points in the UI: ED=100, EX=75, D=50(?), EM=25(?), IE=0 — averaged for total score.

### Assignment Fields Relevant to SBG

- `grading_scale` — ID of the scale used (21337256 = summative General Academic)
- `grading_category` — ID linking to a grading category (formative/summative)
- `category_id` — Same ID, appears in grade entries
- `scale_id` — Same as grading_scale, appears in grade entries
- `grading_scale_type` — appears on assignment objects (value: 1)
- `folder_id` — links assignment to a course folder (unit)
- `assignment_type` — typically "lti_submission"
- `count_in_grade` — whether assignment affects final grade
- `show_rubric` — boolean, typically false
- `auto_publish_grades` — whether grades auto-publish

### Grading Categories by Course

- AIML, AP CSP, ACSS, Robotics: "Evidence of Learning - Formative" + "Evidence of Learning - Summative"
- MAD: "Evidence of Learning" (single category)
- Master Art & Design: 12 categories (multiple formative + summative)

### Section IDs (2025-26)

| Section ID | Course |
|------------|--------|
| 7899896098 | Advanced Computer Science Studio |
| 7899907727 | AI & Machine Learning |
| 7899896088 | AP Computer Science Principles |
| 7899907701 | Mobile App Development |
| 7899907720 | Robotics |

### The `grading_rubrics` Endpoint (Documented but Blocked)

Per Schoology's developer docs at `developers.schoology.com/api-documentation/rest-api-v1/grading-rubrics/`:

**Expected response structure:**
```json
{
  "id": 123,
  "title": "Rubric Name",
  "total_points": 100,
  "realm": "section",
  "realm_id": 456,
  "criteria": [
    {
      "id": 1,
      "title": "Criterion Name",
      "description": "...",
      "max_points": 100,
      "weight": 1,
      "ratings": [
        { "points": 100, "description": "Exhibiting Depth" },
        { "points": 75, "description": "Exhibiting" }
      ]
    }
  ]
}
```

This is exactly the data we need but returns 403 with two-legged OAuth. The 403 likely indicates:
1. The API app needs elevated permissions (admin-level or district-level app)
2. Or three-legged OAuth is required (user authorizes the app to act on their behalf)
3. Or rubric access is restricted when standards are provisioned from an external SIS (PowerSchool)

### PowerSchool <-> Schoology Integration

- Standards (learning objectives) are provisioned from PowerSchool SIS to Schoology's District Mastery library
- Sync is manual — admin must trigger it from the PowerSchool app in Schoology
- Grade passback sends assignment grades and aligned standards scores from Schoology back to PowerSchool
- The hierarchical structure supports parent/child standards at any level

## Role IDs

| Role | ID | Faculty |
|------|-----|---------|
| Parent | 263109 | No |
| Staff | 263181 | Yes |
| Student | 263107 | No |
| System Admin | 263103 | Yes |
| Teacher | 263105 | Yes |
| Counselor | 293908 | Yes |
| School Admin | 279440 | Yes |
| Student TA | 896373 | No |
