# Edit grades from the student page and the gradebook (#176)

Date: 23 Oct 2026. Status: agreed with Graham in conversation, 23 Oct 2026.

## Why

Graham changes grades during appeals: a 1-on-1 with a student, or a parent meeting with the student page
projected. Today the student page and the gradebook pop-up are read-only, so he has to open the assessment
page. That page lists the whole class, so on a shared screen it reveals classmates' names, grades and work.
He changes the grade in the meeting, because a note for later gets forgotten.

## Goals

- **Edit where the student is:** each task on the student page, and the gradebook pop-up, can change
  levels or score, the comment and Display, then publish to Schoology.
- **One card everywhere:** the editor is the assessment page's own card (`StudentRubricCard`), not a new
  component. Graham: "I don't want to create more bespoke UI components that differ from those with a
  similar function. Let's keep the UI consistent."
- **Show the work:** the card already holds the student's files, the OneDrive or Google Drive "Open" link,
  the test attempt link and the submission comment thread. They come along unchanged.
- **Same write safety:** the card's existing publish path (fresh read, refuse on a change, echo unchanged
  fields (#46), read back, and the flag rules from #40). Nothing new is written by a new path.
- **Same drafts:** the card's existing draft store (`assessment_drafts`, `assessmentDraftSaver.js`), so
  work started on one surface continues on another, and an unpublished edit appears in Triage's
  Unfinished grading panel as a reminder.
- **Add update:** a button that records an appeal's change above the existing comment (see below).
- **A better rubric grid:** fix the descriptor grid's column balance on every page (see below).

## Anti-goals (a failure even if it works)

- **Anything about another student on screen.** No classmate's name, grade, work or count appears on the
  student page or in the card. The page should request only this student's data where the API allows; a
  class-wide response filtered in the browser is acceptable only where a single-student route is missing.
  Only this student's data is ever rendered.
- **AI suggestions on screen.** On these two surfaces the card shows no AI suggestion of any kind.
- **A third look.** No new editor layout, no restyled copy of the card.

## Decisions (Graham's)

- **In place on the student page.** Choosing **Edit** on a task turns that task's read-only view
  (`AssignmentFeedback`) into the card, inside the page, at the page's width. Measured 23 Oct 2026 at a
  1440 px window: the grid is 1045 px wide on the student page and 1080 px on the assessment page, so the
  card fits.
- **The gradebook pop-up (`RubricModal` in `CoursePage.jsx`) does the same inside its modal:** Edit
  swaps the read-only view for the card. The gradebook is already a class view, so privacy is not the
  concern there; consistency is.
- **Meeting setting on the card:** one prop (name left to the builder) that hides the student portrait and
  every AI suggestion: suggested levels in the grid (the `suggested` cell state and its sparkle), the
  narrative suggestion box with Use / Ignore / Show again, Reviewer notes, and any other `AiSparkle`
  element. The assessment page does not set it and is unchanged.
- **Add update.** A button on the card's comment, on every surface including the assessment page. It
  places `Update (DD/MM/YYYY): ` (today, via `formatDate`) on its own line above the existing comment, a
  blank line, then the comment unchanged, and puts the cursor after the colon. Graham: "Add an 'Update: …'
  preamble. Keep the original comment text below for visible record keeping purposes."
- **Rubric grid balance.** In `RubricDescriptorGrid` the five level columns are fixed at 15% each, so the
  topic column always takes 25%. Measured on the student page: the topic cell's 108 characters filled 74 px
  of a 200 px row, while 254 characters in the Exhibiting Depth cell set the row's height. Make the topic
  column narrower and let the level columns share the rest by their content. This changes every page that
  draws the grid (assessment page, student page, gradebook pop-up), which is intended.
- **Points-only tasks: comment and Display only** (Graham, 23 Oct 2026). On a task scored in points
  with no topics and no scale, Edit opens the card as the assessment page does today: comment, Add update
  and Display, no points. Nothing new is written to Schoology.

## Calls made by the agent (Graham to check)

- **The date in the update line.** Graham wrote "Update: …"; the date is added for the record.
- **Attention chips stay** (such as "Overdue"): they describe only this student.
- **Edit only where Prism can write:** it is absent from archived and excluded courses, and a linked-section set (#178,
  `courseSections.assertSectionWritable` refuses those writes). The read-only view stays as it is there.
- **Done, not Cancel.** Drafts save themselves, so the card in place has a **Done** button that returns to
  the read-only view, refreshed from the server. Unpublished changes stay as a draft.
- **A visible draft marker.** When a draft exists for a task, its read-only view on the student page
  shows a small "Draft, not published" badge (an existing badge style), so an unfinished change is visible
  in the room as well as in Triage.
- **Add update appears only when the comment box holds text,** and a second press on the same day moves
  the cursor to the existing update line instead of adding another.
- **The update goes below a status line.** Prism's status lines (Ask to resubmit, Extend, a flag's
  reason, resubmission received) must stay on line 1: `composeComment` (`server/lib/statusLines.js`,
  `client/src/lib/statusLines.js`), the card's `topLineIs` / `statusLineFields`, and `removeStatusLine` in
  `server/routes/mastery.js` match them only at the start of the comment. When the comment starts with
  one, the update line goes directly below it; otherwise it is the first line.
- **Several tasks may be open for editing at once;** each card is independent, as on the assessment page.

## Constraints

- `StudentRubricCard` lives in `client/src/pages/AssessmentSummaryPage.jsx` (lines 130 to 1873) and takes
  its data as props from that page (`feedbackRow`, `draftRow`, `rubric`, `topics`, `assignmentRow`,
  `scoreScale`, links and summaries). The page-level props (`registerCard`, `onPendingChange`,
  `onDisplayChange`) are optional. The builder may move the card to its own file; behaviour on the
  assessment page must not change.
- The card loads with the same data the assessment page passes it for one student. Where today's routes
  return the whole class (`getMasteryForAssignment`, `getFeedbackForAssignment`), add a student filter
  rather than sending classmates' data to the student page.
- Frontend conventions in `AGENTS.md`: palette tokens only, button classes, no em dashes in UI copy, dates
  as DD/MM/YYYY, phone rules in the single `PHONE LAYOUT` block.
- Record the grid change and the meeting setting in `docs/design-language.md`.

## Verification

- **Client tests:** the meeting setting hides the portrait and every suggestion element; Add update builds
  the comment as specified; Edit and Done on the student page and in `RubricModal`; no Edit on archived,
  excluded or linked courses; the draft badge.
- **Server tests** for any new student filter on a route.
- **Live write:** one publish from the student page on the unpublished test task "AIML: Prism Flags Check
  (F)" (`8619091769`, aligned to two AI & ML topics), with Graham's approval, then a read-back from
  Schoology, then the record returned to how it was.
- **Grid:** check the new column balance on the assessment page and the student page in a browser at
  laptop and phone widths (`npm run check:mobile`).

## Left to the builder

The prop name for the meeting setting; how the student page fetches one student's card data; the
grid's exact widths; whether the card moves to its own file.
