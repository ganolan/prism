# Course Roster Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the course page's Roster tab with a private-by-default roster card and four modes (Roster, Needs attention, Test day, Mastery), as #160's design describes.

**Architecture:** New server pieces are small and separate: AQHI alert defs, an alert-detail read (after a probe), a confirmed extra-time store, an emails helper shared with Class Tools, and an unread-comments list. The client gets a `components/roster/` folder: one tab component that owns the Private details switch and the mode, and one component per mode. Each mode reads existing data (course students, triage, mastery, support summary). Pure logic lives in `client/src/lib/` with tests.

**Tech Stack:** React (Vite), React Testing Library and Vitest (client); Express, better-sqlite3 and Vitest (server).

**Spec:** `docs/superpowers/specs/2026-10-25-course-roster-redesign-design.md` (approved by Graham, 25 Oct 2026). Read it before any task. Mockup: `https://claude.ai/artifact/1mChRbjJgHkdmvrU3wCzrp` (round 9).

## Global Constraints

- With Private details off, no private value is in the DOM: comment counts, alerts, filters, copy-emails, Needs attention rows, Test day students, levels, grades.
- Private details: one `localStorage` key for every course, read and written in `try`, default off. It replaces `prism:roster:show-ps-alerts` (`client/src/lib/psAlerts.js`).
- One name per student: `preferredFirstName(s)` + `last_name`. No legal name anywhere on the Roster tab.
- Student number = `email.split('@')[0]`; no email, no number and no copy button.
- Reuse, do not copy: the assessment page filter classes, `EMAIL_FORMATS`, `OverridePopup`, `ExtendEditor`, `EmailMenu`, `ReferPanel`, `FlagsMenu`, `UrgencyRing`, `HelpDot`, `FlagSymbol`, `PsAlertBadges` tones, `computeLetterGrade`, `useProficiencyScale`.
- UI copy: no em dash, no middot, no phrase in `REJECTED` (`client/src/copy.test.js`). Dates via `client/src/lib/formatDate.js`.
- Colours only from CSS variables in `client/src/app.css`; button classes `.primary`, `.secondary`, `.ghost`, `.filter-btn`.
- Alert labels are 20 characters or fewer (`server/lib/psAlerts.test.js`).
- Root tests use `DB_PATH=:memory:`; never touch a clone's database.
- Schoology writes from a linked-sections course are refused (#178); the override chip is disabled there with the existing reason.
- New table columns: `schema.sql` and `MIGRATIONS` both.

## Review Focus

- **A course with no reporting categories or no mastery rows:** Mastery shows "No mastery data yet. Press Sync Course." and no empty grid. Test in Task 10.
- **A Support Summary read that fails** (session expired, security violation, `NO_ALERT`): the pop-up and the Test day card show the error's message for that student only, and every other card still renders. Test in Tasks 3 and 9.
- **Dropped students:** shown only behind the existing "N dropped (show)" disclosure in Roster mode; never in Needs attention, Test day, Mastery, filters, counts or copied emails. Test in Tasks 6 and 7.
- **Switching Private details off while a pop-up, filter or editor is open:** the pop-up closes, filters clear, and nothing private remains rendered. Test in Task 6.
- **A category with more topics than fit** (7 or more topics, a phone width): the one-category view scrolls inside its own container only; the page never scrolls sideways. Check in Task 11 with `npm run check:mobile`.

---

### Task 1: Probe PowerSchool's alert pop-ups

**Files:**
- Create: `scripts/probe-ps-alert-popups.js`
- Modify: `.claude/powerschool-api-reference.md` (section "Student alerts over plain HTTP (#117)", new dated subsection)

**Interfaces:**
- Consumes: the plain-HTTP attendance LTI launch and pop-up read used by `server/services/psSupportSummary.js` (`readSupportSummary`), and the alert catalogue `getAlertTypes.json` (`server/services/psAlertsSync.js:114`).
- Produces: a recorded shape per alert key in the API reference, with a verdict `readable | empty | refused`. Task 3 parses exactly those shapes.

Approved by Graham (25 Oct 2026): read only, up to 3 students per alert type, from one current class; the reference records response shapes, never names or text.

- [ ] **Step 1:** Write the script. Run from the repo root (never `/tmp`), using `.env` and the saved session. For each kept alert in `ALERT_DEFS` with a `stub_url` (from the live catalogue), pick up to 3 students in one current course who hold it (`student_ps_alerts`), and GET its pop-up as #163 did (Referer `/integrations/attendance/index.html`, `X-Requested-With: XMLHttpRequest`). Include the accommodation plan pop-up (`mbapop_spp.html`) and the Support Summary. Stop at the first "Security Violation Logged" page. Print per alert: HTTP status, content type, byte length, the HTML structure (tags and table headers only), and the number of non-empty cells. Never print cell text.
- [ ] **Step 2:** Run it: `node scripts/probe-ps-alert-popups.js --course <courseId>`. Expected: one line per alert key with a verdict.
- [ ] **Step 3:** Record the dated results in the API reference. Note that one empty answer is a lower bound (the playbook): an alert empty for all 3 students is "empty for 3 of 3 on 25/10".
- [ ] **Step 4:** Delete any local output file the script wrote. Commit.

```bash
git add scripts/probe-ps-alert-popups.js .claude/powerschool-api-reference.md
git commit -m "docs(powerschool): alert pop-up shapes for the roster's alert detail (#160)"
```

### Task 2: AQHI alerts

**Files:**
- Modify: `server/lib/psAlerts.js:26-46`
- Test: `server/lib/psAlerts.test.js`

**Interfaces:**
- Produces: alert keys `aqhi_inside` and `aqhi_except_events`, category `health`.

- [ ] **Step 1: Write the failing test**

```js
test('AQHI alerts are kept as health alerts and reach the roster', () => {
  const byKey = Object.fromEntries(ALERT_DEFS.map((d) => [d.key, d]));
  expect(byKey.aqhi_inside).toMatchObject({ label: 'AQHI: stay inside', category: 'health', psAlertIds: ['10593867'] });
  expect(byKey.aqhi_except_events).toMatchObject({ label: 'AQHI: except events', category: 'health', psAlertIds: ['10593869'] });
  expect(forRoster([{ key: 'aqhi_inside', category: 'health' }])).toHaveLength(1);
});
```

- [ ] **Step 2:** Run `npx vitest run server/lib/psAlerts.test.js`. Expected: FAIL.
- [ ] **Step 3:** Add the two entries, each with `title` "AQHI 6 or above: inside at all times" / "AQHI 6 or above: inside except events".
- [ ] **Step 4:** Run the file again. Expected: PASS (the 20-character and em dash tests too).
- [ ] **Step 5:** Commit: `feat(alerts): keep the two AQHI alerts (#160)`.

### Task 3: Alert detail read (after Task 4's parser)

**Files:**
- Create: `server/services/psAlertDetail.js`, `server/services/psAlertDetail.test.js`
- Modify: `server/routes/students.js` (new route beside `/:id/support-summary`)
- Modify: `client/src/services/api.js` (`getAlertDetail`)

**Interfaces:**
- Consumes: Task 1's shapes; `readSupportSummary` and `SupportSummaryError` from `psSupportSummary.js`.
- Produces: `readAlertDetail(db, studentId, alertKey, { jar, fetchImpl, now }) → { alertKey, kind: 'rows' | 'text' | 'none', rows?: [{ category, description }], text?: string, suggestedPercent: number | null, readAt }` (`suggestedPercent` from Task 4's `suggestExtraTime` over the text, learning alerts only; so Task 4 lands before this task's Step 3); route `GET /api/students/:id/alert-detail/:alertKey` (404 when `powerschool_alerts` is off; the same error codes and statuses as the support-summary route); client `getAlertDetail(id, alertKey)`.

- [ ] **Step 1: Write the failing tests** with fixture HTML built from Task 1's recorded shapes (no real student text):
  - `parses a readable pop-up into rows`
  - `returns kind none for an empty pop-up` (the 77-byte SPP shape)
  - `a learning alert uses the Support Summary when the student holds it`
  - `a learning alert without the Support Summary reads the plan pop-up, else kind none` (the `NO_ALERT` path)
  - `refuses a family alert key` (`NOT_ROSTER`, 400)
  - `refuses an alert the student does not hold` (`NO_ALERT`, 404)
  - `caches each answer for 10 minutes`, as `psSupportSummary.js` does
- [ ] **Step 2:** Run `npx vitest run server/services/psAlertDetail.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement `readAlertDetail`. Reuse the launch and the pop-up GET from `psSupportSummary.js`: export them from there rather than copying. Alerts whose pop-up Task 1 marked `empty` or `refused` return `kind: 'none'` without a read.
- [ ] **Step 4:** Add the route and a route test (pattern: `server/routes/students.supportSummary.test.js`). Run both files. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(alerts): read an alert's detail for the roster pop-up (#160)`.

### Task 4: Confirmed extra time

**Files:**
- Create: `server/lib/extraTime.js`, `server/lib/extraTime.test.js`, `server/routes/extraTime.js`, `server/routes/extraTime.test.js`
- Modify: `server/db/schema.sql`, `server/db/index.js` (`MIGRATIONS`), `server/index.js` (mount), `client/src/services/api.js`

**Interfaces:**
- Produces:
  - `suggestExtraTime(text: string) → number | null` (percent).
  - Table `student_extra_time (student_id INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE, percent INTEGER NOT NULL, updated_at TEXT NOT NULL)`.
  - `GET /api/extra-time?studentIds=1,2` → `{ [studentId]: { percent, updatedAt } }`; `PUT /api/extra-time/:studentId { percent }` (0 to 200, whole number) → `{ percent, updatedAt }`; `DELETE /api/extra-time/:studentId`.
  - Client `getExtraTime(studentIds)`, `setExtraTime(studentId, percent)`, `clearExtraTime(studentId)`.

- [ ] **Step 1: Write the failing parser tests**

```js
test.each([
  ['Extended time (25%) on tests and quizzes.', 25],
  ['Please allow 25% extra time for in-class assessments', 25],
  ['50 % additional time on assessments', 50],
  ['Time and a half on assessments. Breaks as needed.', 50],
  ['Double time for exams', null],
  ['See case manager for assessment arrangements.', null],
  ['Seat near the front (25% of lessons)', null],
  ['', null],
])('suggestExtraTime(%j) is %j', (text, want) => expect(suggestExtraTime(text)).toBe(want));
```

The last data case shows the rule: a percentage counts only within the same sentence as "time".
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement the parser. Then add the table, the migration and the router, with route tests: put and read back; reject 201 and -1 and 12.5 (400); delete; an unknown student (404).
- [ ] **Step 4:** Run `npx vitest run server/lib/extraTime.test.js server/routes/extraTime.test.js`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(roster): store each student's confirmed extra time (#160)`.

### Task 5: Shared emails helper and unread comments list

**Files:**
- Create: `server/services/classEmails.js`, `server/services/classEmails.test.js`
- Modify: `server/routes/tools.js:42-178`, `server/routes/tools.test.js`, `server/services/submissionCommentStore.js`, `server/routes/submissionComments.js`, `client/src/services/api.js`

**Interfaces:**
- Produces:
  - `classEmails(db, courseIds, { type: 'student' | 'parent' | 'both', filters, studentIds?: number[] }) → { students, emails, formatted, addresses, count, excluded }`: the handler's current body, moved, plus `studentIds`.
  - `GET /api/tools/emails/:courseId?students=1,2,3` accepts the new list. With `students`, filters are ignored.
  - `unreadCommentsForStudent(db, courseId, studentId) → [{ schoologyAssignmentId, title, created, studentText, attachments }]`, oldest first, from stored threads only.
  - `GET /api/submission-comments/course/:courseId/student/:studentId/unread` → `{ comments }`; client `getUnreadComments(courseId, studentId)`.

- [ ] **Step 1:** Write the failing tests:
  - `classEmails with studentIds returns only those students and their guardians, and keeps the do-not-contact and deceased rules`
  - `unreadCommentsForStudent lists only unread student comments, oldest first, never automatic or teacher comments`
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Move the handler body into `classEmails` unchanged, then add `studentIds`. The existing `tools.test.js` email tests must pass unedited. That proves the move changed nothing.
- [ ] **Step 4:** Add the unread helper (reuse the unread rule at `submissionCommentStore.js:25,31`) and its route behind `featureGate('submission_comments')`.
- [ ] **Step 5:** Run `npx vitest run server/services/classEmails.test.js server/routes/tools.test.js server/routes/submissionComments.test.js`. Expected: PASS.
- [ ] **Step 6:** Commit: `refactor(tools): share the class emails helper; list a student's unread comments (#160)`.

### Task 6: Roster tab shell, Private details and the Roster card

**Files:**
- Create:
  - `client/src/lib/privateDetails.js`, `client/src/lib/privateDetails.test.js`
  - `client/src/components/roster/RosterTab.jsx`, `RosterCard.jsx`, `RosterFilters.jsx`, `AnchoredPopover.jsx`, `AlertPopover.jsx`, `CommentsPopover.jsx`, `CopyEmailsPopover.jsx`
  - `client/src/components/roster/RosterTab.test.jsx`, `RosterFilters.test.jsx`
- Modify: `client/src/pages/CoursePage.jsx` (:56-286, replace `RosterView` usage), `client/src/lib/psAlerts.js` (drop the old toggle), `client/src/app.css` (a `ROSTER` section)

**Interfaces:**
- Consumes: Task 3 `getAlertDetail`, Task 5 `getUnreadComments` and `getEmails(..., students)`, `getSupportSummary`, `getCourseCommentSummaries`, `PsAlertBadges` tones, `forRoster`.
- Produces:
  - `usePrivateDetails() → [on: boolean, setOn(bool)]`, key `prism:private-details`.
  - `<RosterTab course students mastery triage onTriageChanged onMasteryChanged courseId />`, which owns the mode via `useStickyTab('roster-mode', 'roster', { param: 'mode' })`.
  - `<AnchoredPopover anchor onClose>`: portalled, closes on Escape or an outside click, keeps a 16px gutter, opens above when there is no room below.
  - `rosterFilterOptions(students, unreadByStudent) → { alerts: [{ key, label, count }], followUp: [...] }` and `applyRosterFilters(students, selected:Set) → students` (any of), in `RosterFilters.jsx`'s companion `client/src/lib/rosterVitals.js` with tests.

- [ ] **Step 1:** Write the failing tests:
  - `privateDetails defaults off and survives a localStorage that throws`
  - `with Private details off, the Roster shows names, grade, student number and Email copy, and no comment count, alert, filter or Copy emails is in the DOM`
  - `with Private details on, each card shows its unread count and alert chips, and the filter bar shows Alerts and Follow up group pills`
  - `the Alerts group pill cycles none, all, none, and shows some when one pill is on; the status line reads "Showing 4 of 12 students"`
  - `turning Private details off closes an open pop-up and clears the filters`
  - `dropped students appear only behind "N dropped (show)" and are never counted or copied`
  - `a student without an email has no number and no Email button`
  - `tapping a card opens /student/:id; tapping Email copies the address and does not navigate`
- [ ] **Step 2:** Run `cd client && npx vitest run src/components/roster src/lib/privateDetails.test.js src/lib/rosterVitals.test.js`. Expected: FAIL.
- [ ] **Step 3:** Build the shell.
  - **Header:** the course name with the Private details pill beside it (left aligned; amber `aria-pressed` style), then the mode tabs with `.tab-btn`.
  - **Rail:** hide the triage rail when `view === 'roster'` (CoursePage `hidden` prop at :279-286), with the existing `Triage ▸` toggle extended to the roster tab.
  - **Card:** `.card`-style grid per the spec. Photo, then `nm` and the meta line (the timeline's trailing-dot pattern), then the comments count, then the alert chips.
  - **Filters:** the assessment page classes (`.assessment-filter-bar`, `button.group-pill`, `.filter-btn`, `.assessment-filter-status`, `button.filter-btn-clear`). Copy emails sits beside the count, and Clear all sits on the right.
  - **Pop-ups:** they open in `AnchoredPopover`. The alert chip calls `getAlertDetail`, showing `kind: 'rows'` as a table, text as a paragraph, and `none` as "Prism can read only that this alert is set." The comments count calls `getUnreadComments`.
  - **Copy emails:** Students or Guardians, the two `EMAIL_FORMATS` (export them from `ToolsPage.jsx` or move them to `client/src/lib/emailFormats.js`), a read-only preview, and "Copy N emails".
- [ ] **Step 4:** Run the tests again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(roster): private-by-default roster card, filters and pop-ups (#160)`.

### Task 7: Needs attention

**Files:**
- Create: `client/src/lib/needsAttention.js`, `client/src/lib/needsAttention.test.js`, `client/src/hooks/useTriageActions.js`, `client/src/components/roster/NeedsAttention.jsx`, `client/src/components/roster/NeedsAttention.test.jsx`
- Modify: `client/src/components/triage/TriageSection.jsx` (move its handlers into `useTriageActions`; behaviour unchanged)

**Interfaces:**
- Consumes: the `getTriage({ courseId })` result already loaded by CoursePage; `UrgencyRing`, `ExtendEditor`, `EmailMenu`, `ReferPanel`, `FlagsMenu`, `FlagDisc`; `cardLink(r)` (ResubmissionsPanel.jsx:27).
- Produces:
  - `studentRows(triage) → [{ studentId, rows: [{ key, kind, label, day, limit, tone, row }] }]`, sorted by each student's most urgent row. `kind` is one of `overdue | late_at_limit | make_up | resub_pending | resub_overdue | incomplete | absent`.
  - `useTriageActions({ onChanged }) → { record, refer, extend, extendMakeUp, extendResub, gradeStands, undo }`, the existing handlers with their modals.

- [ ] **Step 1: Write the failing tests** for `studentRows`:
  - **Late work:** `outstanding` → `overdue`; `submitted_late` with `tone === 'red'` → `late_at_limit`; `submitted_late` below the limit → excluded.
  - **Make-ups** → `make_up`.
  - **Resubmissions:** `state 'waiting'` → `resub_pending`, or `resub_overdue` when `tone === 'red'`; `state 'arrived'` → excluded.
  - **Flags:** `kind 'flag'` with `flag 2` → `incomplete`, `flag 5` → `absent`; flags 3 and 6 and `saved_grade` → excluded.
  - **Order:** within a student, red before amber before green, then the larger `day / limit` first. Students are ordered by their first row the same way.
  - **Labels**, the spec's words: "Overdue", "Late, handed in", "Make-up test", "Resubmission pending", "Resubmission overdue", "Incomplete", "Absent".
  - **Dropped students' rows** are excluded (pass the active student ids).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement `studentRows`. Then extract `useTriageActions` from `TriageSection.jsx`. The existing `TriageSection.test.jsx` must pass unedited.
- [ ] **Step 4:** Write `NeedsAttention.test.jsx` and build the component:
  - `locked when Private details is off`.
  - `a row links to /course/:id/assessment/:aid?student=:sid&filter=action`.
  - `overdue at the limit shows Refer and Extend; late at the limit shows Refer and Waive; a flag row shows FlagsMenu`.
  - `Refer then Undo calls the existing APIs`.
  - The headings: "Needs attention (N)" and "Everyone else (N)".
- [ ] **Step 5:** Run `cd client && npx vitest run src/lib/needsAttention.test.js src/components/roster/NeedsAttention.test.jsx src/components/triage`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(roster): Needs attention groups triage by student (#160)`.

### Task 8: NumberStepper steps

**Files:**
- Modify: `client/src/components/NumberStepper.jsx:7`
- Test: `client/src/components/NumberStepper.test.jsx` (create if absent)

**Interfaces:**
- Produces: `NumberStepper({ value, onChange, min = 1, max = 365, step = 1, suffix, ...rest })`. The buttons move by `step`. A typed value snaps to the nearest step, then is clamped. `suffix` is shown after the value ("min", "%").

- [ ] **Step 1:** Write the failing tests: `step 5 moves 50 to 55 and 45`; `a typed 52 with step 5 becomes 50`; `the default step 1 behaves as before`.
- [ ] **Step 2:** Run them, then implement, then run them again with the existing users' tests (`ExtendEditor`, the assessment card). Expected: PASS.
- [ ] **Step 3:** Commit: `feat(ui): NumberStepper takes a step and a suffix (#160)`.

### Task 9: Test day

**Files:**
- Create: `client/src/lib/testDay.js`, `client/src/lib/testDay.test.js`, `client/src/components/roster/TestDay.jsx`, `client/src/components/roster/TestDay.test.jsx`

**Interfaces:**
- Consumes: `gradebook.assignments` (CoursePage), Task 4's client calls, Task 3's `getAlertDetail` (for the student's first learning alert; it covers students without the Support Summary alert), `NumberStepper` with `step`.
- Produces:
  - `upcomingTests(assignments, today) → [{ schoologyAssignmentId, title, dueDate }]`: `is_test === 1`, published, not removed, due from today to 14 days ahead, nearest first.
  - `extraMinutes(length, percent) → number` (rounded to the nearest minute).
  - `planLine(rows) → string | null`: the first description that mentions time or %, else the first non-empty one.

- [ ] **Step 1: Write the failing tests:**
  - `upcomingTests` picks the nearest of two tests, and an empty window gives [].
  - `extraMinutes(50, 25)` is 13; `extraMinutes(50, 50)` is 25.
  - `planLine` follows its rule.
  - **Component:**
    - The picker and length show with Private details off, and the student list does not.
    - "No test" shows "No test is set in the next two weeks." and extra minutes still show.
    - **Confirmed** shows "63 minutes, 13 more" and **Change**.
    - **Suggested** (Support Summary text "Extended time (25%)") shows "Notes mention 25%", **Use 25%** and **Other**. **Use 25%** calls `setExtraTime(id, 25)`.
    - **None found** shows **Set extra time**.
    - A confirmed student causes no alert-detail read.
    - A failed read shows that student's error and the others still render.
    - Only learning alerts are listed; a health-only student is absent.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Card layout: the name column has a fixed width and the extra-time controls follow it, left aligned. The suggestion is `suggestedPercent` from `getAlertDetail`.
- [ ] **Step 4:** Run `cd client && npx vitest run src/lib/testDay.test.js src/components/roster/TestDay.test.jsx`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(roster): Test day lists each plan's extra time (#160)`.

### Task 10: Mastery

**Files:**
- Create: `client/src/lib/masteryCompare.js`, `client/src/lib/masteryCompare.test.js`, `client/src/components/roster/MasteryView.jsx`, `client/src/components/roster/MasteryView.test.jsx`
- Modify: `client/src/components/OverridePopup.jsx:16` (`suggestedLevel` prop), `client/src/components/MasteryPerformanceSummary.jsx` (export `LetterGradePopup` if needed)

**Interfaces:**
- Consumes: `getMasteryForCourse` data `{ categories, topics, scores, rollups, alignments }`, `useProficiencyScale`, `makeScaleHelpers`, `computeLetterGrade`, `OverridePopup`.
- Produces:
  - `categoryTracks(mastery) → [{ id, number, name, topics: [{ id, code, title }] }]`. Topics come from `alignments` so not-yet-assessed topics appear. `number` comes from `external_id` (the part after the last dot, else the order). `name` is the title without a leading "<prefix>: ".
  - `studentMastery(mastery, studentUid, scale) → { topics: { [topicId]: { pct, level } | null }, categories: { [catId]: { prism: {pct, level}, schoology: { level, isOverride } | null, differs } }, grade: { prism, schoology, differs } }`. Prism's category value is the flat mean of all the student's scores in that category's topics (CoursePage `categoryAvg`). Schoology's is `override_value ?? grade_scaled_rounded`.
  - `classMastery(mastery, studentUids, scale)`: the same shape, as means.
  - `nextSort(current, key) → { key, dir } | null`: cycles high to low, low to high, then off.
  - `OverridePopup({ ..., suggestedLevel })`: when it is set and differs from `currentLevel`, a primary "Override Schoology to {level}" button shows first.

- [ ] **Step 1: Write the failing tests:**
  - `categoryTracks` lists a topic with no scores.
  - The name for "AP CS: Content Knowledge" is "Content Knowledge" and its number is "1" from "APCS.1".
  - **Flat mean:** two topics with scores [100] and [50, 50, 50] give a mean of 62.5, not 75.
  - An override sets `isOverride`.
  - `differs` holds when the levels differ.
  - The grades differ when the category levels give different letters.
  - `nextSort` cycles.
  - **Component:**
    - Locked when off.
    - "No mastery data yet. Press Sync Course." with no categories.
    - The Schoology chip gets class `sgc` when it agrees and `sgc off` when it differs, with no "!" text.
    - The help dot sits in the Schoology heading.
    - Tapping a differing chip opens `OverridePopup` with `suggestedLevel` set to Prism's level.
    - The one-category view's heading sorts, and the status line reads "Sorted by 2.3 Abstraction, highest first." with **Clear sort**.
    - A linked-sections course disables the chip, with the existing reason.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement, following the spec's two layouts:
  - The category buttons read "1 - Content Knowledge".
  - The sticky header has no `overflow` ancestor.
  - The grade header reads "Grade" and "Schoology levels".
  - Hover text: "Schoology's levels give B; Prism's give B+", or "Schoology's levels give the same grade".
  - `LetterGradePopup` opens from a "Scale" link by the Grade header.
- [ ] **Step 4:** Run `cd client && npx vitest run src/lib/masteryCompare.test.js src/components/roster/MasteryView.test.jsx src/components`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(roster): Mastery compares Prism's levels with Schoology's (#160)`.

### Task 11: Remove the old roster, layout and docs

**Files:**
- Modify: `client/src/pages/CoursePage.jsx` (delete `RosterView` :294-644 and its local `HelpDot` if unused; keep the dropped disclosure in `RosterTab`), `client/src/app.css` (container queries in the ROSTER section; any device rule stays in `PHONE LAYOUT`), `docs/design-language.md`, `.claude/build-progress.md`, `docs/improvements-log.md`, `AGENTS.md` (Frontend Conventions: the roster's container queries)

- [ ] **Step 1:** Grep for leftovers and fix every hit: `RosterView`, `getRosterAlertsShown`, `show-ps-alerts`, `levelCellStyle`, "Computed Letter Grade", and the legal-name brackets. Update `docs/design-language.md`:
  - The roster card.
  - Private details and what it hides; rewrite "Projection safety" (:1444-1453).
  - Container queries.
  - The Schoology chip styles.
  - The filters reused from the assessment page.
- [ ] **Step 2:** Run `npm run dev` on its own port (`PORT=3002 npm run dev`, never by port kill), then `npm run check:mobile <the Vite URL the dev server prints>`. Expected: pass at phone and desktop. Check the roster in all four modes for any sideways page scroll at 390px. Stop the server with `PORT=3002 npm run dev:stop`. Delete any screenshots.
- [ ] **Step 3:** Commit: `refactor(roster): remove the old roster view; document the new one (#160)`.

### Task 12: Verify, ship and close

- [ ] **Step 1:** Run the root tests (`npx vitest run`), the client tests (`cd client && npx vitest run`) and the build (`npm run build`). Expected: all pass.
- [ ] **Step 2:** Push `main` (fast-forward). Confirm CI is green on the commit (`gh run list --branch main --limit 1`) and that prod serves it (`curl -s 127.0.0.1:3001/api/version` shows the sha).
- [ ] **Step 3:** Live check, with Graham:
  - **Override:** one override from the Mastery view on a student and category Graham names, then read it back. Clear it only if he asks.
  - **Alert pop-up:** one opened on prod for each readable alert type.
- [ ] **Step 4:** Close #160 with commit ids and evidence. Open the follow-ups the spec lists:
  - The student page (header, alerts, recent tasks, unread comments filter, absences).
  - Analytics.
  - Test day clock times.
  Comment on #39 (the absences slot, the lesson strip and the filter).
- [ ] **Step 5:** Update the project memory handoff (`project_state.md`): what shipped and what is next.
