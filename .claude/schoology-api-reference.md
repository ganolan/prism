# Schoology API Reference

Complete reference for Schoology API behavior discovered during Prism development. Includes verified endpoints, known quirks, and standards-based grading (SBG) findings.

## Authentication

- **OAuth 1.0a** two-legged auth with PLAINTEXT signature via `oauth-1.0a` package
- Token is empty (`{ key: '', secret: '' }`) for two-legged flow
- All requests go to `https://api.schoology.com/v1/...` — never the school domain (`schoology.hkis.edu.hk`), which redirects to Microsoft SSO
- Three-legged OAuth request tokens CAN be obtained (`GET /v1/oauth/request_token` returns 200), but the authorize step is blocked by HKIS's Microsoft SSO redirect — may require Schoology admin intervention
- Current API user: UID `114956593`, role `263181` (Staff), school ID `94044023` (HKIS)

## API Quirks

- **`/users/me` redirects** (303) to `/users/{uid}`. Must follow redirects manually with fresh OAuth headers per hop — reusing the same nonce/signature on the redirected URL fails.
- **Per-assignment grade endpoint is 403**: `GET /sections/{id}/assignments/{aid}/grades` returns 403. Use the section-level `GET /sections/{id}/grades` instead, which returns all assignment grades including the target.
- **Grade `comment` field**: Present on grade objects from the section-level grades endpoint. `comment_status: 1` means visible to student; `null` means no comment. Cannot be written via `PUT /sections/{id}/assignments/{aid}/grades/{uid}` (returns 405). **CAN be written via bulk `PUT /sections/{id}/grades`** — wrap in `{ "grades": { "grade": [{ assignment_id, enrollment_id, grade, comment, comment_status: 1 }] } }`. Returns 207 with per-entry `response_code: 204`. Works for single or multiple students.
- **Two comment systems**: (1) Submission comments: `POST /sections/{id}/submissions/{aid}/{uid}/comments` — per-student dropbox comments. (2) Assignment comments: `POST /sections/{id}/assignments/{aid}/comments` — discussion-thread style.
- **Comment POST body must be flat**: Use `{ "comment": "text" }`, NOT `{ "comment": { "comment": "text" } }`. The nested form causes PHP to cast the inner object to the string `"Array"`, resulting in a blank comment.
- **Enrollments**: `GET /sections/{id}/enrollments` returns all members. Filter by `admin !== 1` to get students only.
- **User profiles**: `GET /users/{uid}` returns full profile including `primary_email`, `name_first_preferred`, and `parents.parent[]` array with parent/guardian names and emails. Enrollment records only have basic name info — must fetch full profile separately per student for contact details.
- **Misleading 200 responses**: Many endpoints return 200 but just echo back the parent object (section or assignment) instead of the requested sub-resource. This is a significant trap — always check that the response contains the expected data structure, not just a 200 status.

## Verified Endpoints

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/users/me` | 200 (via redirect) | Follow 303 manually |
| GET | `/v1/users/{uid}` | 200 | Full profile: email, parents[], preferred name |
| GET | `/v1/users/{uid}/sections` | 200 | Lists all sections |
| GET | `/v1/sections/{id}/assignments` | 200 | Paginated (`?start=&limit=`) |
| GET | `/v1/sections/{id}/grades` | 200 | All grades, includes `comment` field |
| GET | `/v1/sections/{id}/enrollments` | 200 | Members with UIDs |
| GET | `/v1/sections/{id}/grading_scales` | 200 | All grading scales with levels |
| GET | `/v1/sections/{id}/grading_categories` | 200 | Formative/summative categories |
| GET | `/v1/sections/{id}/grading_periods` | 200 | Period dates and titles |
| GET | `/v1/sections/{id}/mastery` | 200 | Per-enrollment structure — **but grades arrays always empty** |
| GET | `/v1/sections/{id}/grade_items` | 200 | Same as assignments, with `links.self` |
| GET | `/v1/sections/{id}/submissions/{aid}/{uid}/comments` | 200 | Per-student submission comments |
| POST | `/v1/sections/{id}/submissions/{aid}/{uid}/comments` | 201 | Post submission comment |
| POST | `/v1/sections/{id}/assignments/{aid}/comments` | 201 | Post assignment comment |
| PUT | `/v1/sections/{id}/grades` | 207 | Bulk grade+comment update; per-entry 204 |
| GET | `/v1/roles` | 200 | All roles in the school |
| GET | `/v1/schools` | 200 | School info |
| GET | `/v1/app-user-info` | 200 | Returns `api_uid` and session info |

## Blocked / Non-Working Endpoints

| Method | Endpoint | Status | Notes |
|--------|----------|--------|-------|
| GET | `/v1/sections/{id}/grading_rubrics` | **403** | **Critical** — documented endpoint that should return rubric criteria + ratings. Blocked with two-legged OAuth. Likely requires admin API app or three-legged auth. |
| GET | `/v1/courses/{id}/grading_rubrics` | **403** | Same block at course level |
| GET | `/v1/users/{uid}/grading_rubrics` | 400 | Bad request at user level |
| GET | `/v1/sections/{id}/assignments/{aid}/grades` | 403 | Use section-level instead |
| PUT | `/v1/sections/{id}/assignments/{aid}/grades` | 405 | Use section-level bulk PUT |
| PUT | `/v1/sections/{id}/assignments/{aid}/grades/{uid}` | 405 | Use section-level bulk PUT |
| GET | `/v1/sections/{id}/assignments/{aid}/grades/rubric` | 403 | Blocked |
| GET | `/v1/grading_scales` | 404 | Must use section-level |
| GET | `/v1/standards` | 404 | Not available globally |
| GET | `/v1/districts` | 404 | Not available |

## Misleading Endpoints (200 but wrong data)

These return 200 but just echo back the parent section or assignment object — they do NOT return the sub-resource implied by the URL:

- `GET /v1/sections/{id}/rubrics` → returns section info
- `GET /v1/sections/{id}/standards` → returns section info
- `GET /v1/sections/{id}/outcomes` → returns section info
- `GET /v1/sections/{id}/learning_objectives` → returns section info
- `GET /v1/sections/{id}/alignments` → returns section info
- `GET /v1/sections/{id}/assignments/{aid}/rubric` → returns assignment info
- `GET /v1/sections/{id}/assignments/{aid}/standards` → returns assignment info
- `GET /v1/sections/{id}/assignments/{aid}/learning_objectives` → returns assignment info
- `GET /v1/sections/{id}/assignments/{aid}/criteria` → returns assignment info
- `GET /v1/sections/{id}/assignments/{aid}/alignments` → returns assignment info
- `GET /v1/sections/{id}/grading_groups` → returns empty `[]`

Grade sub-endpoints (`/grades/{eid}/rubric`, `/grades/{eid}/standards`, etc.) also just return the normal grade list — they ignore the trailing path segment.

## Standards-Based Grading (SBG) Findings

### How HKIS Uses Standards-Based Grading

- Standards (called **Measurement Topics** in the UI) are defined in **PowerSchool** and provisioned to Schoology via the District Mastery sync
- Each summative assignment is aligned to a subset of measurement topics from a course-level pool
- Teachers rate students on each topic using the **General Academic Scale** (5 levels)
- Schoology computes a single averaged grade per assignment and stores it as the `grade` field
- The per-topic ratings are visible in Schoology's web UI (rubric popup, mastery gradebook) but **not accessible via the REST API**
- Measurement topics are grouped into **Reporting Categories** (buckets) in Schoology's mastery gradebook

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
grade% = (sum of topic ratings) / (numTopics × 4) × 100
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

### PowerSchool ↔ Schoology Integration

- Standards (learning objectives) are provisioned from PowerSchool SIS to Schoology's District Mastery library
- Sync is manual — admin must trigger it from the PowerSchool app in Schoology
- Grade passback sends assignment grades and aligned standards scores from Schoology back to PowerSchool
- The hierarchical structure supports parent/child standards at any level
