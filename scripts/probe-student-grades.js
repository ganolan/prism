#!/usr/bin/env node
// Read-only probe (2026-10-08, student-history spec): one student's grades and
// grade comments in an archived section, straight from the public REST API.
// GETs only. Usage:
//   node --env-file=<.env> scripts/probe-student-grades.js <uid> <sectionId> [...]
import { getSection, getSectionAssignments, getSectionGrades, getSectionEnrollments, getSectionGradingScales } from '../server/services/schoology.js';

const [uid, ...sectionIds] = process.argv.slice(2);
for (const sid of sectionIds) {
  const sec = await getSection(sid);
  const enr = (await getSectionEnrollments(sid)).find((e) => String(e.uid) === String(uid));
  const asg = Object.fromEntries((await getSectionAssignments(sid)).map((a) => [String(a.id), a]));
  const grades = (await getSectionGrades(sid)).filter((g) => enr && String(g.enrollment_id) === String(enr.id));
  const scales = await getSectionGradingScales(sid).catch(() => null);
  console.log(JSON.stringify({
    section: { id: sid, title: `${sec.course_title} ${sec.section_title}`, active: sec.active, grading_periods: sec.grading_periods },
    enrolment: enr ? { id: enr.id, status: enr.status, name: enr.name_display } : null,
    scales: scales ? JSON.stringify(scales).slice(0, 600) : null,
    grades: grades.map((g) => ({
      assignment_id: g.assignment_id, title: asg[String(g.assignment_id)]?.title, due: asg[String(g.assignment_id)]?.due,
      type: asg[String(g.assignment_id)]?.type, scale: asg[String(g.assignment_id)]?.grading_scale, category: asg[String(g.assignment_id)]?.grading_category,
      grade: g.grade, max_points: g.max_points, exception: g.exception, comment: g.comment, comment_status: g.comment_status, timestamp: g.timestamp,
    })),
  }, null, 1));
}
