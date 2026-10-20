# Simplify Sync

Date: 20 Oct 2026. Issue: #58. Builds on #52 (mastery read on page load) and #108 (submissions and
scores read on page load).

## Intent

Graham (issue #58): a teacher must see at once whether a course's data is fresh, and how to sync it
if not. A user expects Schoology data and mastery to be synced together. Three
controls, three scopes, each syncing everything in its scope:

- **Sync Courses** (sidebar): the courses ticked in the dialog.
- **Sync Course** (course page): this course.
- **Sync Assignment** (assessment page): this task.

## Decisions (Graham, 20 Oct 2026)

- **Label:** a prominent "Synced 03:02 today" beside Sync Course and Sync Assignment: the last full
  sync of that course or task. A small line under it: "Checked for new work at 22:31", the time of
  the pages' own background reads (#52, #108), or why that read failed. The two muted lines now on
  the course page and the assessment page's mastery line are replaced by this label.
- **Unticked gets nothing:** in Sync Courses the ticks decide everything. One list grouped
  Current, Hidden, Archived; defaults as now (current ticked, hidden and archived unticked). A
  ticked archived course is read again in full.

## Goals

1. **Sync Courses.** The sidebar button and the dialog are renamed. The dialog's two steps become
   one course list; each ticked course gets its Schoology data and its mastery. The PowerSchool and
   "only recent submissions" options stay. The "Include hidden courses" box goes (the Hidden group
   replaces it).
2. **Sync Course.** "Sync Mastery" becomes "Sync Course" (`.primary`): a full sync of this course,
   recorded in Recent syncs like any run. Then the page reloads.
3. **Sync Assignment.** "Refresh from Schoology" becomes "Sync Assignment" (`.primary`): this task's
   metadata (title, due date, points, assignees), submissions, grades and comments, mastery scores,
   and its submission comment threads. Then the page reloads (the no-unsaved-changes rule of #52
   stays).
4. **The label** on both pages, as above, prominent: normal text colour, larger than the muted lines;
   an amber tone when the full sync is more than a day old.

## Non-goals

- **The student page's per-course mastery line** stays as it is.
- **PrisMCP** is unchanged.
- **The nightly sync's options** (Settings → Scheduled sync) keep their meaning.

## The design

### Stamps

- **`courses.course_synced_at`** (new, schema + MIGRATIONS): set when a sync finishes reading the
  course's section data (roster, tasks, grades, submissions). `courses.synced_at` is not used: the
  sync writes it for every section it lists, synced or not.
- **`assignments.task_synced_at`** (new, schema + MIGRATIONS): set for a task when a sync read its
  submissions (so a task outside a recent-only window keeps its older time), and by Sync Assignment.
  `assignments.synced_at` is not used: every mastery read writes it, including the course page's
  background read. *(My call.)*
- **What counts:** a run that read the course's Schoology data sets `course_synced_at`, whether or not
  its mastery read succeeded; a mastery failure shows in the check line. *(My call.)*
- **The check line** is the later of the page's background reads (mastery and submissions), with
  the failure and sign-in of whichever failed, as `MasteryFreshness` does now.

### Server

- **`fullSync` takes `courseIds`** (null = today's behaviour: every current course, hidden ones
  when `includeHidden`). Given a list, it reads those sections, plus any section Prism has not read yet
  (so a new term's course is read); a listed archived course is read through
  `finalizeArchivedCourse` (in full, #72 reversed; its mastery is not read a second time). The
  student profile step reads only the synced courses' students when a list is given; with null it
  reads every student, as now. The one-time backfills and the auto-archive check keep running.
  *(New sections: my call.)*
- **The orchestrator and `POST /api/sync` take `courseIds`**, passed to `fullSync`; the
  comments phase reads only those courses' threads when a list is given. The Sync dialog sends the
  ticked ids as both `courseIds` and `masteryCourseIds`. **Scheduled sync keeps `courseIds: null`**
  (today's behaviour, every student's profile refreshed). The alerts pass runs for the listed
  courses; the block pass stays whole, since it also stores the school calendar (changed after the
  review, 20 Oct 2026). *(My call.)*
- **Sync Course** uses the same run: `POST /api/sync` with `courseIds: [id]`,
  `masteryCourseIds: [id]`, PowerSchool off. When a sync is already running, `GET /api/sync/current`
  also returns its `courseIds`: if it covers this course (null, or a list holding it) the button
  joins it; otherwise the button shows "Waiting for the running sync…" and starts its own run when
  that one ends. *(My call.)*
- **Sync Assignment** extends `POST /api/mastery/:courseId/assignment/:id/sync`: before the
  existing reads, `GET /sections/{sid}/assignments/{aid}` (verified; 404 when deleted, then the task
  is marked removed), written with the sync's own assignment upsert (extracted from
  `syncSectionData`; assignees mapped through the stored enrolment ids); after them, the task's
  comment threads (`refreshAssignment`, forced). Its answer adds `syncedAt` (`task_synced_at`).

### Client

- **Sidebar:** "Sync" → "Sync Courses". Dialog title and start button: "Sync Courses".
- **`SyncConfig`:** one list (groups Current, Hidden, Archived), the options above it, the mastery
  sign-in notice kept where mastery needs it. Archived courses come from the course list the dialog
  already loads.
- **A shared `SyncStatus` component:** the prominent time, the primary button, the check line.
  Used by the course page and the assessment page. Empty-state texts that name "Sync Schoology" or
  "Sync Mastery" are reworded.

## Verification

- Tests beside each change: `fullSync` with `courseIds` (only those sections; archived re-read;
  profiles limited); the dialog's payload; the assignment metadata read (and 404 → removed);
  `SyncStatus` states (fresh, a day old, check failed, syncing).
- Live on a dev server against a scratch copy: Sync Course and Sync Assignment on one course and
  task, with their times.
- Every suite, the build, CI green, prod serving the commit.
