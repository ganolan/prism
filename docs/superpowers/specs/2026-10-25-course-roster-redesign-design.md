# Course roster redesign (#160)

Designed with Graham over eight rounds of mockups, 24 and 25 Oct 2026. The approved mockup (round 9) is the private
artifact `https://claude.ai/artifact/1mChRbjJgHkdmvrU3wCzrp`: it holds invented students and AP CS's real reporting
categories and measurement topics. Where this document and the mockup differ, this document wins.

## Intent

The roster tab shows email addresses and a mastery table by default, and Graham rarely needs either (17 Oct 2026).
What he needs when he opens a roster:

- **Before a test:** who has an accommodation plan, and how much extra time each student gets. Today that means
  clicking a symbol in Schoology and reading a block of text.
- **Day to day:** the students who need his attention (overdue work, unread comments), and their alerts.
- **At report time:** every student's reporting category levels side by side, so he can compare students, find
  where Schoology's level is wrong, and override it fairly.

A roster may be projected to a class. Anything private stays hidden until Graham turns it on, and that includes
overdue work, levels and grades, not only alerts: "students may judge each other based on that".

## Goals

- A clean default card: photo, the student's name, grade, student number, and a button that copies the email.
- One switch, **Private details**, that shows everything private, remembered on the device until turned off.
- Four modes on the Roster tab: **Roster**, **Needs attention**, **Test day**, **Mastery**.
- Alert detail in place: tapping an alert shows what it is (the plan, the allergy) without leaving the roster.
- Filters and email copying for the students shown.
- Needs attention replaces the triage rail on the Roster tab, with the rail's own actions.
- Test day shows each learning plan's extra time for a chosen test, from a figure Graham confirms once.
- Mastery compares Prism's category levels and grade with Schoology's, and sets Schoology's override from there.

## Non-goals

- **Attendance** (Graham, 25 Oct 2026: leave it for #39). No absences slot in this version. #39 adds one later
  (the mockup's slot and lesson strip show where it would go).
- **The student page.** Graham wants the details panel's header (name, grade, student number, email copy, alerts,
  support notes) and the recent-tasks list moved to the student page instead of a roster drawer. That is a follow-up
  issue, not this work.
- **The Analytics tab.** Graham is still thinking about what it shows. A follow-up issue.
- **A drawer or mini student page.** Graham rejected it (25 Oct 2026): tapping a student opens the student page.

## Anti-goals

- **Private data in a projected view.** With Private details off, no private value is rendered at all: not hidden by
  CSS, not in the DOM, not in a tooltip, not counted in a summary line.
- **Elements that move.** A slot keeps its place whatever is switched on or off, so a column can be read down the
  page (Graham, 24 Oct 2026). The one allowed change: with Private details off, the private slots are not drawn.
- **A second legal name.** Show one name, the one the student goes by (Graham, 25 Oct 2026). No "legal name" line in
  any mode.
- **New controls where Prism has them.** Filters reuse the assessment page's group pill, pills, status line and Clear
  all; email copying reuses Class Tools' formats; overrides reuse `OverridePopup`; triage actions reuse the rail's
  components and rules (Graham: "let's not reinvent stuff").

## Graham's decisions

Dated 24 or 25 Oct 2026 unless marked.

- **One switch for everything private.** Levels and private details are "one and the same". Default off.
- **Private details label** stays "Private details" (Graham floated "Show all"; the agent kept the label because it
  states what it shows. He may rename it).
- **All four tabs always show.** With the switch off, Needs attention, Test day and Mastery each show a short
  explanation in place of their content, so Graham can see what exists.
- **No on-time rate anywhere**, and no overdue count on the card: overdue work shows in Needs attention.
- **Unread comments** are a vital on the card (private).
- **Needs attention** groups triage by student and reuses its signals; triage stays as it is everywhere else.
- **Test day** lists learning plans only, never health alerts.
- **Extra time**: Prism suggests a figure from the plan text; Graham confirms it once; Prism remembers it.
- **Alert detail**: probe PowerSchool's alert pop-ups and show the detail where it can be read.
- **AQHI 6 or above** (both alerts) joins the roster's alerts. Missing Health Form, Early Dismissal and Library Alert
  stay out.
- **Mastery**: Prism's level is the correct one; Schoology's is what students and report cards see. A difference is
  a signal to override Schoology. Prism and Schoology sit in two columns; Schoology's chip fades when it agrees and
  stands out when it differs.
- **Category names** read "1 - Content Knowledge": the category's number and its name without the course prefix.

## The Roster tab

### Header and switch

The course header keeps its title. **Private details** is a pill directly beside the course name, left aligned
(amber when on), on the Roster tab only (as built: on the other tabs it would imply the switch hides their grades). Its
state is stored in `localStorage` (one key for every course), read in a `try`, default off. It replaces the existing
alerts toggle (`prism:roster:show-ps-alerts`), which goes.

Below the header, a row of mode tabs: Roster, Needs attention, Test day, Mastery. The chosen mode is remembered like
the course tabs (`useStickyTab`).

The triage rail is hidden on the Roster tab in every mode, with the `Triage ▸` button that the Gradebook tab uses to
bring it back. Needs attention replaces it here; the dashboard and the other tabs keep the rail. As built, the rail
is not mounted on the Roster tab until the teacher opens it with `Triage ▸`, and the red count on that button is
drawn only with Private details on (the count is private too). Every tab change closes the rail, so one opened on
Gradebook does not follow the teacher to the Roster tab (amended 25 Oct 2026, final review).

### Roster mode: the card

One card per enrolled student, in name order. Dropped students keep the existing "N dropped (show)" disclosure.

- **Left:** the photo (initials when there is none), then the name in a large weight, then one line: `Grade 11`,
  the student number, and an **Email** copy button, separated by small CSS dots (the timeline's dot pattern: the dot
  trails the item before it, so a wrapped line never starts with one). The student number is the email's local part,
  as on the student page (`StudentPage.jsx`).
- **Right (private):** the unread comments count ("2 comments"; tap to read), then the alert chips. Fixed widths, so
  the counts line up down the page.
- **Tapping the card** opens the student page. Tapping a button inside it does that button's job only.

The name is the one Prism already shows (`preferred_name_teacher`, then `preferred_name`, then `first_name`), from
the existing helper in `client/src/lib/studentNames.js`.

### Alert chips and their pop-ups

The chips use the existing alert labels and colours (`PsAlertBadges`: learning blue, health amber, other gray),
roster categories only: family alerts never appear (unchanged rule, `forRoster`). Short labels on the chip ("Plan",
"LS 1"); the full name in the pop-up.

Tapping a chip opens an anchored pop-up (`.help-pop`-style, Escape or a click outside closes it):

- **A learning alert** (accommodation plan, accommodations only, ILP, learning support 1 to 3, support summary): the
  student's Student Support Summary, read live through the existing `GET /api/students/:id/support-summary`, as a
  two-column table (Category, Description) with empty rows left out.
- **Any other alert**: its detail, read live from PowerSchool's alert pop-up, where the probe below shows it can be
  read. Elsewhere the pop-up names the alert and states that Prism can read only that it is set.

**Probe first, and it gates Test day too.** A student can hold a learning alert without the Support Summary alert,
and `GET /api/students/:id/support-summary` answers 404 `NO_ALERT` for them (`server/services/psSupportSummary.js`);
the 17 Oct sync found 8 accommodation plans and 13 summaries, overlap unknown. So the probe also reads the
accommodation plan's own pop-up (`mbapop_spp.html`) and the Support Summary for several students. Where no text
can be read for a student, the plan pop-up lists the plan names only, and Test day shows "No time in the notes" with
**Set extra time** (Graham confirms the figure by hand once). Before building the other pop-ups, probe each alert's pop-up (`stub_url`, e.g.
`mbapop_*.html`) over plain HTTP, the way #163 read the Support Summary: after the attendance LTI launch, with the
attendance page as Referer and `X-Requested-With: XMLHttpRequest`. Record the verified shapes, dated, in
`.claude/powerschool-api-reference.md`. **Approved by Graham (25 Oct 2026), read only:** up to 3 students per alert
type, from one current class; the API reference records response shapes only, never a student's name or text. The SPP pop-up returned 77 bytes for one student on 17 Oct; that result is a
lower bound, so test more than one student before concluding.

**AQHI**: add the two AQHI alerts (`10593867`, `10593869`, `sf` on `X_APIABOVE100`, `in 1` / `in 3`) to `ALERT_DEFS`
in `server/lib/psAlerts.js` and its client mirror, category health. Labels: "AQHI: stay inside", "AQHI: except
events" (as built; the first draft read "AQHI: inside always" and "AQHI: inside except events").

### Comments pop-up

Tapping the comments count opens a pop-up listing that student's unread comments in this course, oldest first:
the task title, the date and time, the student's text (and file chips), and **Open the task in Prism**, which goes to
`/course/:id/assessment/:aid?student=:sid`. Unread means what it means everywhere in Prism
(`submissionCommentStore.js`): a comment the student typed or attached a file to, newer than the last one seen;
automatic lines and Graham's own comments never count. Opening the list does not mark anything read; opening the
thread on the assessment page does, as now.

### Filters

Shown only with Private details on, above the cards, built from the assessment page's controls
(`.assessment-filter-bar`, `button.group-pill`, `.filter-btn`, `.assessment-filter-status`, `button.filter-btn-clear`;
`docs/design-language.md`, "Assessment page filter controls"):

- **Row 1:** an **Alerts** group pill (none, some, all, with the count of students who hold any alert), a divider,
  then one pill per alert type that some student in the class holds, with its count. Learning alerts share one pill,
  **Learning plan**.
- **Row 2:** a **Follow up** group pill (muted ink), a divider, then **Unread comments**. (#39 adds absences here.)
- **Status line:** on the left "Showing 4 of 12 students" (or "Showing all 12 students") with **Copy emails (N)**
  beside it; **Clear all** on the right while any filter is on, where the assessment page puts it.

Pills combine as "any of", as on the assessment page. A pill shows only while some student matches it or it is on.
The filter state is per course and per session (no need to remember it).

### Copy emails

**Copy emails (N)** opens a pop-up for the students currently shown (all of them, or the filtered set):

- **Whose emails:** Students, or Guardians.
- **Format:** the two Class Tools formats (`EMAIL_FORMATS` in `ToolsPage.jsx`): "Names + emails (Outlook, ;
  separated)" and "Emails only (, separated)".
- A read-only preview of the text, then **Copy N emails**.

Guardian emails follow Class Tools' rules for who is included (do-not-contact and deceased guardians left out,
`server/routes/tools.js` `GET /emails/:courseId`). Extend that endpoint, or share its helper, so it takes a list of
student ids; do not write a second copy of the guardian rules.

## Needs attention

Private: with the switch off, it shows the explanation box only.

With the switch on: the heading **Needs attention (N)**, then the students who have at least one triage row, sorted
by their most urgent row; then **Everyone else (N)** as plain cards. Each card is the Roster card plus its rows,
under a thin divider:

- **One row per triage item that the student owes, in this course**, from `getTriage({ courseId })`
  (`server/services/triage.js`). The agent's call, from the reviewer's reading of the code (25 Oct 2026): a row is
  in when the next move is the student's, or a referral Graham decides about the student:
  - **Late work:** overdue (nothing handed in), and handed in late at the limit (Refer or Waive).
  - **Make-up tests** still owed.
  - **Resubmissions** asked for and not yet arrived (pending or overdue). An arrived resubmission is Graham's
    grading, so it stays out.
  - **Flags** that leave the student owing work: Incomplete (2) and Absent (5).
  Out: Feedback owed, Unfinished grading, arrived resubmissions, and the Late (6), Missing (3) and saved-grade flag
  rows, whose advice is Graham's own grading ("Grade the work", "Clear the flag and grade the work"). Overdue work
  that carries a Missing flag still shows as Overdue, with the flag's `FlagSymbol` beside the kind.
- **Each row:** the triage ring (school days, toward the limit, with the rail's green, amber and red; a flag row
  uses the Flags panel's own clock and tone), the kind in words ("Overdue", "Late, handed in", "Make-up test",
  "Resubmission pending", "Resubmission overdue", "Incomplete", "Absent"), the task title as a link, and one muted line in the rail's wording ("7 school
  days late, 1 left"; "at the limit").
- **The task link** opens `/course/:id/assessment/:aid?student=:sid`, which filters the page to the Needs action
  group and scrolls to that student's card. Check that the assessment page does both with one link; add the
  missing part if it does not.
- **Actions:** the rail's buttons with the rail's rules and components (`ExtendEditor`, `EmailMenu`, Refer, Waive,
  Undo): Refer and Extend for overdue work at the limit; Refer and Waive for late work at the limit; Extend and
  Email otherwise; Email for a resubmission or a flag row (with the Flags panel's own actions, if it has them). The Extend editor opens under its row.
  As built, overdue work at the limit shows Email as well as Refer and Extend (mockup round 9: "it makes sense to
  repeat the emails").
- **Order within a card:** most urgent first (the rail's order: red, then amber, then the rest; within a tone, the
  larger share of the limit first).

The data stays one source: the rows are triage's own, so the roster and the rail can never disagree. Grouping by
student is a client step (or a small server helper with a test); either way, no second calculation of lateness.

## Test day

Private: the test picker and length show with the switch off; the list of students shows only with it on.

- **Test picker:** the course's Schoology tests (`assignments.is_test = 1`, published, not removed) due from today
  to 14 days ahead, nearest first, defaulting to the nearest; plus **No test (plans only)**.
- **Length:** a `NumberStepper` in minutes (5-minute steps), starting at 50. Prism holds lesson dates
  (`class_meetings`) and lacks lesson times, so the first version shows durations rather than clock times: "63 minutes, 13
  more". Clock times are a follow-up once Prism stores bell times (`section_info.bellScheduleItems`, already in the
  API reference).
- **No test:** a dashed box, "No test is set in the next two weeks.", and the list still shows each plan's extra
  minutes for the length chosen. As built, when tests exist and **No test** is picked the box says "No test
  chosen." instead (the other sentence would be false).
- **The list:** students with a learning alert. Each card: photo, then the name and plan names in a fixed-width
  column, then the extra-time controls directly after it (left aligned, not pushed to the right edge), then one line
  from the plan text that mentions time (else the first description).
- **Extra time, three states:**
  - **Confirmed:** the total and the extra minutes, with **Change**.
  - **Suggested:** "Notes mention 25%", with **Use 25%** and **Other**.
  - **None found:** "No time in the notes", with **Set extra time**.
  **Other**, **Set extra time** and **Change** open a stepper (5% steps) and **Save**.
- **Suggestion:** parsed from the student's Support Summary text: a percentage next to "time" ("25% extra time",
  "extended time (25%)"), and "time and a half" as 50%. A pure function with tests; any other wording gives no
  suggestion.
- **Plan text is read live, only when needed** (Graham, 25 Oct 2026, keeping #163's "nothing stored"): Test day
  reads the Support Summary only for students whose extra time is not yet confirmed, one after another, and keeps
  each answer for 10 minutes (the existing cache). A refused read (`SECURITY_VIOLATION`) or an ended session
  (`SESSION_EXPIRED`) stops the reads, and the list says why once (amended 25 Oct 2026, final review). A confirmed student needs no read; their card shows the confirmed
  figure and loads the plan line on request.
- **Stored:** the confirmed percentage per student, in a new Prism-owned table (schema plus `MIGRATIONS`), with
  `updated_at`. It belongs to the student, not the course, so it shows in every course the student is in. PrisMCP's
  student tools may return it later; not in this version.

## Mastery

Private: with the switch off, the explanation box only. With it on, a segmented control: **All reporting
categories**, then one button per category ("1 - Content Knowledge", "2 - Computational Thinking Practices": the
category's number, from its `external_id`, and its title without the "AP CS: " course prefix).

### The values

- **Topic average:** the mean of the student's scores on that measurement topic across the course's assessments
  (`mastery_scores`), as a level chip; "-" (outlined) for a topic not assessed yet. This is Prism's own number, so the
  chips and Prism's category level come from the same scores (the agent's call: Schoology's per-topic rollup stays on
  the student page).
- **Prism's category level:** the mean of every topic score the student has in that category's topics, the value
  the current roster labels "Computed" (`CoursePage.jsx`, `categoryAvg`: all the points in the category together,
  not a mean of topic means). Graham, 25 Oct 2026: this is the correct value.
- **Schoology's category level:** (a missing Schoology level beside a Prism level counts as differing, as built)
  the category rollup Schoology holds (`mastery_rollups`, `is_category = 1`:
  `override_value` when set, else `grade_scaled_rounded`), with an asterisk when it is an override. Schoology reaches
  its value differently, so the two can differ; Schoology's is the one students and report cards see, and an override
  is how Graham corrects it.
- **Grades:** `computeLetterGrade` (`client/src/lib/masteryLevels.js`) on Prism's levels, and on Schoology's.

### All reporting categories

One card per student, and a **Class average** card first:

- **Left:** small photo, name, and the grade and student number line.
- **Middle:** one line per reporting category, stacked: a small category-number chip (hover: its full name), the
  topic chips (hover: topic code, name, level and percentage), a divider, then Prism's level and Schoology's level.
  Topic chips sit in a fixed-width track as wide as the course's longest category, so the category levels line up in
  one column down the page.
- **Right of the categories, directly beside them:** Prism's grade (large) and the grade Schoology's levels give
  (smaller), in the same two columns. Schoology does not give a grade: the heading reads "Schoology levels", and the
  hover text reads "Schoology's levels give B; Prism's give B+" or "Schoology's levels give the same grade".
- **A header row** above the first card names the columns: Topic averages, Prism, Schoology (with a `.help-dot`),
  Grade, Schoology levels. On a narrow screen the header is replaced by one line ("Left: Prism, right: Schoology" and the
  help dot).

### One reporting category

One short row per student under a header that stays on screen while the page scrolls (`position: sticky`; no
`overflow` container around it, or it stops sticking):

- The header names each topic (code in bold, name under it) over its column, then Prism and Schoology (with the help
  dot).
- Columns share the available width. The row scrolls sideways only when the screen is too narrow for the topics,
  and the first column starts directly after the names.
- **Sorting:** tap a topic heading or Prism to sort, highest first; tap again for lowest first; a third tap turns it
  off. A line above the header states the sort ("Sorted by 2.3 Abstraction, highest first.") with **Clear sort**.
- **Class average** row first.
- On a narrow screen the name takes its own line above the chips, and the header shows topic codes only.

### Schoology's chip and the override

- **Agrees with Prism:** faint, a dashed outline and muted text.
- **Differs:** filled in its level's colour, with an amber ring, so it stands out in a column. No "!" badge (Graham,
  25 Oct 2026: overkill, and it moved the text). The hover text states both levels.
- **The grade's Schoology chip** follows the same two styles.
- **The help dot** sits to the right of the "Schoology" heading on the same line, never under it (widen the column
  rather than wrap). Its text: "Schoology's level is the one students and report cards see. Faint means it
  matches Prism. Highlighted means it differs: tap it to set Schoology's override to Prism's level."
- **Tapping a category's Schoology chip** opens `OverridePopup` for that student and category, the same component
  and write path as the student page (it writes the override, then stores Schoology's reply). When the two
  differ, the pop-up offers **Override Schoology to D** (Prism's level) first, then the other levels and
  **Clear override**.

## Layout and phones

- The cards respond to the roster's own width (CSS container queries on the roster container), because the same page
  is full width, beside a rail, or on a phone. This is a new pattern in Prism: record it in `docs/design-language.md`.
  The `PHONE LAYOUT` media block in `app.css` keeps any rule that is about the device (the drawer, tap targets);
  rules about the roster's width live with the roster's styles.
- Pop-ups stay inside a 16px gutter and open above their anchor when there is no room below.
- `npm run check:mobile` must still pass, and the roster has no horizontal page scroll at 390px.

## What goes from the current roster

The email column, the Grade column, the per-category Computed and Schoology cells, the two letter-grade columns and
their legend (all replaced by the Mastery mode), the legal name in parentheses, and the alerts toggle. The letter-grade
scale pop-up (`LetterGradePopup`) moves to the Mastery mode, opened from a "Scale" link beside the Grade header.

## Tests

- **Server:** the AQHI alert rules; the extra-time suggestion parser; the extra-time store (read, write, migration);
  the emails endpoint with a student-id list; any server helper that groups triage by student.
- **Client:**
  - **Privacy:** with Private details off, no comment count, alert, level or grade is in the DOM in any mode.
  - **Filters:** the group pill states and the status line.
  - **Needs attention:** row order and the task link.
  - **Test day:** the three extra-time states and no test.
  - **Mastery:** agree and differ styles; the sort cycle; the override opening `OverridePopup` with Prism's level
    first.
- **Copy:** every new string passes `client/src/copy.test.js` (no em dashes, no rejected phrases).
- **Live check:** one override written from the Mastery mode on a target Graham names, then read back, as every new
  write path gets (AGENTS.md). The override path is the existing one, so this confirms the wiring only.

## Documentation

- `docs/design-language.md`: the roster card, the one switch and what it hides, container queries, the Schoology chip
  styles, and the projection-safety rules (update "Projection safety", which says alerts are on the roster only behind
  a toggle).
- `.claude/powerschool-api-reference.md`: the alert pop-up probe results, dated.
- `.claude/build-progress.md`: a section for #160.
- `docs/improvements-log.md`: test-day extra time (Schoology's symbol and text block, against one confirmed figure
  and the total per test) and the Prism-against-Schoology category check.

## As built (25 Oct 2026)

Where the build departs from the text above, or settled what it left open (each ruling is in the SDD ledger):

- **AQHI labels:** "AQHI: stay inside" and "AQHI: except events" (20 characters or fewer, the alert-label limit).
- **Private details pill:** on the Roster tab only.
- **Triage rail:** not mounted on the Roster tab until `Triage ▸` opens it; the red count shows only with Private
  details on. Needs attention reads triage from the course page's own fetch.
- **Needs attention:** overdue work at the limit shows Email beside Refer and Extend.
- **Test day:** "No test chosen." when tests exist and No test is picked.
- **Mastery:** an aligned category with no scores shows "-" levels and no grade; a missing Schoology level beside a
  Prism level is a difference (amber ring); the `OverridePopup` lives in the Mastery view, and the course page's
  old unreachable override pop-up was removed.
- **Server:** `GET /api/courses/:id` returns `linked` (a set of linked sections), so the client can disable
  Schoology overrides there (#178). The filters' group pill is a shared component (`GroupPill.jsx`) used by the
  assessment page and the roster.
- **Probe:** the alert pop-up shapes are recorded in `.claude/powerschool-api-reference.md`. The two AQHI pop-ups
  were not probed (they were kept after the probe): they read as plain text or as "Prism can read only that it is
  set".
- **Removed:** the old roster table and its per-category columns, the legal name, the roster's alerts toggle.
- **Gender and sort (Graham, 25 Oct 2026, after the build):** with Private details on, the card's meta line reads
  grade, gender (Female or Male; nothing when unknown), student number, Email, and the filter bar has a third row,
  **Gender** (Female, Male, Not known, each with its count; dropped students never counted). Its pills join the one
  selection set, but Gender narrows: any of the Gender pills AND any of the Alerts and Follow up pills (controller
  ruling, 25 Oct 2026: gender is an attribute, as the assessment page's Refine pills are). A "Sort by" control
  above the Roster mode's cards offers First name, Last name (the default) and, with Private details on, Gender
  (Female, Male, unknown, then last name). The choice is remembered on this device in `localStorage`
  (`prism:roster:sort`, one key for every course); Gender with the switch off sorts by last name and leaves the stored
  value. It applies to the Roster mode only. Code: `lib/rosterSort.js`, `components/roster/RosterSort.jsx`,
  `rosterVitals.js` (`gender` options and keys), `rosterFilters.js` (`genderOf`, `GENDER_LABELS`).

## Left to the builder

- Component structure, file names, and whether triage is grouped on the client or the server.
- The exact pop-up component (reuse `.help-pop` or the comment popover's portalled pattern).
- The short chip labels for AQHI and other long alert names.
- The `localStorage` key name for Private details.

## Follow-up issues to open

- **Student page:** the header (name, grade, student number, email copy), alerts and support notes in place, a
  recent-tasks list, the unread comments (as a filter on the student's assessments, near the top), and absences once
  #39 reads them.
- **Analytics tab:** what it shows, including the per-topic dot plot the mockup's class panel tried.
- **Test day clock times:** store bell times so finishing times can show.
- **#39:** add the absences slot, the lesson strip and the "3 or more absences" filter to the roster (comment on the
  issue).
