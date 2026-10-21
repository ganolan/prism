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
  marks work late expecting it to still count gives the student a better grade, not a fair one.
- **Missing does not reach the standards.** Missing puts a 0 on the task, but the measurement-topic
  averages stay the same. In a standards-based gradebook, a student's levels stay the same when work
  is missing, and Insufficient Evidence appears nowhere.
- **Absent has no agreed meaning.** Some teachers use it for "this was their one chance", others as a
  reminder to follow up. Either way the task leaves the grade without any notice.
- **Nothing follows up.** A Late, Incomplete or Absent flag left in place raises the term grade, and no
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
