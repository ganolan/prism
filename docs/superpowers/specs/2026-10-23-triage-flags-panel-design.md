# Triage: Schoology flags that need follow-up (#174)

Design agreed with Graham on 23 October 2026. Issue: #174. Depends on #40 (the Flags menu, flag symbols,
`excused_grades`), design `2026-10-21-flags-excused-late-design.md`.

## Intent

In Schoology a flag looks like a decision. On this account it is often the opposite: Late, Incomplete and
Absent take the task out of the student's grade until the teacher acts, and the grade stays out until
someone does. Graham has left a flag in place, believing it was handled, and only learned otherwise when
the student replied: the grade did not count, and the student benefited (Graham, 23 October 2026).

The panel shows every flag that is waiting on the teacher, so a flag that favors the student is never
forgotten. It is a list the teacher empties: each row leaves the panel when the teacher grades the work or
makes a decision.

Graham sets flags in Schoology, and has not used Prism's Flags menu yet. **Flags set in Schoology are the
main source**, and the panel must show them as soon as a sync has read them.

## Goals

- **One Triage panel, "Flags",** on the Dashboard rail and each course page's rail, beside the existing
  panels.
- **Each row:** the student, the task, the flag symbol, one line of advice, a school-day count from the
  flag's date, a link to the student's card on the assessment page, and a compact flags control.
- **Urgency:** rows grow more urgent as the end of the semester approaches.
- **PrisMCP:** `get_triage` returns the same rows.

## Non-goals

- **No new Schoology write path.** The row's control is the #40 Flags menu, with its existing safety
  (fresh read, `CHANGED` refusal, saved grade).
- **No grading in the panel.** Grading stays on the assessment card; the row links to it.
- **No archived courses.** Current courses only, as every other Triage panel.
- **No reporting deadline.** Graham's reporting deadline varies, so urgency uses the semester dates
  (Graham, 23 October 2026).

## Anti-goals

- **A row that looks handled when it is not.** The panel exists because Schoology's display misleads; a row
  that disappears before the grade counts repeats that failure.
- **Advice that decides for the teacher.** The Absent line stays neutral (Graham, 21 October 2026, on
  #174): teachers read Absent differently.
- **Noise from deliberate decisions.** Exempt never shows. Missing shows only when it needs action.

## Which rows show

| Flag | Effect on the grade | Shows when | Advice line |
|---|---|---|---|
| **Late** (6) | Left out | always | Grade the work, or mark it Missing if it is too late to count. |
| **Incomplete** (2) | Left out | always | Set a date to finish, then grade it. |
| **Absent** (5) | Left out | always | Arrange a make-up, or mark it Exempt if the absence is excused. |
| **Missing** (3) | Counts as zero | the student submitted after the flag date | Clear the flag and grade the work. |
| **Exempt** (1) | Left out | never | (a deliberate decision) |

Two more row kinds, from the issue:

- **Submitted after a flag:** any flag except Exempt, when the student's latest submission is after the
  flag date. For Late, Incomplete and Absent this is a tag on the row they already have ("Submitted after
  the flag"); for Missing it is the reason the row shows. Advice: clear the flag first, because a grade and
  a flag cannot coexist on this account.
- **Saved grade not restored:** the flag is cleared (`grades.exception` is 0) and `excused_grades` still
  holds a copy with `restored_at` empty. Advice: "Restore the saved grade, or publish a new one." The link
  opens the card, which already offers "Restore saved grade". Its day count runs from
  `excused_grades.saved_at`, the day the grade left the record. *(Builder's call, settled in the design
  review.)*

**Flagged work that another panel also shows gets a row in both** (Graham, 23 October 2026). An Absent on
a missed test stays in Make-ups, a Late on submitted work stays in Feedback owed, and each also has its
Flags row. Flags lists every flag that keeps a task out of the grade; the other panels keep their own
clocks and counts (make-up days, the referral count) unchanged.

## How a row leaves the panel

- **Graded:** publishing a grade clears Late, Incomplete and Absent (verified in #40), so the row goes at
  the next read of that record.
- **Marked Missing** from the row: the work counts as zero and the row goes (unless a later submission
  brings it back as above).
- **Marked Exempt** from the row: a deliberate decision; the row goes.
- **Cleared** in Schoology or Prism: the row goes, or becomes a "Saved grade not restored" row.
- **Left alone:** the day count rises and the tone changes with the semester's end.

## The flags control in the row

Graham asked for Missing and Exempt in the row, as a collapsed control like the card's, with an icon in
place of the full text, and left the form to the builder (23 October 2026).

- Reuse `client/src/components/FlagsMenu.jsx` with `size="sm"` and a `panelHost`, as
  `AssignmentFeedback.jsx` already does outside the card. The closed control is the flag symbol only.
- The menu offers every flag, as on the card, so "Clear" is also reachable here. *(Builder's call: one
  control everywhere; keep the full list if it fits the rail.)*
- After a write, the panel reloads its rows (`onChange`).

## Flag date

Prism does not record when a flag appears. Add `grades.flag_seen_at` (TEXT, ISO) in `schema.sql` **and**
the `MIGRATIONS` array in `server/db/index.js`.

- **Set** whenever a write gives a pair a flag code it did not have before (0 or a different code), from
  every writer of `grades.exception`: `taskGrades.writeGrades`, `gradeFlags.js`, `statusLinePublisher.js`,
  `masterySync.js`. One shared helper sets it, so the writers agree.
- **Value:** the record's Schoology `timestamp` from that read when present (every write to a record
  restamps it, verified 2026-10-21 and 2026-10-22, so on the read where the flag first appears it is the
  flag's write time), else the time Prism saw it.
- **Cleared** when the exception returns to 0.
- **Backfill** in the migration for rows already flagged: the stored grade timestamp (`submitted_at`, which
  holds the REST `timestamp`), else the migration time. Mark backfilled counts `approx`, as the panels do
  outside the stored calendar. *(Builder's call.)*
- **Day count:** school days from `flag_seen_at`, flag date as day 1, with `loadCalendar` /
  `cal.between`, as the other panels count.

## Semester end

Prism stores no term end dates. Schoology's grading period for current sections spans the whole year
("HS 26-27"), and grades are reported each semester, so that date is the wrong one.

- **Spike first** for a source of semester start and end dates, in this order (AGENTS.md "Spike before you
  settle"): PowerSchool terms (the PowerTeacher pages Prism already reads; sections' `calenderDays` span
  their term, `.claude/powerschool-api-reference.md`), then Schoology's `GET /v1/schools/{id}/grading_periods`
  and `GET /v1/sections/{id}/grading_periods`. Record what each surface returns in the API reference.
- **If no surface has them,** add two dates to Settings (end of semester 1, end of semester 2), read as a
  settings key in the `triage.*` namespace. *(Builder's call, only after the spike.)*
- **Which semester:** the one that contains the task's due date, because that is the semester grade the
  missing grade inflates. A row from a semester that has ended stays red; it never resets when the next
  semester starts. A task with no due date uses the semester that contains the flag date. *(Builder's
  call, settled in the design review.)*
- **Tone** *(builder's call, from the other panels' style):* green until the last 10 school days of the
  semester, amber over those days, red over the last 5 and after the end until the row is handled. The
  panel sorts with the others by worst tone (`orderPanels`).

## Server and PrisMCP

- `server/services/triage.js` `getTriage` returns a new `flags` array, built from `currentCourses` ×
  `roster` like the other panels, with the shared row fields (studentId, studentName, courseId,
  courseName, blockNumber, assignmentId, schoologyAssignmentId, title, dueDate, day, tone, approx) plus
  `flag` (code), `kind` (`flag`, `submitted_after_flag`, `saved_grade`), `flagSeenAt`, `submittedAfter`
  (boolean), `advice` and `semesterEnd`.
- Unaligned formatives follow `includeFormative`, as the other panels. *(Builder's call.)*
- `get_triage` returns `flags` with the rest; with `student` set it filters `flags` as it filters
  `lateWork`. Update the tool description in `mcp/server.js`.
- No new route: `GET /api/triage` already returns the whole payload.

## Client

- A new `client/src/components/triage/FlagsPanel.jsx`, shaped like `LateWorkPanel.jsx`: `UrgencyRing`,
  name `Link`, task title, flag symbol (the #40 symbol component), advice line, `cardLink` to the student's
  card, the flags control in `.triage-row__actions`. Five rows, then `ShowAllToggle`.
- Register it in `TriageSection.jsx`'s panel list.
- Phone layout: any new rules go in the single `PHONE LAYOUT` block in `app.css`.
- UI copy: no em dashes (guard test). Append the panel's decisions to `docs/design-language.md`.

## Tests

- Server: `flag_seen_at` set, kept, changed and cleared by each writer; the migration backfill; each row
  kind, and the pairs that get none (Exempt, Missing before any later submission, a cleared flag whose
  copy is restored);
  tone against a fixed calendar and semester end.
- Client: the panel renders each row kind, the link, and the control; a write reloads the rows.
- PrisMCP: `get_triage` includes `flags`, filtered by `student`.

## Docs

`.claude/build-progress.md`, `.claude/schoology-api-reference.md` / `.claude/powerschool-api-reference.md`
(the spike's results, dated), `docs/design-language.md`, `docs/improvements-log.md` (Schoology's flags
look handled when they are not; Prism lists every one that favors the student), the `get_triage`
description, and #174.

## Calls made in the build (23 October 2026)

- **No new probe for semester dates.** The PowerSchool reference (verified 2026-10-06) already showed that a
  section's calendar spans its term, so each course's first and last school day is its term. No Settings
  fallback: a course whose term is not stored yet gives rows a null semester end, shown green.
- **`flag_seen_at` is INTEGER epoch seconds,** like the other `grades` timestamps, and the backfill is not
  marked `approx`: Schoology restamps a record on every write, so its stored timestamp is the flag's write
  time unless a later write moved it.
- **The panel is hidden on a fresh load with no rows,** as Resubmissions is.
- **The Flags menu opens above its button** when the room below is too small, found in the live check.
- **Row shape:** "Submitted after a flag" is the `submittedAfter` field and a tag on the row, not a kind of
  its own, and the flag date is `flagSeenOn` (a local date). A Late, Incomplete or Absent row keeps its own
  advice with that tag: publishing a grade clears those flags, so the advice still holds.
- **After the final review:** a Missing flag on a test the student has since taken shows (Schoology stores
  no attempt time, so the row is marked approx); an LTI submission in the same minute as the flag counts as
  after it (LTI times have no seconds); a semester end comes only from terms of at least 100 days inside
  the task's own course term, and never from an excluded course; the Flags menu measures its full height
  when it opens again.

