#!/usr/bin/env node
// Live parity check for #141: the PowerSchool block pass (psAttendanceSync), browser
// vs plain HTTP, on real data. Read only against Schoology and PowerSchool (the LTI
// launch form POST is the session handshake the browser makes too); writes only to
// the two database copies named on the command line, never prod's.
//   "browser" = the pre-#141 pass, kept verbatim in scripts/lib/psAttendanceSyncBrowser.js
//   "http"    = the shipped pass (server/services/psAttendanceSync.js)
// Each runs the whole pass against its own copy; then the copies are diffed:
// per-course result (reason + block), courses.block_number, class_meetings,
// school_days (date, in_session, cycle letter, raw) and students.grad_year.
// Output is counts and wall times only: no course, student or section names or ids.
// Usage (repo root, two fresh copies of students.db made with sqlite3 .backup):
//   PRISM_SESSION_DIR=<copy of the session dir> node --env-file=.env scripts/parity-ps-blocks.js <browser.db> <http.db>
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { migrate } from '../server/db/index.js';
import { sessionStateFile } from '../server/lib/sessionPaths.js';
import { syncPsAttendanceBrowser } from './lib/psAttendanceSyncBrowser.js';
import { syncPsAttendance } from '../server/services/psAttendanceSync.js';

const [browserPath, httpPath] = process.argv.slice(2);
if (!browserPath || !httpPath || browserPath === httpPath) {
  console.error('usage: parity-ps-blocks.js <browser-copy.db> <http-copy.db>'); process.exit(1);
}
if (!existsSync(sessionStateFile())) { console.error('No saved session'); process.exit(1); }
// Each copy is blanked first (blocks, lesson dates, the PowerSchool calendar, grad
// years), so a pass that wrote nothing cannot match by leaving the copy as it was.
const open = (p) => {
  const db = new Database(p);
  migrate(db);
  db.exec(`UPDATE courses SET block_number = NULL, block_synced_at = NULL;
    DELETE FROM class_meetings; DELETE FROM school_days WHERE source = 'powerschool';
    UPDATE students SET grad_year = NULL;`);
  return db;
};
const dbs = { browser: open(browserPath), http: open(httpPath) };

// The passes log course names: keep them out of this script's output.
async function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}
const runs = {};
for (const [side, run] of [['browser', syncPsAttendanceBrowser], ['http', syncPsAttendance]]) {
  const started = Date.now();
  try {
    const summary = await quiet(() => run({ db: dbs[side], onProgress: () => {} }));
    runs[side] = { ms: Date.now() - started, summary };
  } catch (err) {
    runs[side] = { ms: Date.now() - started, error: err.message };
  }
  const r = runs[side];
  console.log(`${side}: ${(r.ms / 1000).toFixed(1)} s, ${r.error ? `FAILED (${r.error.replace(/\(.*\)/, '').trim()})`
    : `courses ${r.summary.processed} (updated ${r.summary.updated}, unchanged ${r.summary.unchanged}, skipped ${r.summary.skipped}); school days ${r.summary.schoolDays}; grade levels seen ${r.summary.gradeLevels.seen}, updated ${r.summary.gradeLevels.updated}${r.summary.gradeLevels.sources ? ` (sections by source ${JSON.stringify(r.summary.gradeLevels.sources)}, ${r.summary.gradeLevels.elapsedMs} ms)` : ''}`}`);
}
if (runs.browser.error || runs.http.error) { console.log('PARITY NOT RUN: a pass failed'); process.exit(1); }

const diffs = [];
const check = (label, same, detail) => { console.log(`  ${same ? 'same' : 'DIFF'}  ${label}${detail ? `: ${detail}` : ''}`); if (!same) diffs.push(label); };

// Per-course results: the reason bucket and the block chosen.
const key = (r) => `${r.reason}|${r.blockNumber ?? ''}`;
const byCourse = (s) => new Map(s.results.map((r) => [r.courseId, key(r)]));
const [rb, rh] = [byCourse(runs.browser.summary), byCourse(runs.http.summary)];
const ids = new Set([...rb.keys(), ...rh.keys()]);
const resultDiff = [...ids].filter((id) => rb.get(id) !== rh.get(id)).length;
const reasons = {};
for (const r of runs.http.summary.results) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
check('per-course result', resultDiff === 0, `${ids.size - resultDiff} of ${ids.size} match; http reasons ${JSON.stringify(reasons)}`);

const rows = (sql) => Object.fromEntries(Object.entries(dbs).map(([k, db]) => [k, db.prepare(sql).all()]));
const setOf = (list, f) => new Set(list.map(f));
const sameSets = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

const blocks = rows('SELECT id, block_number FROM courses ORDER BY id');
const blockDiff = blocks.browser.filter((r, i) => String(r.block_number ?? '') !== String(blocks.http[i]?.block_number ?? '')).length;
check('courses.block_number', blockDiff === 0, `${blocks.browser.length - blockDiff} of ${blocks.browser.length} courses match`);

const meet = rows('SELECT course_id, date FROM class_meetings ORDER BY course_id, date');
const mb = setOf(meet.browser, (r) => `${r.course_id}|${r.date}`);
const mh = setOf(meet.http, (r) => `${r.course_id}|${r.date}`);
check('class_meetings', sameSets(mb, mh), `${mb.size} vs ${mh.size} lesson dates across ${new Set(meet.http.map((r) => r.course_id)).size} courses`);

const days = rows("SELECT date, in_session, cycle_letter, raw FROM school_days WHERE source = 'powerschool' ORDER BY date");
const db_ = setOf(days.browser, (r) => `${r.date}|${r.in_session}|${r.cycle_letter}|${r.raw}`);
const dh = setOf(days.http, (r) => `${r.date}|${r.in_session}|${r.cycle_letter}|${r.raw}`);
check('school_days (date, in session, letter, raw)', sameSets(db_, dh), `${db_.size} vs ${dh.size} days, ${days.http.filter((r) => r.in_session).length} in session`);

const grads = rows('SELECT id, grad_year FROM students ORDER BY id');
const gradDiff = grads.browser.filter((r, i) => r.grad_year !== grads.http[i]?.grad_year).length;
const gb = runs.browser.summary.gradeLevels; const gh = runs.http.summary.gradeLevels;
check('students.grad_year', gradDiff === 0 && gb.seen === gh.seen, `${grads.browser.length - gradDiff} of ${grads.browser.length} students match; seen ${gb.seen} vs ${gh.seen}`);

console.log(`wall time: browser ${(runs.browser.ms / 1000).toFixed(1)} s, http ${(runs.http.ms / 1000).toFixed(1)} s`);
console.log(diffs.length ? `PARITY DIFFERS: ${diffs.join(', ')}` : 'PARITY OK');
process.exit(diffs.length ? 1 : 0);
