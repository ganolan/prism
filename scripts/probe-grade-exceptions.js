// Live probe of Schoology grade exceptions (#40): what Exempt (1) and Late (6) do to a
// grade record through the public bulk PUT /sections/{id}/grades, and how a flag clears.
//
// DEFAULT IS READ-ONLY: prints the pair's three views of the grade:
//   1. the public grade record (GET /sections/{id}/grades?assignment_id=),
//   2. its mastery observations (district_mastery observations search, per student),
//   3. its gradebook cell (GET /iapi/grades/grader_grade_data/{section}/all), which shows any
//      field the public record lacks.
// A WRITE runs only with CONFIRM=<op>:<assignmentId>:<enrollmentId> matching the arguments,
// after the teacher's explicit go-ahead on that target. Every field the op does not change is
// echoed from a fresh read (the #46 rule), the raw answer is printed, then the three views again.
//
// ops: excused | excused-nullgrade | incomplete | missing | absent | late (6) | late4 (code 4 is invalid: expect a 400 entry) | clear0 | clearnull | bulk-invalid |
//      restore (RESTORE='{"grade":…,"exception":…,"comment":…,"comment_status":…}')
//
// Usage: node scripts/probe-grade-exceptions.js <sectionId> <assignmentId> <enrollmentId> <uid>
//        CONFIRM=excused:<assignmentId>:<enrollmentId> node scripts/probe-grade-exceptions.js …
import 'dotenv/config';

process.env.DB_PATH = ':memory:';
const [sectionId, aid, enrollmentId, uid] = process.argv.slice(2);
if (!sectionId || !aid || !enrollmentId || !uid) {
  console.error('usage: <sectionId> <assignmentId> <enrollmentId> <uid>');
  process.exit(1);
}
const OPS = ['excused', 'excused-nullgrade', 'incomplete', 'missing', 'absent', 'late', 'late4', 'clear0', 'clearnull', 'bulk-invalid', 'restore'];
const [op, cAid, cEnr] = String(process.env.CONFIRM || '').split(':');
const confirmed = OPS.includes(op) && cAid === aid && cEnr === enrollmentId;

const { getAssignmentGrades, pushGradeComments } = await import('../server/services/schoology.js');
const { getRubricScoresForStudent } = await import('../server/services/masterySync.js');
const { cookieJar, getJson } = await import('../server/services/schoologyWeb.js');

const show = (label, value) => console.log(`${label}: ${JSON.stringify(value, null, 1)}`);

// The first object anywhere in `node` that names this student and this grade item.
function findCell(node) {
  if (!node || typeof node !== 'object') return null;
  if (String(node.uid) === uid && String(node.grade_item_nid ?? node.grade_item_id ?? '') === aid) return node;
  for (const v of Object.values(node)) {
    const hit = findCell(v);
    if (hit) return hit;
  }
  return null;
}

async function views(label) {
  console.log(`\n=== ${label} ===`);
  const rows = await getAssignmentGrades(sectionId, aid);
  const record = rows.find((g) => String(g.enrollment_id) === enrollmentId) || null;
  show('public record', record);
  try {
    const obs = await getRubricScoresForStudent({ sectionId, studentUid: uid, assignmentId: aid });
    show('mastery observations', obs);
  } catch (err) {
    console.log(`mastery observations: read failed (${err.message})`);
  }
  const jar = cookieJar();
  if (jar) {
    const r = await getJson(jar, `/iapi/grades/grader_grade_data/${encodeURIComponent(sectionId)}/all?uids=${uid}&grade_item_nids=${aid}`);
    show(`gradebook cell (HTTP ${r.status})`, findCell(r.json));
  } else {
    console.log('gradebook cell: no saved session');
  }
  return record;
}

const before = await views('before');
if (!confirmed) {
  console.log(`\nRead-only. To write: CONFIRM=<${OPS.join('|')}>:${aid}:${enrollmentId}`);
  process.exit(0);
}

// The echo: every field of the fresh record, unchanged.
const echo = {
  assignment_id: aid,
  enrollment_id: enrollmentId,
  comment: before?.comment ?? '',
  comment_status: before?.comment_status ?? null,
};
if (before?.grade != null) echo.grade = String(before.grade);
if (before?.exception != null) echo.exception = before.exception;

let entries;
switch (op) {
  case 'excused': entries = [{ ...echo, exception: 1 }]; break;
  case 'excused-nullgrade': entries = [{ ...echo, exception: 1, grade: null }]; break;
  case 'incomplete': entries = [{ ...echo, exception: 2 }]; break;
  case 'missing': entries = [{ ...echo, exception: 3 }]; break;
  case 'absent': entries = [{ ...echo, exception: 5 }]; break;
  case 'late': entries = [{ ...echo, exception: 6 }]; break;
  case 'late4': entries = [{ ...echo, exception: 4 }]; break;
  case 'clear0': entries = [{ ...echo, exception: 0 }]; break;
  case 'clearnull': entries = [{ ...echo, exception: null }]; break;
  case 'bulk-invalid': entries = [{ ...echo }, { ...echo, enrollment_id: '1' }]; break;
  case 'restore': {
    const saved = JSON.parse(process.env.RESTORE || 'null');
    if (!saved) { console.error('restore needs RESTORE=<json>'); process.exit(1); }
    entries = [{ assignment_id: aid, enrollment_id: enrollmentId, ...saved }];
    break;
  }
  default: process.exit(1);
}
show(`\nPUT (${op})`, entries);
const result = await pushGradeComments(sectionId, entries);
show('answer', { status: result?.status, data: result?.data });
await views('after');
