# Flags: setting Schoology's grade flags from Prism (#40)

Design agreed with Graham on 21 October 2026 and revised the same day after the live probes. Mockups: the
private Artifact page "Flags in Prism" (https://claude.ai/artifact/RcePZWizTujDo17X1zpLf3), version 10. Absent revised to a marker the same day (no mockup change).
Probe results: `.claude/schoology-api-reference.md`, "Grade exceptions (flags)".

## Intent

A teacher sometimes exempts a student from an assessment because of extenuating circumstances, or marks
work late, missing, incomplete or absent. Today that means leaving Prism for Schoology's gradebook. Graham
exempted students a couple of times last year, each time **before any work existed**.

Prism should set Schoology's flags where the teacher already works, through a control a Schoology user
recognizes. Schoology's API calls them "exceptions"; its gradebook shows them as flags chosen from one
button with a list. Prism uses the gradebook's words: **Flags**, and **Exempt** (the gradebook's word on
this account for Excused).

## What Schoology does (probed 21 October 2026)

- **Codes:** `1` Exempt, `2` Incomplete, `3` Missing, `5` Absent, `6` Late. `4` is invalid (Prism
  wrongly treated 4 as Late until now; prod holds no 4 and 13 rows of 5).
- **Every flag removes the grade on this account:** Exempt, Incomplete, Absent and Late remove the score
  and every topic level; Missing sets the score to 0 and keeps the levels. The comment always stays.
- **Clearing** (exception 0) leaves the task ungraded (Missing leaves its 0).
- **No grade beside a flag:** writing levels clears the flag; writing a score with a flag removes the
  score. Schoology's own gradebook behaves the same here, because the school's realm setting
  `is_persistence_of_flags_in_gradebook_enabled` is off.
- **Late is therefore left out of the grade** while it is set, so it cannot mark a late piece of work that
  still counts (Graham, 21 October 2026: work too late to count should be graded 0).

## Decisions (Graham, 21 October 2026)

- **All five flags are settable:** Exempt, Late, Absent, Incomplete, Missing, each with a short line of
  guidance in the menu, under one subheading, "Flag in Schoology".
- **One Flags button**, in the style of Schoology's, on the assessment card header, the gradebook pop-up
  and each task on the student page (the last two share `AssignmentFeedback`, #135).
- **Every flag opens a panel**: an optional reason for the student, the saved-grade note on graded work,
  and the records it withdraws.
- **The reason** becomes a status line in the student's Schoology comment: `Marked exempt on Wed 21/10.`
  plus the reason (`Marked late on …`, `Marked absent on …`, `Marked incomplete on …`, `Marked missing
  on …`).
- **Graded work keeps its grade in Prism:** before any flag, Prism saves the grade (score, topic levels,
  rubric row levels, comment); the rubric shows it grayed and locked while flagged; clearing the flag
  offers to restore it as a draft.
- **Two final flags, three markers** (Graham, 21 October 2026). **Exempt and Missing are final:** the
  rubric stays locked while they are set, and they count as handled (feedback given, grading complete).
  **Late, Incomplete and Absent are markers:** the teacher grades straight through them in Prism, and
  publishing a grade clears the flag, as Schoology's own gradebook does; until then the work stays in
  feedback owed. Publishing a grade over a marker also retires any saved copy and removes the flag's
  status line.
- **Exempt is the only decision flag.** It withdraws Prism's open records on the task (extension,
  resubmission request, make-up, referral), after listing them, hides Extend, and takes the student out of
  make-ups, late work and feedback owed.
- **Absent is a marker, not a decision** (Graham, 21 October 2026). Teachers read it differently: "this
  was their one chance", or "a reminder to follow up". Prism assumes neither. Absent changes nothing in
  Prism by itself: no withdrawals, Extend stays, and make-ups, late work and feedback owed keep tracking
  the student. The panel explains what Absent does in Schoology and points to the two usual next steps.
  Late, Incomplete and Missing are markers in the same sense.
- **Flags show as symbols**, never as grade-like chips: a round, color-coded symbol with the flag's name
  in tiny capitals underneath, and a popover on hover or tap.
- **Colors:** Exempt green, Late red, Absent slate gray, Incomplete amber, Missing red (outlined).
- **The late-submission clock stays** (an outline clock in the cell corner, from Schoology's submission
  timing). The Late flag is the red clock symbol in the grade's place.
- **Flag for review is removed** completely (done, #40 task 6).
- **Prism's own past-due status is Overdue**, so "Missing" only means Schoology's flag (done, task 5).
- **Order of work:** flags first. Editing grades and comments from the gradebook and the student page is a
  separate, later issue (to open as part of this work).

## Goals

- Set, change and clear all five flags from the three surfaces, written to Schoology and read back.
- Keep a copy of every grade a flag removes, and offer to restore it when the flag is cleared.
- Show every flag clearly wherever a grade shows, as a symbol that cannot be read as a grade.

## Non-goals

- Bulk flags ("mark everyone who…"). A follow-up if needed.
- Editing grades or comments outside the assessment page (the separate issue above).
- A PrisMCP tool that sets flags (my call: nothing asked for one; it can follow later).
- Restoring a grade removed before this feature existed: no copy of it exists.

## Anti-goals

- **A grade lost to a flag.** Prism saves every part of the grade a flag removes before the write. A
  read-back that shows a loss Prism did not save is a failure, even if the flag is set.
- **A mark that reads as a grade.** A flag symbol a teacher could mistake for a level is a failure.
- **A Prism-only action in the Flags menu.** The menu holds Schoology's flags only.

## Flag symbols

| Flag | Code | Color | Symbol | Tiny name |
|---|---|---|---|---|
| Exempt | 1 | green, filled disc | a circle with a diagonal stroke | EXEMPT |
| Late | 6 | red, filled disc | a clock | LATE |
| Absent | 5 | slate gray, filled disc | a person beside a small circle with a diagonal stroke at its bottom left (as in Schoology) | ABSENT |
| Incomplete | 2 | amber, filled disc | a half-filled circle | INCOMPLETE |
| Missing | 3 | red outline, white disc | an exclamation mark | MISSING |

- **Size:** an 18px disc with a 12px glyph, the name below in 8.5px bold capitals, centered in the cell.
- **Popover** (hover on a computer, tap on a phone): the symbol and name, what the flag does, the reason
  line if Prism wrote one, and "Grade saved in Prism: Exhibiting (3.5). Clear the flag to restore it."
  when a saved copy exists.
- **Everywhere a grade shows:** the gradebook cell (which opens the pop-up when clicked), the pop-up and
  the student page (the shared view), and the assessment card's status area.
- One `FlagSymbol` component draws all five; the colors are tokens in `client/src/app.css`.

## The Flags control

### Closed

A pill in the card header, after Refer and before Extend: `⚑ Flags ▾`. When a flag is set, the pill shows
that flag's symbol, name and color (`Exempt ▾` green). In the shared view it is a smaller pill in the
badge row.

### Open

A subheading, "Flag in Schoology", then five items, each with its symbol, its name and a short line
(verbatim, with the student's first name; Graham, 21 October 2026: one subheading instead of repeating
"Visibly flags the work as … in Schoology"):

- **Exempt:** "Left out of Sam's grade."
- **Late:** "Left out of Sam's grade while flagged."
- **Absent:** "Absent for this task. Left out of Sam's grade."
- **Incomplete:** "No grade while flagged."
- **Missing:** "Scores this task as zero. Topic averages are unchanged." (on a task with no topics: "Scores this task as zero.")

Below a divider: "On graded work, Schoology removes the grade while a flag is set. Prism keeps a copy and
offers to restore it when you clear the flag." The ticked item's line reads "Choose again to clear it."
The menu works by keyboard (arrows, Enter, Escape).

### Setting a flag: the panel

Choosing any flag opens a panel under the card header (the action panel slot Extend uses), or inside the
shared view, titled "Mark Jordan exempt?" (late, absent, incomplete, missing). It holds:

- **Reason for the student (optional):** one line. With a reason, Prism writes the status line with a
  preview: "Added to the top of Jordan's comment: "Marked exempt on Wed 21/10. Medical leave from 13 to 24
  October."" Prism writes the line only when a reason is given.
- **Records withdrawn** (Exempt only): "Also withdraws: Extension to Fri 24/10/2026".
- **The saved grade** (graded work only): "Schoology removes this grade while the flag is set. Prism keeps
  a copy: Exhibiting (3.5) and 2 topic levels. Your comment stays." For Missing: "Schoology sets this
  grade to 0 while the flag is set. Prism keeps a copy: …".
- **Next steps** (markers only):
  - Late: "Grading the work clears Late, and the grade then counts. If the work is too late to count,
    mark it Missing instead."
  - Incomplete: "Set a date to finish with Extend. Grading the work clears Incomplete."
  - Absent: "If Sam will make this up, set a date with Extend. If Sam will not do this task, mark Exempt
    instead."
- **Buttons:** "Cancel" and "Mark exempt" (the flag's verb).

A flag that replaces another flag (one value per task) opens the same panel.

### Clearing a flag

- **With a saved copy:** a small panel, "Clear Exempt?", with one box, ticked by default: "Restore the
  saved grade as a draft: Exhibiting (3.5) and 2 topic levels" ("(replaces your current draft)" when one
  exists). A part the card cannot stage (a points-only score, or an overall the teacher typed in place of the computed one,
  such as 90 over three levels of 100) is listed as "Re-enter in Schoology: 90". Buttons "Cancel" and
  "Clear Exempt".
- **Without one:** clearing saves at once.

### After a write

The card shows the flag's symbol and the pill takes the flag's color. For Exempt and Missing the rubric is
grayed and locked, with the saved levels and the caption "Saved before the flag on Wed 21/10. Clear the
flag to restore it." For Late, Incomplete and Absent the rubric stays open, with a note above it: "Grading
this work clears Late." Extend hides for Exempt. A failed write shows its reason beside the pill and keeps the previous
state.

## Saving and restoring the grade

- **Saving:** before the flag write, Prism takes the grade from the fresh pre-write read: score,
  `max_points`, comment and `comment_status`, each topic level (`mastery_scores`), each rubric row level
  (`rubric_row_levels`), and the overall scale level. It stores them in a new table `excused_grades`
  (student, assignment, the saved grade as JSON, the flag, `saved_at`, `restored_at`), one row per student
  and task. The write goes ahead only once the copy is stored. A copy is kept until restored or replaced.
- **Why its own table, not a draft:** a draft can be edited, discarded, replaced by staged AI suggestions,
  or published. The copy must stay exactly as it was while the task is flagged.
- **Restoring:** after the clear write and its read-back, Prism writes the saved grade into the student's
  draft (`assessment_drafts`) in the card's shape (`pending` keyed by topic id, `row:<criterion>` and
  `__scale__`, plus `comment` and `display`), with `base` from `cardBaselineFor`
  (`server/services/unfinishedGrading.js`) so the card does not discard it as stale, and sets
  `restored_at`. The grade returns to Schoology with the usual Publish, which writes the levels first.
  Clearing with the box unticked keeps the copy; while it exists and no flag is set, the card offers
  "Restore saved grade".

## Writing to Schoology

- **Path:** the public bulk `PUT /sections/{id}/grades` (`pushGradeComments`, renamed
  `pushGradeUpdates`), with `exception` set and every other field echoed from a fresh read (the #46 rule).
  Clearing sends `exception: 0`. **Clearing Missing** sends `grade: null` as well, so no 0 is left
  counting; that also blanks the topic levels Missing kept (verified), so Prism saves them in the copy
  first and offers them back.
- **Safety pattern** (`server/services/quizWriteback.js`): re-read before the write and refuse if the row
  changed since the page loaded (score, exception or comment), showing what changed; save the copy; write;
  read back and confirm the flag (and that every part Schoology removed is in the copy); update the local
  `grades` row from the read-back; then withdraw records and publish the status line. A gateway error
  (non-2xx, or a per-entry code of 400 or more) changes nothing in Prism.
- **Status line:** a new kind, `flag`, in `server/lib/statusLines.js`, published through
  `statusLinePublisher.js` (first line of the comment, Display on, removed by exact stored text). It
  replaces any earlier Prism line for the pair. Clearing the flag removes it.
- **Withdrawing records:** each open record is closed through its existing undo path (record only); the
  flag's status line then replaces their line, or, with no reason, the stored line is removed.
- Like the assessment page's other writes, this is a web route, so a dev copy's PrisMCP guard does not
  apply; live writes happen only from prod or on a test target Graham names.

## Late, triage and PrisMCP

- **Only the final flags count as handled:** `hasFeedback`, the feedback fingerprints, `gradingState`
  and the client's `gradingStateOf` treat Exempt (1) and Missing (3) as feedback given and grading
  complete. Late, Incomplete and Absent do not: the work stays in feedback owed until it is graded.
- **Grading over a marker:** the mastery write clears the flag in Schoology by itself (verified). A score
  written with the public PUT must send `exception: 0` when the pair holds a marker, because a score sent
  with a flag is removed (verified).
- `grades.late` stays the submission signal only; writing a flag never touches it. The outline corner
  clock keeps showing a late submission.
- PrisMCP descriptions name the five flags and their codes.

## Testing

- Server: the flag write for each code, the refusal on a changed row, the read-back, per-entry 207
  handling, the saved copy (stored before the write; the write refused if storing fails), the status line
  (text per flag, removal on clear, written after the flag), withdrawals for Exempt only, the
  restore into the draft with a valid `base`, the busy lock.
- Client: the menu (five items, verbatim copy, ticks, keyboard), the panel (reason preview, withdrawals,
  saved-grade note), the clear panel, the pill colors, `FlagSymbol` (five symbols, names, popover), the
  gradebook cell, pop-up and student page showing the symbol, and the grayed saved rubric.
- The full root and client suites and `npm run build`, as AGENTS.md requires.

## Documentation

- `docs/design-language.md`: flag symbols, the Flags menu and panel, flag colors.
- `.claude/schoology-api-reference.md`: the probe results (done).
- `.claude/build-progress.md`, and `mcp/server.js` descriptions where flags appear.
- Issue #40: the probe results and the shipped behavior; a new issue for editing grades and comments on
  the gradebook and the student page; a note on Late (left out of the grade on this account).

## Left to the builder

- The pill's saving state, and the exact wording of failure messages.
- The popover's exact layout within the copy above.
- Whether the gradebook cell needs a fresh sync after the write or the read-back is enough.
