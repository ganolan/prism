# PrisMCP: student history across courses and years (reference letters)

Status: **implemented on branch `worktree-bridge-cse_01YCitn5M2Sh7t5wxxyXKchp`, not deployed** (2026-10-08).
The teacher first asked for a spec only, then asked for the build in the same session. This
document is both the spec and the record of what was built. The open questions below are
decisions the build made with a default. Reverse any of them and the code follows.

## Decisions (teacher, 2026-10-08)

- **Deploy:** yes.
- **Backfill:** only 2023-24 and 2024-25 (the 12 CS sections). 2021-22 and 2022-23 are not needed.
- **Prod browser session:** refreshed by the teacher before the backfill.
- **Formative work:** off by default, available with `include_formative`. That is the current
  behaviour.
- **Course final grade comments (Q6):** not used, so dropped.
- **Timeliness summary (Q5): removed.** `get_student_history` carries no lateness,
  resubmission or referral data at all. Schoology's late flag stays where triage uses it.

## Open questions for the teacher (as first asked)

1. **Backfill the archived sections into prod?** Prism holds one 2024-25 section and none
   older, so the tools can't see most history yet (§1). Proposal: import the 12 CS sections
   from 2023-24 and 2024-25 through the existing **Import archived courses** path, which is
   enough for the current class of 2027. Also import 2021-22 and 2022-23 (17 more CS sections)?
   That only matters for letters for students who have already graduated.
2. **Prod's browser session.** On prod, `GET /api/courses/archived/discover` returns
   `no_session`, and per-topic mastery for an imported section needs that session. Re-run
   `npm run mastery:login` against prod's session dir before the backfill. Without it, imports
   bring in overall scores and comments but no per-topic levels.
3. **Formative and completion work are off by default.** `get_student_history` returns
   summatives only and counts what it left out (`omitted`, including how many of those have
   comments). Two real items show the trade-off: a completion-scale "Final Project - Design (S)"
   and a formative "Sprite Invaders" both carry comments. Keep the default?
4. **Teacher drafts.** Your own unpublished drafts (`assessment_drafts`) are opt-in
   (`include_teacher_drafts`) and labelled `teacher_draft_unpublished`. AI suggestions
   (`feedback`) are never returned, not even with a flag. Is that right?
5. **Timeliness.** `include_timeliness` is built but off. Schoology's `late` flag overstates
   lateness: it ignores extensions, and a resubmission re-stamps the work as late. One real
   2025-26 student has all 6 summatives flagged late. The response carries that caveat. Should it
   be removed from letters work altogether?
6. **Course final grades and comments.** `GET /v1/sections/{id}/grades` also returns a
   `final_grade[]` (period grade + comment) that Prism doesn't store. A teacher-written end-of-
   course comment would be strong letter material. Add it (needs a table and a sync change)?
7. **Deploy.** Pushing to `main` deploys prod. This branch also changes how *archived*
   enrolments sync (§6). Merge and push when you're happy.

## 1. Investigation (2026-10-08, prod DB read-only + read-only Schoology GETs)

### What the database holds

| School year | Sections in Prism | Notes |
|---|---|---|
| 2021-22, 2022-23, 2023-24 | **none** | Exist in Schoology's archive (§1.2) |
| 2024-25 | **1**: ACSS block 5 (course 102) | Earliest real data: due dates from 2024-09-03 |
| 2025-26 | 11 (AIML, AP CSP, ACSS, MGD S1, MAD S2, ROB S1+S2, TA, PCG, 2 Interim) | Archived, with scores, comments, mastery |
| 2026-27 | 9 current | |

Prism started syncing in spring 2026 (students created 2026-04-03). Archived courses exist only
where someone used **Import archived courses**. So the **earliest school year with real data
is 2024-25, and only one section from it**. Everything else archived is 2025-26.

What an imported archived course holds: enrolments, assignments, `grades` (score, max,
**verbatim `grade_comment`**, `comment_status`), `mastery_scores` (per-topic levels, when the
browser session was live at import) and `mastery_rollups` (end-of-course level per topic).

### Can older data be backfilled?

Yes, and nothing new needs building.

- **Inventory:** Schoology's archived-courses page (browser session) lists **58 sections**,
  back to `21-22`. 13 are imported. 29 of the rest are CS teaching sections: 2024-25 ×7,
  2023-24 ×5, 2022-23 ×8, summer 2022 ×2, 2021-22 ×7. The rest are TA, PCG, Interim and faculty.
- **Reads work on archived sections** with the normal OAuth key: `/sections/{id}`,
  `/enrollments`, `/assignments`, `/grades`. Verified again today on 2023-24 MAD and 2024-25 MGD:
  the comments come back verbatim.
- **There's no per-student shortcut.** `GET /users/{uid}/sections` returns only the student's
  current timetable, and `?include_past=1` is ignored. Backfill is section by section, which is
  what the import already does.
- **Cost:** about 6 to 10 REST calls per section (section, periods, enrolments, assignments,
  grades, profile multi-get), plus one headless mastery run when the session is live, which
  takes tens of seconds. The 12 sections for 2023-24 and 2024-25 take about 10 to 15 minutes
  unattended, and all 29 take under an hour. Submission detection is skipped for archived
  courses (#72), so no per-cell calls are made.
- **Blocking bug found and fixed (§6):** archived sections report every enrolment as status
  `"2"`. The post-#128 sync treated `"2"` as dropped, so a backfill would have marked every
  imported student as dropped. The June auto-archive would have done the same to this year's
  classes.
- **Unknown:** whether 2021-22 to 2023-24 sections have district-mastery observations. 2023-24
  MAD grades are points on the General Academic Scale, e.g. 11/12. The first import will show
  whether mastery comes back too.

### Student identity

- One `students` row per person, keyed by **`schoology_uid`**, which is stable across years.
  The same row joins every enrolment, so **a student is matched across years and courses
  reliably once each section is imported**. Name matching is never needed for joins.
- Names: `first_name`/`last_name` are **legal** names. `preferred_name` is Schoology's, and
  `preferred_name_teacher` is the teacher's override, which wins (`preferredFirstName`). 56 of
  212 students have a Schoology preferred name and 20 have a teacher override.
- `grad_year` is stored for 158 of 212 students, from the Schoology profile and PowerSchool
  grade level.
- **Email prefix vs class year:** of the 158 with a grad year, **152 match** the first two
  digits of the email (`270xxx` → 2027) and **6 are a year out** (e.g. `250883` → 2026,
  `280633` → 2029), presumably repeat or accelerated students. 54 students have no grad year.
  So the prefix is a **hint, not the grad year**. The tools return it as `email_cohort_hint`,
  next to `grad_year`.

### Why the student wasn't on the 2026-27 AIML roster (course 579)

Not a sync bug. Schoology shows the student's **current timetable has no AIML section at all**
(14 current sections, none of them the teacher's except PCG). They were in **AIML 2025-26,
block 8** (section `7899907727`, Prism course 4, archived), and the teacher's earlier sections
were **MAD 2023-24 S1 block 5** (`6803621354`) and **MGD 2024-25 S2 block 3** (`7361045352`),
neither imported. Whatever form says "enrolled in AIML" refers to last year.

## 2. Tools

All four are read-only SELECTs over the local SQLite DB. There are no new write paths and no
network calls (§5).

### 2.1 `find_student`

Input:

| field | type | default | |
|---|---|---|---|
| `query` | string \| number | required | name (legal or preferred, any order), email, 6-digit email number, `schoology_uid`, or Prism id |
| `include_archived` | boolean | `true` | `false` = only students with a current-course enrolment, and only those courses |
| `limit` | number | 20 | |

Matching: every word of a name query must hit a name field (legal first/last, Schoology
preferred, teacher preferred) or the email local part. A whole word ranks above a prefix, and a
prefix above a substring. Accents are ignored. A pure number matches the id, uid or email
number exactly.

Output (example, fictional student):

```json
{
  "query": "Molly Wong",
  "total": 1,
  "candidates": [{
    "id": 58,
    "schoology_uid": "100000001",
    "legal_first_name": "Mei Lin",
    "legal_last_name": "Wong",
    "preferred_first_name": "Molly",
    "display_name": "Molly Wong",
    "preferred_differs_from_legal": true,
    "email": "270555@hkis.edu.hk",
    "grad_year": 2027,
    "email_cohort_hint": 2027,
    "matched_on": ["preferred_name_teacher", "last_name"],
    "courses": [
      { "course_id": 120, "course_name": "MOBILE APP DEVELOPMENT", "section_name": "5(A-B)", "block_number": null,
        "school_year": "2023-24", "term": "Semester 1", "archived": true, "enrolment": "completed" },
      { "course_id": 4, "course_name": "AI & MACHINE LEARNING", "section_name": "8(A-B)", "block_number": "8",
        "school_year": "2025-26", "term": "Full year", "archived": true, "enrolment": "completed" }
    ]
  }],
  "note": "grad_year comes from the Schoology/PowerSchool profile. email_cohort_hint is read from the email prefix and is usually, not always, the class year: prefer grad_year."
}
```

`enrolment`: `current`, `dropped` (only knowable while a course is current), or `completed`
(archived). Template courses (`excluded`) never appear. When two students share a name, the
email, grad year and course years tell them apart. That case is tested.

### 2.2 `get_student_history`

Input:

| field | type | default | |
|---|---|---|---|
| `student` | string \| number | required | Prism id (from `find_student`), uid, email, or a name matching exactly one student. An ambiguous name is refused with the candidates listed (`AMBIGUOUS:`) |
| `course` | string \| number | all | Prism course id or part of the name |
| `school_year` | string | all | `"2024-25"` |
| `include_formative` | boolean | `false` | |
| `include_completion` | boolean | `false` | Completion-scale work (Completed / Incomplete) |
| `include_teacher_drafts` | boolean | `false` | Teacher's own unpublished drafts, labelled |
| `detail` | `full` \| `compact` | `full` | |
| `limit` / `offset` | number | 50 / 0 | Paging over assessments, max 200 |

Output (`full`, trimmed, fictional):

```json
{
  "student": { "id": 58, "legal_first_name": "Mei Lin", "legal_last_name": "Wong", "preferred_first_name": "Molly",
               "display_name": "Molly Wong", "preferred_differs_from_legal": true, "grad_year": 2027, "email_cohort_hint": 2027, "...": "..." },
  "filters": { "course": null, "school_year": null, "include_formative": false, "include_completion": false,
               "include_teacher_drafts": false, "detail": "full" },
  "courses": [{
    "course_id": 4, "course_name": "AI & MACHINE LEARNING", "section_name": "8(A-B)", "block_number": "8",
    "school_year": "2025-26", "term": "Full year", "archived": true, "enrolment": "completed",
    "assessments_total": 6,
    "proficiency": [
      { "external_id": "ART.5.1", "title": "Select, Analyze, and Interpret Artistic Work for Presentation", "level": "ED" },
      { "external_id": "ART.5.2", "title": "Develop and Refine Artistic Techniques and Work for Presentation", "level": "EX" }
    ],
    "assessments": [{
      "assignment_id": 43,
      "title": "AIML Project - Autonomous Driving Challenge - Part 2: Development (S)",
      "due_date": "2025-12-02",
      "kind": "summative",
      "status": "final",
      "overall": { "level": "EX", "score": 83.33, "max_score": 100, "scale": "General Academic Scale" },
      "topics": [
        { "external_id": "ART.5.1", "title": "Select, Analyze, and Interpret Artistic Work for Presentation", "level": "ED" },
        { "external_id": "ART.6.6", "title": "Apply Criteria to Evaluate Artistic Work", "level": "D" }
      ],
      "comment": "Update: Your determination ... An impressive effort overall.\n----------\nYour final video is missing ...",
      "labels": []
    }]
  }],
  "omitted": { "formative": 9, "completion": 8, "unassessed_teacher_drafts": 0, "omitted_with_comments": 2 },
  "page": { "offset": 0, "limit": 50, "returned": 6, "total": 6, "next_offset": null },
  "provenance": "Published finals synced from the Schoology gradebook. Comments are verbatim. AI suggestions are never included."
}
```

`compact` swaps each assessment for `{ title, due_date, kind, level, comment, labels? }`.

Rules:
- **Assessed** means a score, a non-blank comment, any topic level, or a Schoology exception.
  Assignments that were assigned but never assessed are left out. So are assignments deleted in
  Schoology (`removed_at`).
- **Kind:** `completion` if the scale's levels are only Completed/Incomplete; otherwise
  `summative`/`formative` from the grading-category title; otherwise the `(S)`/`(F)` title
  suffix; otherwise `unclassified`, which is kept by default.
- **Overall level:** `score / max_score` (points or percent) bucketed by the assignment's
  Schoology scale cutoffs. `See Mastery Gradebook (ED)` and `Exhibiting Depth` both become
  `ED`. Completion stays `Completed`.
- **Topic levels:** `mastery_scores.grade`, or the level for `points` when the grade is blank.
- **Course proficiency:** `mastery_rollups` per topic, with `override_value` winning, through
  `pointsToLevel`.
- **Order:** courses oldest first (school year, then term), assessments by due date.
- **Labels:** "assignment is unpublished in Schoology", "comment is hidden from the student",
  "Schoology exception code N", and "a Prism status line was removed from the comment; the rest
  is verbatim".

### 2.3 `list_courses { include_archived?: boolean }`

The default output is unchanged. With `include_archived: true` it adds archived courses (hidden
archived ones too, since hiding is a dashboard preference), each with `school_year`, `term` and
`archived`. Current courses come first, then archived courses newest first.

### 2.4 `list_students { course_id, include_dropped?: boolean }`

The roster now also includes `grad_year`. `include_dropped` appends leavers with `dropped_at`.
Archived course ids already worked here. They were just undiscoverable.

## 3. Payload size

Measured on prod for one 2025-26 AIML student: 6 summatives give **8.9 KB full, 5.4 KB
compact**, about 2.2k and 1.4k tokens. A four-course, four-year history of about 30 summatives
comes to roughly 45 KB full or 27 KB compact, which fits in one call. Paging (`limit`/`offset`,
`page.next_offset`) keeps every course listed on every page with its `assessments_total` and
`proficiency`, so the agent always sees the shape of the history. Filters (`course`,
`school_year`) cut it further.

## 4. Finals vs drafts, and text fidelity

- **Source of truth:** `grades` and `mastery_scores`, which are the Schoology gradebook as
  synced, so these are the teacher's published finals. `status: "final"`.
- **AI suggestions (`feedback`) are never read** by this service. Tests insert one and assert
  its text never appears, with and without `include_teacher_drafts`.
- **Teacher drafts:** opt-in and kept apart under `teacher_draft` with
  `status: "teacher_draft_unpublished"`. A draft-only assignment has `status: "not_assessed"`
  and `overall: null`.
- **Verbatim:** `grade_comment` is returned byte-for-byte: typos, double spaces, `\n`,
  `----------` separators of earlier comments, and trailing U+200B (all tested). The one thing
  ever removed is a status line Prism itself appended (`status_lines`), and then a label says
  so. The tool description tells the agent to quote comments as written and never correct them.

## 5. Privacy

- Every query is a `SELECT`. No new tables, no write paths, no Schoology or network calls. The
  tools read the local DB that PrisMCP already opens (absolute `DB_PATH`, stdio only).
- The tools return data to the local MCP client the teacher is running, the same trust boundary
  as `get_assignment_context` today.
- Test fixtures use fictional students and comments, not real ones.

## 6. Bug fix: archived enrolment status "2"

Schoology reports **every** enrolment in an archived section as `status: "2"`, verified on five
sections from 2021-22 to 2025-26. `isActiveEnrolment` whitelists `"1"` (#128), so
`finalizeArchivedCourse` (archived import, auto-archive in June, backfill) would mark every
student dropped. That hides them from rosters and also skips their profile enrichment on import.
Fix: `syncSectionData(..., { archivedSection: true })` (passed by `finalizeArchivedCourse`)
stores `droppedAtFor()`. In an archived section, `"2"` keeps the drop state Prism recorded while
the course was current, which is null for a fresh import. Elsewhere `"2"` is still an unknown
code, so the student lands visibly in the dropped list, as #128 intends. Tests:
`server/lib/enrolmentStatus.test.js`, `server/services/sync.test.js`.

## 7. Tests

- `server/lib/schoolYear.test.js`: every grading-period format in the archive, from 2021-22 to
  2026-27, plus templates and nulls.
- `server/services/studentHistory.test.js`, 20 tests. Fixture: fictional "Mei Lin Wong",
  preferred "Molly" (different legal and preferred name), with history in **MAD 2023-24 S1, MGD
  2024-25 S2 and AIML 2025-26** (three courses, three years), plus a dropped current course, a
  template course, two same-named "Ming Lee"s, an AI suggestion, a teacher draft, a status line,
  an unpublished assignment, a hidden comment and a deleted assignment. Covers search by every
  identifier, disambiguation, year ordering, defaults and `omitted`, verbatim comments, level
  derivation, labels, filters, compact mode, paging, and that no lateness data leaks.
- `mcp/server.test.js`: `find_student` → `get_student_history` end to end over the MCP
  transport, the ambiguous-name error, and `list_courses`/`list_students` with the new flags.
- Full suite: 97 files and 1430 tests passing.

## 8. Schema, indexes, migration

**No schema change.** School year and term are parsed from `courses.grading_period`
(`server/lib/schoolYear.js`). Every join is already indexed: `enrolments(student_id)`,
`grades(student_id)`, `mastery_scores(student_uid)`, `mastery_rollups(student_uid)`. The
student search scans `students` in JS, which is 212 rows today and stays cheap at thousands.

Migration plan: none for the DB. Rollout is (1) merge and push `main` to deploy, (2) refresh
prod's browser session, (3) import the chosen archived sections from the dashboard's **Import
archived courses**. That path now keeps their students enrolled.

## 9. Effort

| Piece | Estimate | Actual |
|---|---|---|
| Investigation + API probes | 0.5 day | done |
| `schoolYear` + `studentHistory` service + tests | 1 day | done |
| MCP wiring + flags + tests | 0.5 day | done |
| Archived status-2 fix + tests | 0.25 day | done |
| Backfill (unattended imports) | under 1 hour of run time | pending approval (Q1, Q2) |
| Course final comments (Q6) | about 1 day | dropped: not used |

## Follow-ups

- `parsePastCourses` reads `sectionTitle` from an admin link and gets `"Edit"` for 57 of 58
  rows. Use the REST `section_title` in the discovery list.
- `docs/prismcp-install-and-verify.md` lists the tool surface. Updated for the new tools.
