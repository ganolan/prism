# Schoology API Reference

Complete reference for Schoology API behavior discovered during Prism development. Includes verified endpoints, known quirks, and standards-based grading (SBG) findings.

Last full discovery scan: 2026-04-05 (110 endpoints tested, 48 working)

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
| **Mastery** | `/sections/{id}/mastery` | Structure exists but grades arrays always empty |
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
| `GET /course/{id}/district_mastery/api/aligned-objectives?building_id=...&section_id=...` | Reporting categories + measurement topics (hierarchy, IDs, titles) |
| `GET /course/{id}/district_mastery/api/material-observations/search?building_id=...&objective_id=...&section_id=...` | Per-student per-assignment scores for a specific measurement topic |
| `GET /course/{id}/district_mastery/api/observations/search?student_uids={uid}&section_id={id}&material_type=ASSIGNMENT&material_id={id}` | All topic scores for one student + assignment |
| `POST /iapi2/district-mastery/course/{id}/observations` | Write mastery scores back to Schoology |

### Authentication

- Requires a live browser session — use `npm run mastery:login` to authenticate via Playwright
- Session is stored locally and reused across syncs until it expires
- No OAuth needed — uses the teacher's browser cookies

### Key Constants

- `building_id`: `94044023` (HKIS)
- `gradingScaleId`: `21337256` (General Academic Scale — used for ALL mastery writes)
- Points mapping: ED=100, EX=75, D=50, EM=25, IE=0

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
