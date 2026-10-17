#!/usr/bin/env node
// Live check (#117, read only against PowerSchool): run the plain-HTTP alert sync
// against the database DB_PATH names (use a .backup copy, never prod), then print
// counts only: per course, students read; per alert, students it fires for; and
// how many students have each contact field set. No names, no values.
// Usage: DB_PATH=/path/to/copy.db node scripts/parity-ps-alerts.js
import 'dotenv/config';
import { getDb } from '../server/db/index.js';
import { syncPsAlerts } from '../server/services/psAlertsSync.js';

if (!process.env.DB_PATH) { console.error('Set DB_PATH to a copy of the database.'); process.exit(1); }
const db = getDb();
const started = Date.now();
const r = await syncPsAlerts({ db, onProgress: () => {} });
console.log(`sync: ${((Date.now() - started) / 1000).toFixed(1)}s; courses ${r.processed} (read ${r.read}, failed ${r.failed}, skipped ${r.skipped}); students ${r.students}, with alerts ${r.withAlerts}`);
for (const x of r.results) console.log(`  ${x.courseName}: ${x.status}${x.students != null ? ` ${x.students}` : ''}${x.reason ? ` (${x.reason})` : ''}`);
console.log('alerts (students):');
for (const row of db.prepare('SELECT alert_key, ps_alert_id, COUNT(*) n FROM student_ps_alerts GROUP BY alert_key, ps_alert_id ORDER BY alert_key').all()) {
  console.log(`  ${row.alert_key} (${row.ps_alert_id}): ${row.n}`);
}
const c = db.prepare('SELECT COUNT(*) total, COUNT(dnc_g1) dnc_g1, COUNT(dnc_g2) dnc_g2, COUNT(g1_deceased) g1_deceased, COUNT(g2_deceased) g2_deceased FROM student_powerschool').get();
console.log(`contact fields set (of ${c.total}): dnc_g1 ${c.dnc_g1}, dnc_g2 ${c.dnc_g2}, g1_deceased ${c.g1_deceased}, g2_deceased ${c.g2_deceased}`);
