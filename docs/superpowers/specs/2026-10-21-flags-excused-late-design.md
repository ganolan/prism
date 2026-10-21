# Flags: Excused and Late from Prism (#40)

Design agreed with Graham on 21 October 2026. Mockups: the private Artifact page "Excused and Late in
Prism" (https://claude.ai/artifact/RcePZWizTujDo17X1zpLf3), version 4.

## Intent

A teacher sometimes excuses a student from an assessment because of extenuating circumstances. Excused
leaves the task out of the student's grade calculation. Today that means leaving Prism for Schoology's
gradebook. Graham excused students a couple of times last year, each time **before any work existed**.

Prism should set Schoology's flags where the teacher already works, through a control a Schoology user
recognizes. Schoology calls these "exceptions" in its API; its gradebook shows them as flags chosen from
one button with a list. Prism follows the gradebook's word: **Flags**.

## Decisions (Graham, 21 October 2026)

- **Settable:** Excused and Late. Late is a manual toggle for teachers who use it. Only the teacher sets it;
  a late submission never does (as today).
- **Shown but not settable:** Incomplete and Missing. They always appear in the menu, grayed, so a
  Schoology user knows they exist. They may become settable in a later release, depending on need.
- **One Flags button**, in the style of Schoology's: one button that opens a short list.
- **Flag for review is removed** completely (see "Removing Flag for review").
- **Three surfaces:** the assessment page card header, the gradebook submission pop-up, and each task on
  the student page. The last two share one view (`AssignmentFeedback`, #135), so one control serves both.
- **Late shows as one mark.** A teacher's Late flag uses the same late clock as a late submission.
- **Prism's own "Missing" status is renamed "Overdue"**, so "Missing" only ever means Schoology's flag.
- **Excused withdraws Prism's open records on the task** (extension, resubmission request, make-up
  tracking, referral), after listing them.
- **Excused takes an optional reason for the student**, written into the student's Schoology comment as a
  status line with the date, because students and parents often need to know why.
- **Order of work:** flags first. Editing grades and comments from the gradebook and the student page is a
  separate, later issue (to open as part of this work).

## Goals

- Set, change and clear Excused and Late from the three surfaces, written to Schoology and read back.
- Warn before a write that deletes a grade, and list exactly what Schoology deletes.
- Show every flag state correctly everywhere a grade shows, including Late with its grade still visible.
- Leave Prism with one meaning per word: **Late** (one clock), **Missing** (Schoology's flag), **Overdue**
  (Prism's past-due status).

## Non-goals

- Setting Incomplete or Missing.
- Bulk flags ("excuse everyone who…"). A follow-up if needed.
- Editing grades or comments outside the assessment page (the separate issue above).
- A PrisMCP tool that sets flags (my call: nothing asked for one; it can follow later).
- Recovering a grade Schoology deleted. Schoology destroys it; Prism cannot restore it.

## Anti-goals

- **A silent loss of data.** A write that deletes a grade, topic ratings or a comment without the warning
  naming each one is a failure, even if the flag is set correctly.
- **A warning based on assumption.** The warning lists what the probes showed Schoology deletes, not what
  the issue guessed.
- **Two marks for one meaning.** A second late indicator, or "Missing" meaning two things, is a failure.
- **A Prism-only action in the Flags menu.** The menu holds Schoology's flags only.

## The Flags control

### Closed

A pill in the card header, in the place Flag for review held: `⚑ Flags ▾`. When a flag is set, the pill
names it: `⚑ Excused ▾`, `⚑ Late ▾`, `⚑ Missing ▾`. In the shared view it is a smaller pill in the badge
row, beside the status pill, the comments chip and the "Open in Schoology" link.

### Open

```
Excused     Leaves this task out of Sam's grade. Schoology locks the rubric.
Late        Marks the work late. The grade still counts.
──────────
IN SCHOOLOGY ONLY (i)
Incomplete  (grayed)
Missing     (grayed)
```

- **Excused and Late** each carry one line that states the effect. The ticked item's line reads "Choose
  again to clear it."
- **Incomplete and Missing** sit below a thin divider, under one small muted caption, "In Schoology only",
  with an "i" marker. The caption is the explanation, because a phone has no hover and many browsers
  send no hover events to a disabled item. On a computer, hovering the "i" or a grayed item shows "Set
  these in Schoology for now. Prism may add them later." The grayed items are one line each, with no
  description, to keep the menu short.
- **A flag set in Schoology** (Incomplete or Missing) shows ticked inside the grayed group.
- **Accessibility:** the grayed items use `aria-disabled="true"` (still focusable and announced), not the
  `disabled` attribute. The menu works by keyboard (arrows, Enter, Escape), as other Prism menus do.
- **If Incomplete and Missing become settable later**, they move up beside Excused and Late, and the
  caption goes.

### Choosing

- **Choosing Late, or clearing a flag, saves at once**: Prism writes it to Schoology, reads it back, and
  the pill shows the new state. While the write runs, the pill shows a saving state and the menu cannot be
  reopened.
- **Choosing the ticked item clears it** (exception 0, or whatever the probe shows clears it).
- **One flag per task.** Schoology holds one exception value, so choosing Late replaces Excused, and either
  replaces a Schoology-set Incomplete or Missing.
- **Choosing Excused opens a panel** under the card header (the action panel slot Extend uses), titled
  "Excuse Jordan?". In the shared view, the same panel opens inside the view. It holds:
  - **Reason for the student (optional):** one line of text. Prism writes a status line
    (below) only when a reason is given.
  - **Open records:** see the point after the grade warning.
  - **The grade warning,** on a graded task only (red), as described below.
  - **Buttons:** "Cancel", and "Excuse" ("Excuse and delete the grade" when the grade warning shows).
- **The status line:** a new kind, `excused`, in `server/lib/statusLines.js`, published through
  `statusLinePublisher.js` like the others (first line of the comment, Display on, removed by exact
  stored text). Its text is `Excused on Tue 21/10.` followed by the reason, for example `Excused on Tue
  21/10. Medical leave from 13 to 24 October.` The date is the day the flag is set (`lineDate`). The
  reason follows the existing note rules (plain ASCII, `plainLine`). It replaces any earlier Prism line
  for the pair, such as an extension's. Clearing Excused removes it. When the probes show Excused deletes
  the comment, write the line after the flag, so the deletion cannot remove it.
- **The grade warning** (red, graded task only) states: "Schoology deletes this grade when
  a task is excused. Clearing the flag later leaves the task ungraded." It lists each item Schoology will
  delete (score, each topic rating, the comment if the probe shows it goes) and has two buttons, "Cancel"
  and "Excuse and delete the grade".
- **Excused withdraws Prism's open records on the task** (Graham, 21 October 2026): an extension, a
  resubmission request, make-up tracking and a referral. Before the write, the panel lists them ("Excusing
  also withdraws: Extension to Fri 24/10/2026").
  Prism then closes each one through its existing withdraw or undo path, which removes its status line
  from the Schoology comment, so the student no longer sees a due date for an excused task. When the
  probes show Excused deletes the comment, the stored status line is already gone: record each line as
  removed without writing again. A staged draft and open AI suggestions stay (the rubric is locked, and
  they return to use if the flag is cleared).
- **Late and clearing a flag open no panel:** the grade stays, and nothing is deleted.
- **After Excused:** the card shows the "Excused" status pill and "Excused, rubric locked", the rubric
  grays, and Extend hides (all existing behavior for exception 1).
- **A failed write** shows its reason beside the pill (for example "Schoology refused the change: …") and
  leaves the previous state showing.

## Late: one clock

Today a late submission (`grades.late`, from Schoology's submission timing) puts a quiet red clock in the
gradebook cell's top-right corner, and on the status pill elsewhere (`LateClock`, design language entry of
17 October 2026). Schoology's Late flag (exception 4) is a second, separate signal.

- **One mark:** a cell or pill is late when either signal is set, and shows the same clock either way.
- **The hover text names the source:** "Submitted 2 school days late" (the existing `lateText`), "Marked
  late with Flags", or both on two lines.
- **The Flags menu ticks Late only when the flag is set.** That is where a teacher tells the two sources
  apart and clears the flag.
- **Bug to fix:** `gradeLabel` (`client/src/lib/gradeLabel.js`) returns the text "Late" in place of the
  grade when exception is 4, so the gradebook cell hides a grade Schoology still counts. Exception 4 must
  show the grade, with the clock. The assessment card's amber "Marked late in Schoology" badge goes; the
  clock on the status pill and the Flags pill replace it.
- **Late is display only** (my call). Today any exception, Late included, counts as
  feedback or completion: `hasFeedback` (`server/lib/resubmission.js`), the feedback fingerprints
  (`server/lib/feedbackFingerprint.js`, stored in `feedback_snapshots`), `gradingState`
  (`server/services/assessmentContext.js`, so PrisMCP reports a Late student as complete and the grading
  agent skips submitted work), and `submissionTimeline.js`. Exception 4 must count as neither: the grade
  still has to be given. Excused, Incomplete and Missing keep their current meaning. Changing the
  fingerprint changes stored snapshots, so compare old and new fingerprints in a way that does not
  treat the change itself as new feedback (the builder chooses how). Referral and feedback-wait counts
  keep using submission dates.
- `grades.late` stays the submission signal only. Writing exception 4 never touches it.

## Rename Missing to Overdue

Prism's status pill says "Missing" when a task is past due with nothing submitted (`nonLtiBadges` in
`gradeLabel.js`). Rename its label to **Overdue**, and its gradebook letter from **M** to **O**
(`SHORT_BADGE` in `CoursePage.jsx`). Graham suggested this on 14 May 2026 and confirmed it on 21 October.
Find every place the word reaches a teacher (filters, legends, help text, PrisMCP descriptions) and rename
it there too; keep Schoology's Missing flag (exception 3) as "Missing".

## Removing Flag for review

Prod holds 8 review flags, all unresolved, all reading "Below 50%: …", left by an automatic rule from
April 2026 whose code is already gone. None was set by hand, and all are on last year's courses.

Remove:
- the "Flag for review" pill, its reason input and its active state on the assessment page;
- the review badge in `SubmissionBadges`, the gradebook's `review_needed` cell data (`server/routes/courses.js`)
  and the student page's review flags;
- `review_needed` from the PrisMCP `get_assignment_context` answer (`server/services/assessmentContext.js`);
  keep `resubmit_requested`, which comes from the `resubmissions` table. The assessment-grader plugin does
  not read `review_needed` (checked 21 October 2026);
- any assessment-page filter for flagged students (`client/src/lib/assessmentFilters.js`);
- `server/routes/flags.js` and the `flags` table, with a migration that drops it (the 8 rows go with it).
  Check first that nothing else reads the table: the student page's resubmission-request entries are built
  from `resubmissions` and only shaped like flags (`server/routes/students.js`); keep those, renamed without
  the word "flags" if that is simple.

Keep the AI suggestions' **reviewer flags** (`reviewer_flags`, `reviewer_flags_brief`): a separate feature.

## Writing to Schoology

### Probes first

Run the probe protocol in issue #40 before any product code, on a test task Graham names (one with a
numeric scale, one aligned summative). Every probe is one live write that Graham approves, then a
read-back. The probes that decide this design:

- set Excused on an ungraded row; on a graded row (does the score clear by itself, or must Prism send
  `grade: null`?);
- set Late on a graded row (does the grade stay?);
- change Excused to Late in one write;
- clear each flag (0, null, or something else), and the row's state after (ungraded? `timestamp`?);
- an aligned task with topic ratings: do the ratings survive Excused, and after clearing?
- a row with a grade comment: does the comment survive?
- a bulk write with one rejected entry: are the per-entry codes reliable?

Also probe which flags Schoology's gradebook menu offers beyond the four exceptions (the 7 May 2026
comment on #40 found "Absent", which has no exception code) and where each is stored (the internal
gradebook write carries a separate `flags` field).

How the results change the design (my calls):
- **Prism deletes only what Schoology's own write deletes.** If Excused leaves the score, ratings or
  comment in place, Prism leaves them too and the warning omits them; the grade
  warning appears only when Schoology deletes something. Prism never sends `grade: null` or deletes topic ratings itself. Ratings that
  survive but stop counting toward the grade are left alone and documented.
- **One flag per task stays,** unless a probe shows Schoology holds Late independently of the exception;
  then Late becomes a separate tick beside the exception list.
- **Every write echoes the fields it leaves unchanged,** including any separate flag such as Absent, so a
  Prism write keeps flags Prism cannot see.
- **The grayed group lists each flag Schoology's menu offers that Prism does not set,** in Schoology's
  names.

Record each result, with its date and the raw response shape, in `.claude/schoology-api-reference.md`
(the AGENTS.md rules on observed shapes apply). The warning's list comes from these results.

### Write path

Prefer the public bulk `PUT /v1/sections/{id}/grades` that `pushGradeComments`
(`server/services/schoology.js`) already sends, and rename it `pushGradeUpdates` as the issue asks. If a
probe shows the public API cannot do what Schoology's gradebook does, fall back to the internal gradebook
write (`grader_grade_data`), as the AGENTS.md order of preference describes, and document it.

### Safety pattern

Copy `server/services/quizWriteback.js`:

- re-read the row from Schoology before the write, and refuse if it changed since the page loaded (score,
  exception or comment), showing the teacher what changed;
- echo every field the write is not meant to change (the #46 rule in the API reference);
- read the row back after the write, and confirm the flag (and, for Excused, the deletion the warning
  listed);
- update the local `grades` row from that read-back, not from the request.

A dev copy refuses this write, as it refuses other Schoology writes.

## Testing

- Server tests beside the new service: the write, the refusal on a changed row, the read-back, the
  per-entry 207 handling.
- Server tests for the `excused` status line: its text, its removal on clear, and its order after the
  flag write.
- Client tests: the menu (items, grayed group, ticks, keyboard), the Excused panel (reason, open records,
  the warning on a graded task only), the
  saving and failed states, the late clock and its hover text for each source, `gradeLabel` showing the
  grade for exception 4, the Overdue label, and the removal of Flag for review.
- The full root and client suites and `npm run build`, as AGENTS.md requires.

## Documentation

- `docs/design-language.md`: the Flags menu (a grayed group under one caption, explained without hover),
  the single late clock, and Overdue.
- `.claude/schoology-api-reference.md`: the probe results.
- `.claude/build-progress.md`, and `mcp/server.js` descriptions where `review_needed` or "Missing"
  appears.
- Issue #40: the probe results and the shipped behavior; a new issue for editing grades and comments on
  the gradebook and the student page.

## Left to the builder

- The pill's saving state, and the exact wording of the failure messages.
- Component structure (one `FlagsMenu` used by the card header and `AssignmentFeedback` is the obvious
  shape).
- Whether the gradebook cell needs a fresh sync after the write or the read-back is enough.
- The exact list of places "Missing" (Prism's status) appears.
