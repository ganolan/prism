// Live check for linked quizzes phase 1 (run from the repo root, never against prod).
// Combines each Ep 1 theory test with its extra-time copy, links the Result task, loads
// the results from Schoology (GET only), applies the CSV question codes as tags and
// prints counts. Prints no student names and no answer text.
//
// Usage (dev clone only; the DB is disposable, restore it first with `npm run db:refresh`):
//   DB_PATH=<abs dev db> PRISM_SESSION_DIR=<abs session dir> \
//   node scripts/verify-quiz-phase1.js [<item_analysis.csv for BK 6>] [<item_analysis.csv for BK 7>]
// The CSV is optional; with it, each group's questions are tagged from its `codes` column.
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { homedir } from 'os';
import { join, resolve, sep } from 'path';
import { getDb } from '../server/db/index.js';
import { resolveAssignment, createGroup, linkResult, groupForAssignment, setQuestionTags, attemptLinks } from '../server/services/quizGroups.js';
import { readQuestionLists, loadGroup } from '../server/services/quizLoader.js';
import { groupStats } from '../server/services/quizStats.js';

if (!process.env.DB_PATH) { console.error('Set DB_PATH to the dev clone database.'); process.exit(2); }
// Prod keeps its data and releases under ~/prism/ on the mini; dev clones live elsewhere.
const prodRoot = join(homedir(), 'prism') + sep;
if (resolve(process.env.DB_PATH).startsWith(prodRoot)) { console.error(`Refusing to run against ${prodRoot} (prod).`); process.exit(2); }

const TESTS = [
  { label: 'BK 6', members: ['8544307969', '8603667595'], result: '8544307980' },
  { label: 'BK 7', members: ['8544307924', '8602127760'], result: '8544307944' },
];
const csvArgs = process.argv.slice(2);

function tagsFromCsv(path) {
  const rows = parse(readFileSync(path, 'utf8'), { columns: true, bom: true });
  const tags = {};
  for (const r of rows) tags[Number(r.question)] = String(r.codes || '').split(';').map(s => s.trim()).filter(Boolean);
  return tags;
}

const db = getDb();
const groupIds = [];
for (const [i, t] of TESTS.entries()) {
  console.log(`\n== ${t.label} ==`);
  let group = groupForAssignment(db, t.members[0]);
  if (group) {
    console.log(`reusing group ${group.id}`);
  } else {
    const courseId = resolveAssignment(db, t.members[0]).course_id;
    const questionLists = await readQuestionLists(db, { assignmentRefs: t.members });
    group = createGroup(db, { courseId, assignmentRefs: t.members, questionLists });
    console.log(`created group ${group.id} (${questionLists.map(l => l.questions.length).join(' + ')} questions across copies)`);
  }
  if (!group.result) group = linkResult(db, { groupId: group.id, resultRef: t.result });
  console.log(`linked result task ${group.result.schoology_assignment_id}; parity ${group.parity_status || 'n/a'}`);
  groupIds.push(group.id);
  const summary = await loadGroup(db, { groupId: group.id });
  console.log('load summary:', JSON.stringify({
    attempts: summary.attempts, notTaken: summary.notTaken, failed: summary.failed.length,
    unknownUids: summary.unknownUids.length, mismatches: summary.mismatches.length, multipleAttempts: summary.multipleAttempts.length,
  }));
  if (summary.failed.length) console.log('failed reasons:', summary.failed.map(f => f.reason).join(' | '));
  if (summary.mismatches.length) console.log('mismatch kinds:', [...new Set(summary.mismatches.map(m => m.kind || m.type || 'unknown'))].join(', '));
  if (csvArgs[i]) console.log('tags set:', JSON.stringify(setQuestionTags(db, { groupId: group.id, tags: tagsFromCsv(csvArgs[i]) })));
  const s = groupStats(db, { groupId: group.id });
  console.log(`takers ${s.takers} of class ${s.classSize}; by member ${s.byMember.map(m => m.takers).join('/')}`);
  console.log(`questions ${s.questions.length} (mcq ${s.mcq.count}, frq ${s.frq.count}); mcq median ${s.mcq.median_percent}%`);
  console.log('frq levels:', JSON.stringify(s.frq.levels));
  for (const ref of [...t.members, t.result]) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM quiz_attempts qa JOIN assignments a ON a.id = qa.assignment_id WHERE qa.group_id = ? AND a.schoology_assignment_id = ?`).get(group.id, ref).n;
    console.log(`attempts stored for member ${ref}: ${n}`);
  }
  console.log(`attempt links via result task ${t.result}: ${Object.keys(attemptLinks(db, { assignmentRef: t.result })).length}`);
}
console.log('\ngroup ids:', groupIds.join(' '));
