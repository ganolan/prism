// Submission-timeline parity: Prism's lateness (first submission vs the deadline,
// extensions applied) against Schoology's own late flag, for every submitted cell
// in active courses. Read-only (the DB is opened readonly). Disagreements are
// listed with the reason the two can differ: a Prism extension, or a first
// submission Prism saw that differs from the one Schoology judged.
//
// Run from the REPO ROOT:
//   DB_PATH=~/prism/data/students.db node scripts/parity-submission-timeline.js
import Database from 'better-sqlite3';
import { timelineContext } from '../server/services/submissionTimeline.js';

const db = new Database(process.env.DB_PATH || 'server/db/students.db', { readonly: true, fileMustExist: true });

const courses = db.prepare('SELECT id, course_name, block_number FROM courses WHERE archived = 0 AND excluded = 0').all();
const tally = { submitted: 0, agree: 0, prismLateOnly: 0, schoologyLateOnly: 0, unknown: 0, overdue: 0, overLimit: 0 };
const disagreements = [];
const dayHistogram = {};

for (const c of courses) {
  const ctx = timelineContext(db, { courseId: c.id });
  const rows = db.prepare(`
    SELECT g.*, a.id AS aid, a.title, a.due_date, a.is_lti_submission, a.accepts_submissions, a.is_test,
           s.first_name || ' ' || s.last_name AS name
    FROM grades g JOIN assignments a ON a.id = g.assignment_id JOIN students s ON s.id = g.student_id
    JOIN enrolments e ON e.student_id = s.id AND e.course_id = a.course_id AND e.dropped_at IS NULL
    WHERE a.course_id = ? AND a.published = 1 AND a.removed_at IS NULL AND a.due_date IS NOT NULL
  `).all(c.id);
  for (const r of rows) {
    const assignment = { id: r.aid, due_date: r.due_date, is_lti_submission: r.is_lti_submission, accepts_submissions: r.accepts_submissions, is_test: r.is_test };
    const t = ctx.timeline(assignment, r.student_id, r);
    if (t.overdue) { tally.overdue++; if (t.overdue.overLimit) tally.overLimit++; }
    if (t.submission.state !== 'submitted') continue;
    tally.submitted++;
    if (t.submission.late && t.submission.day) dayHistogram[t.submission.day] = (dayHistogram[t.submission.day] || 0) + 1;
    const prism = t.submission.late;
    const sgy = t.submission.schoologyLate;
    if (prism == null || sgy == null) { tally.unknown++; continue; }
    if (prism === sgy) { tally.agree++; continue; }
    if (prism) tally.prismLateOnly++; else tally.schoologyLateOnly++;
    disagreements.push({
      course: `${c.course_name}${c.block_number ? ` (Block ${c.block_number})` : ''}`, title: r.title, due: r.due_date,
      firstSubmitted: t.submission.firstAt ? new Date(t.submission.firstAt * 1000).toLocaleString('en-GB') : null,
      extension: t.extension ? `+${t.extension.schoolDays} -> ${t.extension.until}` : null,
      prismLate: prism, schoologyLate: sgy, day: t.submission.day,
    });
  }
}

console.log('Tally:', JSON.stringify(tally));
console.log('Late submissions by clock day:', JSON.stringify(dayHistogram));
console.log(`\nDisagreements (${disagreements.length}):`);
for (const d of disagreements) console.log(' ', JSON.stringify(d));
