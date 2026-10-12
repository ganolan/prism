// Live parity check (AGENTS.md: a parity probe is the verification of choice for
// API-shape work). Compares Prism's per-question MCQ counts for one or more loaded quiz
// groups with csp-tools' item_analysis.csv for the same test, built from the CSV exports.
// The CSV merges every section of the test, so pass every group id that makes up the test:
// Prism's correct/total are summed across the groups by question position.
// Read-only.
// Usage: DB_PATH=<abs path> node scripts/parity-quiz-results.js "<item_analysis.csv>" <groupId> [<groupId>...]
// CSV columns used: question (position), n (takers), facility (correct / n).
import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { getDb } from '../server/db/index.js';
import { groupStats } from '../server/services/quizStats.js';

const [csvPath, ...ids] = process.argv.slice(2);
if (!csvPath || !ids.length) {
  console.error('Usage: node scripts/parity-quiz-results.js <item_analysis.csv> <groupId> [<groupId>...]');
  process.exit(1);
}
const db = getDb();
const rows = parse(readFileSync(csvPath, 'utf8'), { columns: true, bom: true });
console.log('CSV columns:', Object.keys(rows[0] || {}).join(', '));

const sums = new Map(); // position -> { correct, total }
for (const id of ids) {
  const stats = groupStats(db, { groupId: Number(id) });
  console.log(`group ${id}: ${stats.takers} takers, ${stats.mcq.count} MCQ`);
  for (const q of stats.questions.filter(x => x.kind === 'mcq')) {
    const s = sums.get(q.position) || { correct: 0, total: 0 };
    s.correct += q.correct;
    s.total += q.total;
    sums.set(q.position, s);
  }
}

let mismatches = 0;
for (const [position, prism] of [...sums].sort((a, b) => a[0] - b[0])) {
  const row = rows.find(r => Number(r.question) === position);
  if (!row) { console.log(`Q${position}: not in the CSV`); mismatches++; continue; }
  const csvTotal = Number(row.n);
  const csvCorrect = Math.round(Number(row.facility) * csvTotal);
  const same = csvCorrect === prism.correct && csvTotal === prism.total;
  if (!same) mismatches++;
  console.log(`Q${position}: Prism ${prism.correct}/${prism.total}, CSV ${csvCorrect}/${csvTotal}${same ? '' : '  <-- differs'}`);
}
for (const r of rows) if (!sums.has(Number(r.question))) console.log(`Q${r.question}: in the CSV only (not an MCQ in Prism)`);
console.log(mismatches ? `${mismatches} question(s) differ` : 'All MCQ counts match');
process.exit(mismatches ? 1 : 0);
