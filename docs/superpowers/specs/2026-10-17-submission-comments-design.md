# Submission comments in Prism

Status: approved mock 2026-10-17 (https://claude.ai/artifact/LQuNS52JnT2u2RcLbwXQHa). The requirements are
Graham's brief of 16-17 Oct 2026; this note records how they are built.

## Why

In MGD Flappy Bird (F) (section `8458134323`, assignment `8590105935`) four students typed their playtest and
evaluation answers in the comment box of their submission. A grading pass that read only files and text
submissions nearly marked those rubric rows as having no evidence. Prism shows these threads, lets Graham answer
them, and returns them to assessment-grader through `get_assignment_context`.

## Data source

Public REST API first (verified in `.claude/schoology-api-reference.md`, "Submission comment threads"):

- **Read:** `GET /v1/sections/{sec}/submissions/{aid}/{uid}/comments`, paged by `start`/`limit`.
- **Post text:** `POST` the same path, body `{"comment": text}` (flat).
- **Delete:** `DELETE …/comments/{id}`.
- **Post with a file:** the web form only (the API drops attachments). Prism sends the form's own requests over
  plain HTTP with the saved session's cookies (no browser), then confirms from the REST thread that the new
  comment's file has the same MD5 as the file sent. The form's
  requests were captured 17 Oct 2026 on one approved post.

No bulk read exists on the surfaces tested (multiget rejects the path), so a read costs one GET per
(student, assignment).

## Model

Two new tables (`schema.sql`, `CREATE TABLE IF NOT EXISTS`):

- **`submission_comments`:** one row per Schoology comment: `schoology_comment_id`, `assignment_id`,
  `student_id`, `author_uid`, `author_role` (`student` | `teacher` | `other`), `author_name`, `is_mine`, `body`
  (raw text as Schoology returns it), `created` (epoch seconds).
- **`submission_comment_reads`:** one row per (assignment, student) read: `read_at`, `error`. A read row with
  no comments means "read, empty", which differs from "never read".

A refresh replaces a pair's comments in one transaction. Author role is fixed at read time: the student's own
uid is `student`; Graham's uid or a section admin (`/enrollments`, `admin = 1`) is `teacher`; anyone else is
`other`.

Derived on output (`server/lib/submissionComments.js`), never stored: plain `text` (HTML removed),
`automatic_lines` (the `Revision N submitted` lines), `is_automatic` (a student comment holding only those
lines) and `student_text` (the rest of a student comment, or null).

## Fetching

- **On open:** the popover reads the cache; a missing or stale (over 5 minutes) pair is read from Schoology
  first. The Refresh button forces a read.
- **In the background:** loading the assessment page queues a read of every submitted cell of that assignment
  whose cache is over 10 minutes old, one at a time with a short delay (the REST limit is about 50 per minute).
  One queue per assignment; a second request joins the running one.
- **Gradebook:** shows only what is cached; it starts no reads.
- **PrisMCP:** `get_assignment_context` refreshes submitted students' threads first when Schoology credentials
  are set, then returns the cache. Without credentials it returns the cache and says so.

## UI (as the mock)

- **Card chip:** a comment bubble with the count in the card header; amber "Wrote in comments" badge when a
  student comment holds student text.
- **Popover:** the thread oldest first, author and school-time date (`formatDateTime`, DD/MM/YYYY); automatic
  lines faint and italic; student text in an amber block labelled "Student wrote"; teacher comments plain.
- **Post:** a textarea, Attach file and Post comment, then an inline confirmation ("Students see a submission
  comment at once", naming the file) before anything is sent. Each comment's files come from the same read
  (`?with_attachments=1`) and show as links served through Prism.
- **Delete:** only on Graham's own comments, with its own confirmation.
- **Grid cell:** a small bubble beside the submission state, amber when the student wrote text; a click opens
  the same popover.

## MCP shape

Each student in `get_assignment_context` gains:

```
submission_comments: [{ id, author_uid, author_role, created, text, is_automatic, student_text }]
submission_comments_read_at: ISO | null
```

`created` is ISO. The top level gains `submission_comments_source`: `{ refreshed, failed, cached_only }`.

## Feature flag

`features.submission_comments` in `config.yaml` (default on) gates the routes and the UI.

## Not yet verified (from the brief)

- Whether Schoology notifies or emails a student about a new submission comment. This decides item 5
  (posting a resubmission request as a submission comment), which waits for it.
- A comment on a OneDrive (`lti_submission`) thread: reads return 200 and empty everywhere tested.
- Paging past one page in practice (threads hold 0 to 3 comments).

## Calls made by the builder

- Plain-text rendering only (HTML stripped), so no student markup reaches the page.
- Cache freshness: 5 minutes on open, 10 minutes for the background queue.
- The gradebook starts no reads, to keep a course-wide view from costing hundreds of calls.
