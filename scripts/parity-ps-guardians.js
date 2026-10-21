#!/usr/bin/env node
// Live check (#66, read only against PowerSchool): run the plain-HTTP alert sync, which
// also reads each section's Emergency Contact List, against the database DB_PATH names
// (use a .backup copy, never prod). Then print counts only: lists read and failed,
// students with guardian slots, and per contact status the number of parent rows (and
// how many of them are the primary contact). No names, emails or values.
// Usage: DB_PATH=/path/to/copy.db node scripts/parity-ps-guardians.js
import 'dotenv/config';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { getDb } from '../server/db/index.js';
import { syncPsAlerts } from '../server/services/psAlertsSync.js';
import { contactsForStudents } from '../server/services/guardianContactStore.js';

if (!process.env.DB_PATH) { console.error('Set DB_PATH to a copy of the database.'); process.exit(1); }
if (resolve(process.env.DB_PATH) === join(homedir(), 'prism', 'data', 'students.db')) {
  console.error('DB_PATH is the production database. Use a .backup copy.');
  process.exit(1);
}
const db = getDb();
const started = Date.now();
const r = await syncPsAlerts({ db, onProgress: () => {} });
console.log(`sync: ${((Date.now() - started) / 1000).toFixed(1)}s; courses ${r.processed} (read ${r.read}, failed ${r.failed}, skipped ${r.skipped}); students ${r.students}`);
console.log(`guardian lists: read ${r.guardians.read}, failed ${r.guardians.failed}; students with slots ${r.guardians.students}`);

const ids = db.prepare('SELECT DISTINCT student_id FROM parents').all().map((x) => x.student_id);
const counts = new Map();
let parentRows = 0;
for (const { byParent } of contactsForStudents(db, ids).values()) {
  for (const { status, primary } of byParent.values()) {
    const c = counts.get(status) ?? counts.set(status, { n: 0, primary: 0 }).get(status);
    c.n += 1;
    if (primary) c.primary += 1;
    parentRows += 1;
  }
}
console.log(`parent rows by contact status (of ${parentRows}, ${ids.length} students):`);
for (const status of ['contactable', 'do_not_contact', 'deceased', 'not_matched', 'not_checked']) {
  const c = counts.get(status) ?? { n: 0, primary: 0 };
  console.log(`  ${status}: ${c.n}${status === 'contactable' ? ` (primary ${c.primary})` : ''}`);
}
