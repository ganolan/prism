// Live probe for #179: does a grade write sent through a linked set's PARENT section reach a
// student enrolled in a CHILD section? (Linked sections share task ids; /grades is per section,
// verified 2026-10-23.)
//
// DEFAULT IS READ-ONLY.
//   node scripts/probe-linked-section-write.js <parentSection> <childSection>
//     lists child-section grade rows that have a grade (candidates).
//   node scripts/probe-linked-section-write.js <parentSection> <childSection> <assignmentId> <enrollmentId>
//     prints that pair's record as the child section's /grades and the parent section's /grades show it.
// A WRITE runs only with CONFIRM=<op>:<assignmentId>:<enrollmentId> matching the arguments, after the
// teacher's explicit go-ahead on that target:
//   comment-via-parent  PUT /sections/{parent}/grades with the pair's fresh record echoed (#46) and a
//                       marker line added to the comment; then both views again.
//   restore-via-parent | restore-via-child  PUT the RESTORE='{"grade":…,"comment":…,"comment_status":…,"exception":…}'
//                       record through that section; then both views again.
// Run from the repo root (it needs the repo's node_modules and .env). The server's linked-set write
// guard is not installed in a script, so the PUT goes out as written.
import 'dotenv/config';

process.env.DB_PATH = ':memory:';
const [parent, child, aid, enrollmentId] = process.argv.slice(2);
if (!parent || !child) {
  console.error('usage: <parentSection> <childSection> [<assignmentId> <enrollmentId>]');
  process.exit(1);
}
const { getSectionGrades, getAssignmentGrades, pushGradeUpdates } = await import('../server/services/schoology.js');
const show = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
const pick = (r) => r && { grade: r.grade, exception: r.exception, comment: r.comment, comment_status: r.comment_status, timestamp: r.timestamp };

if (!aid) {
  const rows = (await getSectionGrades(child)).filter((r) => r.grade != null && r.grade !== '');
  console.log(`child ${child}: ${rows.length} graded rows. First 5 (assignment_id, enrollment_id, grade, has comment):`);
  for (const r of rows.slice(0, 5)) console.log(` ${r.assignment_id} ${r.enrollment_id} ${r.grade} ${r.comment ? 'yes' : 'no'}`);
  process.exit(0);
}

async function views(label) {
  const viaChild = (await getAssignmentGrades(child, aid)).find((r) => String(r.enrollment_id) === enrollmentId) || null;
  const viaParent = (await getAssignmentGrades(parent, aid)).find((r) => String(r.enrollment_id) === enrollmentId) || null;
  show(`${label}: child /grades`, pick(viaChild));
  show(`${label}: parent /grades`, pick(viaParent));
  return viaChild;
}

const before = await views('before');
const [op, cAid, cEnr] = String(process.env.CONFIRM || '').split(':');
const OPS = ['comment-via-parent', 'restore-via-parent', 'restore-via-child'];
if (!(OPS.includes(op) && cAid === aid && cEnr === enrollmentId)) {
  if (before) show('RESTORE value for this pair', { grade: before.grade ?? null, exception: before.exception ?? 0, comment: before.comment ?? '', comment_status: before.comment_status ?? null });
  console.log(`\nRead-only. To write: CONFIRM=<${OPS.join('|')}>:${aid}:${enrollmentId}`);
  process.exit(0);
}

let section;
let entry;
if (op === 'comment-via-parent') {
  if (!before) { console.error('no record for this pair in the child section'); process.exit(1); }
  section = parent;
  entry = {
    assignment_id: aid,
    enrollment_id: enrollmentId,
    comment: `${before.comment ? `${before.comment}\n\n` : ''}Prism check (#179), removed shortly.`,
    comment_status: before.comment_status ?? null,
  };
  if (before.grade != null) entry.grade = String(before.grade);
  if (before.exception != null) entry.exception = before.exception;
} else {
  const saved = JSON.parse(process.env.RESTORE || 'null');
  if (!saved) { console.error('restore needs RESTORE=<json>'); process.exit(1); }
  section = op === 'restore-via-child' ? child : parent;
  entry = { assignment_id: aid, enrollment_id: enrollmentId, ...saved };
  if (entry.grade != null) entry.grade = String(entry.grade);
}
show(`\nPUT /sections/${section}/grades (${op})`, entry);
const result = await pushGradeUpdates(section, [entry]);
show('answer', { status: result?.status, data: result?.data });
await views('after');
