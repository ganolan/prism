# Improvements log

A running record of where Prism improves on the school's systems (Schoology, PowerSchool, and the work
teachers do by hand around them), written so it can be shown to school leaders. Newest first.

Each entry states:
- **Status quo:** what the school's systems do today.
- **The problem:** what that costs teachers, students or families.
- **What Prism does:** the improvement, in plain terms.
- **Evidence:** dated and checkable: a probe, a count, an issue, a commit.

Add an entry whenever a feature improves on the status quo (AGENTS.md, Definition of done). Describe the
systems as they are; never overstate.

---

## Schoology grade flags (#40, October 2026)

**Status quo.** Schoology offers five flags on a grade: Exempt, Late, Absent, Incomplete and Missing. A
teacher picks one from a small menu in the gradebook. Nothing explains what each flag does.

**The problem.** Tested on 21 October 2026 on HKIS's own account:
- **Flags delete grades.** Exempt, Late, Absent and Incomplete remove the score and every topic level.
  Missing replaces the score with 0. Clearing the flag does not bring the grade back. This is because the
  school's setting "keep grades with flags" is off, so Schoology's own gradebook behaves the same way.
- **Late does not mean late.** A Late flag removes the work from the grade while it is set. A teacher who
  marks work late expecting it to still count can give the student a better grade than the work earned.
- **Missing does not reach the standards on its own.** Missing puts a 0 on the task but writes nothing
  to the measurement topics. Work that was never handed in leaves the student's topic levels as they
  were: they show no Insufficient Evidence for it. (IE written first does count under Missing: tested
  on 22 October 2026.)
- **Absent has no agreed meaning.** Some teachers use it for "this was their one chance", others as a
  reminder to follow up. Either way the task leaves the grade without any notice.
- **Nothing follows up.** A Late, Incomplete or Absent flag left in place can raise the term grade, and no
  report reminds the teacher it is there.

**What Prism does.**
- **One Flags menu** on the assessment page, the gradebook and the student page, with a short line under
  each flag stating what it does in Schoology.
- **No lost grades:** before any flag removes a grade, Prism saves it, shows it grayed while the flag is
  set, and offers it back when the flag is cleared.
- **Clear symbols:** each flag has its own colored symbol in the gradebook, so a flag is never mistaken for
  a level.
- **Reasons for students and families:** an optional reason goes into the student's Schoology comment, for
  example "Marked exempt on Wed 21/10. Medical leave from 13 to 24 October."
- **Final flags and markers:** Exempt and Missing are final decisions. Late, Incomplete and Absent are
  markers: the teacher grades straight through them, and the work stays on the "feedback owed" list until
  it is graded.
- **No assumptions about Absent:** Prism changes nothing when Absent is set, so teachers who use it
  differently are all supported. The panel states the two usual next steps: a make-up date, or Exempt.
- **Tidy records:** Exempt withdraws Prism's open extensions, resubmission requests and referrals for that
  task.
- **Missing shows as IE** on every topic on the student page, so a conversation with the student starts
  from "no evidence".
- **Next:** a Triage panel for flags that need follow-up (#174), and a referral option that records IE on
  every topic and marks the work Missing in Schoology (#175).

**Evidence.**
- Live write probes on two archived 2024-25 Robotics records, each write approved by the teacher, both
  records restored exactly (21 October 2026): `.claude/schoology-api-reference.md`, "Grade exceptions
  (flags)".
- Schoology's own gradebook code, which removes the grade for any flag when the school setting is off
  (read on 21 October 2026).
- Design: `docs/superpowers/specs/2026-10-21-flags-excused-late-design.md`; issues #40, #174, #175.

## Guardian contact safeguards (#66, #173, October 2026)

**Status quo.** Schoology lists every guardian linked to a student. The marks "do not contact" and
"deceased" are held in PowerSchool only. Schoology does not carry them.

**The problem.** Prism copies guardian email addresses for a teacher (Copy all on the student page, and the
Parent emails list in Class Tools). A list built from Schoology alone could include a guardian who has died,
or one the school must not contact. The design for this work calls that a safeguarding risk.

**What Prism does.**
- **Reads PowerSchool's guardian list on every sync** and places each Prism parent in guardian slot 1 or 2,
  by email first and then by first name and surname.
- **Leaves flagged guardians out of every copy list and phone link.** Class Tools states how many guardians
  it did not copy.
- **Protects when unsure:** Prism treats any guardian it is unsure about as do-not-contact.
- **Follows PowerSchool:** a flag cleared there is cleared in Prism at the next sync. A failed read keeps the
  last known data and shows when it was read.
- **Keeps sensitive detail hidden:** a deceased guardian's card and a do-not-contact guardian's email stay
  hidden until the teacher selects Show alerts.
- **Shows PowerSchool's own email and phone** for each guardian beside the teacher's own additions.

**Evidence.**
- Read-only check on 21 October 2026 across 9 active sections, 110 student rows and 219 Prism parent records:
  188 parents matched one guardian slot by email, and 1 parent could not be placed and shows as "not
  matched". On that day, all 110 current students had these marks blank.
- Verified page shapes: `.claude/powerschool-api-reference.md`, "Guardian contacts (#66, verified
  2026-10-21)".
- Design: `docs/superpowers/specs/2026-10-21-do-not-contact-guardians-design.md`; build record:
  `.claude/build-progress.md`, "Do-not-contact guardians (#66, 2026-10-21)"; issues #66, #173, #42.

## Data from two systems, kept current (#171, #108, #52, October 2026)

**Status quo.** Schoology and PowerSchool each show their own data, live, in separate places. Course work,
submissions, grades and topic levels are in Schoology. Class blocks, the school calendar, student alerts and
guardian contacts are in PowerSchool.

**The problem.** The views a teacher needs across both systems exist in neither, so Prism holds a copy. A copy
helps only if its age is visible and it renews without effort. Before 19 October 2026 the submission data in
Prism's triage lists was as old as the last full sync, and Prism asked a teacher to follow up with a student who had
already submitted.

**What Prism does.**
- **One button, one nightly run:** Sync Courses reads everything, and a nightly run reads every course. A new
  installation reads all current courses on its first run, with no setup screen.
- **Pages renew themselves:** a page whose data is more than 10 minutes old starts a sync of its own data in
  the background. A read made less than 2 minutes ago is not repeated.
- **One time per page:** "Synced 10:05 today" turns amber when it is over a day old. The line for blocks,
  calendar and alerts turns amber after 26 hours.
- **Whole or nothing:** a time is recorded only when a sync fully succeeded, so a partial read never looks
  current. If the Schoology login has lapsed, Prism asks for a login instead of showing partial data.

**Evidence.**
- Full sync on 19 October 2026: 2 min 39 s for 10 sections and 2,566 records. A page-level read of the 10
  tasks on the dashboard took 9.2 s on 20 October 2026, and a repeat within 2 minutes took 0.06 s.
- A course's topic levels read in 2.3 to 5 s on 19 October 2026 (`.claude/build-progress.md`, "Mastery
  refreshed on demand after a page loads (#52, 2026-10-19)").
- Design: `docs/superpowers/specs/2026-10-20-background-sync-design.md` and
  `docs/superpowers/specs/2026-10-20-sync-simplified-design.md`; issues #171, #108, #52, #58.

## An AI grading assistant under teacher control (PrisMCP, #84, #131, October 2026)

**Status quo.** For each summative task, a teacher in Schoology enters a level on the General Academic Scale
for every measurement topic, and a comment for every student. Both are entered by hand.

**The problem.** A class of student work means one set of levels and one comment per student. An AI
assistant can draft these. If it wrote into the gradebook directly, unreviewed marks would reach students.

**What Prism does.**
- **A connection for an AI grading assistant** (called PrisMCP). The assistant reads the roster, the task's
  measurement topics, current levels and comments, and attached rubrics.
- **Suggestions only:** the assistant writes suggested levels and comments into Prism, where they show as a
  separate layer. Nothing reaches Schoology until the teacher reviews, edits and publishes.
- **Private by design:** Prism's own server hosts the connection, which is reached only on the teacher's
  private network. No other program opens the database.
- **Development copies are safe:** on a development copy of Prism, every result starts with a warning and writes to
  Schoology are refused.
- **The same connection answers questions** such as which students owe work or which tests await make-ups,
  counted in school days (see the entries below).

**Evidence.**
- Design (suggestions only, teacher publishes): `docs/superpowers/specs/2026-06-06-prismcp-server.md`; the
  first nine slices are issues #84 to #92, closed in June 2026.
- Move to the Prism server on 20 October 2026 (#131): 23 of 23 compared results identical to the earlier
  version, and all 36 tools covered (`.claude/build-progress.md`, "PrisMCP served by Prism over HTTP").
- Live on the production server, 20 October 2026: a first request forced a grading sync in 20.9 s, and a
  repeat within 5 minutes answered in 65 ms.

## Student alerts from PowerSchool, visible where teachers work (#117, #163, October 2026)

**Status quo.** PowerSchool's custom-alerts plugin shows an alert beside a student's name inside PowerSchool.
The catalog has 31 alert types, including accommodation plan, learning support level, allergies and EpiPen.

**The problem.** A teacher needs this in the moment, for example when setting a test, to see who has an
accommodation plan (issue #117). The alerts are in a different system from the one the teacher is working in.

**What Prism does.**
- **Reads the alerts on every sync** for all active courses and shows them as badges on the student page.
- **Hidden until asked:** the student page shows alerts only after the teacher selects Show alerts. The class
  roster shows learning, health and other alerts only, behind a toggle that is off by default. Family alerts
  never appear on a roster.
- **A badge states that a plan exists, not what it contains.** The Student Support Summary is read from
  PowerSchool when the teacher asks and is never stored.
- **Feature-flagged,** following the school's handling rules for personal data.
- **Available to the AI grading assistant** as labels for the teacher's own use.

**Evidence.**
- Read-only check on 17 October 2026 against a copy of the database: 9 of 9 active courses read, 96
  students, 6.2 s. A Support Summary read took 1.2 s, and a repeat from memory took 4 ms (18 October 2026).
- Verified page shapes: `.claude/powerschool-api-reference.md`, "Student alerts over plain HTTP (#117)" and
  "Alert pop-ups"; handling rules: `docs/adr/0002-pii-handling-philosophy.md`; issues #117, #163.

## Schoology writes that check before and after (#30, #46, October 2026)

**Status quo.** Schoology's grade update replaces the whole grade record. Its topic-level update replaces the
whole set of levels for a student on a task. A request that carries only the changed part clears the rest.
Schoology can also report success and save only part of a request.

**The problem.** In May 2026 Prism's first write path was affected by all of this:
- **A comment cleared the grade.** Saving only a comment cleared the grade and, on rubric-aligned tasks, the
  topic levels under it.
- **One topic cleared the others.** Saving a change to one topic cleared the rest.
- **Levels sent as letters were dropped.** Schoology reported success and saved only the levels sent as
  numbers.
- **Writes hid the work from students.** The "Display to student" box was cleared by every write.

**What Prism does.**
- **Reads fresh and sends everything back:** before a comment, Prism reads the current grade from Schoology and
  returns it unchanged. Every save sends the full set of topic levels.
- **Re-reads and refuses on change:** if the teacher changed the mark in Schoology after Prism last read it,
  Prism refuses to overwrite it.
- **Reads back after every write** and records what Schoology holds. Prism records a mark that
  Schoology did not save as failed.
- **Stops a batch at the first failure.**
- **Tests each new kind of write once, live,** on a target the teacher names and approves, and then reads it
  back. Verified kinds: grade comments and levels, status lines, unsubmit (3 October 2026), free-response
  marks (13 October 2026), submission comments with files (17 October 2026) and publish or unpublish of a task
  (18 October 2026).

**Evidence.**
- Issues #30 (closed 2 May 2026) and #46 (closed 7 May 2026) record the causes and the checks that confirmed
  each fix.
- The rule that a grade update replaces the record is documented in `.claude/schoology-api-reference.md`
  ("API Quirks"); the pattern is recorded in `AGENTS.md`, "Working Notes", and in `.claude/build-progress.md`,
  "Phase 5 Schoology Write-Back".

## Submission state and the work itself, in one place (#62, #119, #120, October 2026)

**Status quo.** At HKIS most summative tasks are OneDrive or Google Drive work (issue #62). For these,
Schoology's grader shows In Progress and Submitted tabs, one task at a time. The interface that other tools
use returns an empty list of revisions for every student on such a task, whether or not the student
submitted.

**The problem.** A teacher who wants to know who still owes work must open each task's grader. A tool built
on the public interface cannot distinguish unopened work from submitted work.

**What Prism does.**
- **Four states for OneDrive and Google Drive work:** Graded, Submitted, In Progress and Not Started, for the
  whole roster.
- **One rule everywhere** (19 October 2026): triage, the card badge, the filters, the timeline and the AI
  assistant all count the same signals as "submitted".
- **No accusations from missing data:** when the evidence is unclear, the state is "unknown" and the student stays
  off the owing list.
- **Questions across tasks:** the AI assistant can list who has not submitted a task, for one course or the
  whole school, with a ready address list for the teacher's email.
- **Opens the work:** a link from the gradebook, the assessment page and the student page opens the submitted
  file, and a submission's comment files open in the viewer.

**Evidence.**
- Issue #62 (7 June 2026): the new states matched the teacher's own knowledge of who had submitted on one
  Robotics task. The endpoints are recorded in `.claude/schoology-api-reference.md`.
- Rule: `CONTEXT.md`, "Submitted (one rule everywhere, 19 Oct 2026)"; issues #119, #120, #107, #162.

## Test results by question and free-response marking (October 2026)

**Status quo.** Schoology's public interface has no per-question data for tests (the developer documentation
was read on 12 October 2026). The export of results cuts a long answer at its first "<-", needs a two-step
form and emails the teacher once per export. A test and its extra-time copy are separate tests with separate
results.

**The problem.** A teacher who gives a test with multiple choice and free-response questions needs the
statistics per question, each free-response answer marked against a rubric, and an overall result on the
linked gradebook task. The export is unreliable for free-response answers.

**What Prism does.**
- **Combines a test with its extra-time copy** as one quiz, after checking that the questions match.
- **Shows per-question statistics:** percent correct by question, type and tag, and which wrong options drew
  students.
- **Marks free-response answers:** each student's answer sits beside a suggested rubric level and comment from
  the AI assistant. The teacher accepts or edits, then selects Publish all to Schoology.
- **Suggests the overall result** on the linked task: a level for each measurement topic, and a short comment
  that includes the numbers.
- **Links to each student's attempt** from the card, the gradebook and the student page.
- **Posts each mark safely:** Prism re-reads the attempt, refuses a mark the teacher changed in Schoology,
  posts it and reads it back.

**Evidence.**
- Test read of 12 October 2026 (read only), recorded in `.claude/schoology-api-reference.md`, "Questions, attempts
  and FRQ rubrics". Design: `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md`.
- Check on 13 October 2026 with two AP CSP classes: 21 questions each (20 multiple choice, 1 free response), 6
  and 9 attempts loaded, 0 failed.
- Test writes of a mark were approved by the teacher on an archived 2024-25 attempt and restored. Afterward
  every field equaled the earlier capture (`.claude/build-progress.md`, "Linked quizzes, phase 4b" and "4c").
  At that date no current-year mark had been posted.

## A student's history across years, for reference letters (October 2026)

**Status quo.** Schoology keeps each course as its own section, and a past year's courses are on a separate
page (`/courses/mycourses/past`). Levels, topic ratings and teacher comments are held course by course.

**The problem.** A reference letter needs a student's levels and the teacher's comments across every course
and year. Gathering them from Schoology means visiting each course.

**What Prism does.**
- **Finds a student** across all courses, archived ones included, by name, email or ID.
- **Returns the full history** for each course and year: overall level, level for each topic, and the
  teacher's published comment word for word. AI suggestions are never included.
- **Leaves out lateness on purpose:** Schoology's late flag ignores extensions and marks resubmitted work late,
  so it overstates lateness.

**Evidence.**
- 12 archived computer science sections from 2023-24 and 2024-25 were imported on 8 October 2026: 173
  enrollments, all with scores and verbatim comments, 11 sections with per-topic levels. One section (AP CSP
  2023-24) has no per-topic data in Schoology.
- Design and record: `docs/superpowers/specs/2026-10-08-prismcp-student-history-design.md`;
  `.claude/build-progress.md`, "PrisMCP student history".

## Resubmissions with a deadline and a visible status (#49, October 2026)

**Status quo.** A teacher can ask a student to redo work. Nothing in Schoology reminds the teacher of
the request. Schoology's revision history exists, but it is not prominent. Schoology's Incomplete and Missing
flags remove the grade (see the flags entry). For OneDrive work, a student cannot resubmit after the due date
until the teacher selects Unsubmit.

**The problem.** The teacher can forget the request, or miss that the student has resubmitted.

**What Prism does.**
- **Ask to resubmit with a deadline** in school days (3 by default, adjustable). The request waits on the
  Resubmissions list and turns amber, then red, as the deadline passes. It stays until resolved.
- **Notices arrivals automatically,** including OneDrive work, and a teacher's Unsubmit made in Schoology.
- **Writes a plain status line** in the student's Schoology comment, for example "Resubmission requested - due
  Thu 08/10." The teacher confirms once, and Prism replaces only its own line.
- **Unsubmits OneDrive work on request** so the student can resubmit. If that fails, the row links to
  Schoology's own Unsubmit button.
- **No silent outcomes:** an arrived resubmission stays listed until the feedback the student sees has
  changed, or the teacher records "Grade stands", which posts a line to the student.

**Evidence.**
- Design: `docs/superpowers/specs/2026-10-03-triage-resubmissions-design.md` and
  `docs/superpowers/specs/2026-05-17-resubmission-tracking-design.md`; issues #49, #53, #125.
- Unsubmit verified live on one archived task, with the teacher's approval: submitted to in progress in 5.7 s
  (`.claude/build-progress.md`, 19 October 2026).

## Make-up tests (October 2026)

**Status quo.** Schoology lists each assigned student's attempts on a results page for each test. The public
interface returns no attempt data for tests.

**The problem.** A student who missed a test must take it, or its extra-time copy, soon after the class, or the
test may be invalidated for that student (triage design, 2 October 2026). Finding these students means
opening the results page of every test.

**What Prism does.**
- **Lists each student who missed a test** across all of a teacher's courses, with a clock in school days:
  green on the test day, amber one school day after and red three school days after (adjustable).
- **Handles extra-time copies:** a student assigned the other copy is not listed for this one.
- **Lists only on evidence:** a student appears only when the last good read shows no attempt and a blank score.
  A failed read appears as "Couldn't check N tests" and not as "missed".
- **Records a new date:** the teacher records when the student will take the test, and the row clears itself
  when the attempt appears.
- **Ignores chosen tests,** such as formative quizzes, for all students.

**Evidence.**
- Read-only test read of 2 October 2026 on AP CSP tests and their extra-time copies, recorded in
  `.claude/schoology-api-reference.md`, "Did the student take the test?".
- Design: `docs/superpowers/specs/2026-10-01-triage-late-work-and-feedback-owed-design.md`, "Make-up tests
  (added 2026-10-02)".

## Late work and feedback owed, counted in school days (#63, #137, October 2026)

**Status quo.** HKIS policy, as recorded in the triage design of 1 October 2026, is that summative work
arriving 8 or more school days after its due date is referred to the academic office. Students should receive
feedback within about two weeks. Schoology's Reminders panel shows a headline count of ungraded submissions
(233 on 30 May 2026) and, in a detail view, a count for each task (39 tasks). Neither lists the students.

**The problem.** A teacher must find, across courses, which students are close to the referral limit and
which tasks have waited longest for feedback. Counting school days by hand means checking the school calendar.

**What Prism does.**
- **A Late work list** of students approaching the referral limit, with a green, amber or red clock in school
  days, and a record of each referral. A teacher can extend one student's deadline.
- **A Feedback owed list** of tasks with submitted, ungraded work, longest wait first, with the count owed out
  of the count submitted. The limit is 10 school days by default, and both limits are adjustable in Settings.
- **School days come from PowerSchool's calendar,** so holidays and non-teaching days are not counted. When a
  date is outside the stored calendar, Prism counts weekdays and labels the number "approx".
- **Email in one step:** each list can copy the addresses of the students shown, without repeats, ready to
  paste into Outlook, and each row has an email link.
- **A summary strip** on the dashboard shows how many are at the referral limit and how many
  make-ups, resubmissions and feedback items are overdue.

**Evidence.**
- Comparison of 1 and 2 October 2026 against the school's Master Plan workbook: PowerSchool's in-session flag
  marks that the school year is active, not that classes meet, and counted 220 days where the Master Plan has
  164 school days. Prism now counts a day only when classes meet. The result is 165 against 164, and the one
  difference is a half day that PowerSchool treats as a school day (`.claude/build-progress.md`, "Triage").
- The Reminders figures are from a read-only test read of 30 May 2026 (`.claude/schoology-api-reference.md`,
  "Three high-priority surfaces"); issue #63 records why a separate page was not needed.
- Design and record: `docs/superpowers/specs/2026-10-01-triage-late-work-and-feedback-owed-design.md`,
  `docs/superpowers/specs/2026-10-04-triage-email-and-stats-design.md`; issues #63, #137.
