#!/usr/bin/env node
// Live check (#66, read only against PowerSchool): run the plain-HTTP alert sync, which
// also reads each section's Emergency Contact List, against the database DB_PATH names
// (use a .backup copy, never prod). Then print counts only: lists read and failed,
// students with guardian slots, and per contact status the number of parent rows (and
// how many of them are the primary contact), how many parents have a PowerSchool phone,
// and how many have a PowerSchool email that differs from the Schoology email (#173; a
// parent with both set, compared trimmed and ignoring case). No names, emails or values.
// Usage: DB_PATH=/path/to/copy.db node scripts/parity-ps-guardians.js
import 'dotenv/config';
import { realpathSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { getDb } from '../server/db/index.js';
import { isMain } from '../server/lib/isMain.js';
import { syncPsAlerts } from '../server/services/psAlertsSync.js';
import { contactsForStudents } from '../server/services/guardianContactStore.js';

const PROD_DB = join(homedir(), 'prism', 'data', 'students.db');

// Is dbPath the production database? Follows symlinks when both paths exist (prod runs
// through symlinked release folders), otherwise compares the resolved paths.
export function isProdDb(dbPath, prodPath = PROD_DB) {
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
  const [a, b] = [real(dbPath), real(prodPath)];
  return a && b ? a === b : resolve(dbPath) === resolve(prodPath);
}

async function main() {
  if (!process.env.DB_PATH) { console.error('Set DB_PATH to a copy of the database.'); process.exit(1); }
  if (isProdDb(process.env.DB_PATH)) {
    console.error('DB_PATH is the production database. Use a .backup copy.');
    process.exit(1);
  }
  const db = getDb();
  const started = Date.now();
  const r = await syncPsAlerts({ db, onProgress: () => {} });
  console.log(`sync: ${((Date.now() - started) / 1000).toFixed(1)}s; courses ${r.processed} (read ${r.read}, failed ${r.failed}, skipped ${r.skipped}); students ${r.students}`);
  console.log(`guardian lists: read ${r.guardians.read}, failed ${r.guardians.failed}; students with slots ${r.guardians.students}`);

  const ids = db.prepare('SELECT DISTINCT student_id FROM parents').all().map((x) => x.student_id);
  const schoologyEmail = new Map(db.prepare('SELECT id, email FROM parents').all().map((p) => [p.id, p.email]));
  const key = (e) => String(e).trim().toLowerCase();
  const counts = new Map();
  let parentRows = 0;
  let uncertain = 0;
  let withPsPhone = 0;
  let emailDiffers = 0;
  for (const { byParent } of contactsForStudents(db, ids).values()) {
    for (const [parentId, contact] of byParent) {
      if (contact.ps?.phone) withPsPhone += 1;
      const sch = schoologyEmail.get(parentId);
      if (contact.ps?.email && sch && key(contact.ps.email) !== key(sch)) emailDiffers += 1;
      const c = counts.get(contact.status) ?? counts.set(contact.status, { n: 0, primary: 0 }).get(contact.status);
      c.n += 1;
      if (contact.primary) c.primary += 1;
      if (contact.uncertain) uncertain += 1;
      parentRows += 1;
    }
  }
  console.log(`parent rows by contact status (of ${parentRows}, ${ids.length} students):`);
  for (const status of ['contactable', 'do_not_contact', 'deceased', 'not_matched', 'not_checked']) {
    const c = counts.get(status) ?? { n: 0, primary: 0 };
    console.log(`  ${status}: ${c.n}${status === 'contactable' ? ` (primary ${c.primary})` : ''}`);
  }
  console.log(`  of which flagged from a slot no parent is placed in (uncertain): ${uncertain}`);
  console.log(`parents with a PowerSchool phone: ${withPsPhone}`);
  console.log(`parents whose PowerSchool email differs from the Schoology email: ${emailDiffers}`);
}

if (isMain(import.meta.url)) await main();
