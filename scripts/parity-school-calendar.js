// Calendar parity (triage spec): the stored PowerSchool school_days vs a Master
// Plan's Daily Planning View. Read-only. Exit 1 when they differ.
//
// Run from the REPO ROOT after a sync that included the PowerSchool block pass:
//   node scripts/parity-school-calendar.js "<path to 2026-27 Master Plan.xlsx>" ["Daily Planning View"]
import { getDb } from '../server/db/index.js';
import { readSheetFromXlsx, planDays, compareCalendars } from './lib/masterPlanCalendar.js';

const [file, sheet = 'Daily Planning View'] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/parity-school-calendar.js "<Master Plan.xlsx>" ["<sheet name fragment>"]');
  process.exit(2);
}

const plan = planDays(readSheetFromXlsx(file, sheet));
const ps = getDb().prepare('SELECT date, in_session, cycle_letter FROM school_days ORDER BY date').all();
if (!ps.length) {
  console.error('school_days is empty: run a sync with PowerSchool signed in first.');
  process.exit(1);
}

const r = compareCalendars(ps, plan);
console.log(`Overlap ${r.overlap.from} → ${r.overlap.to}`);
console.log(`School days: Master Plan ${r.planSchoolDays}, PowerSchool ${r.psSchoolDays}`);
console.log(`Cycle-day parity → PowerSchool letter: ${JSON.stringify(r.letterByParity)}`);
console.log(`Only in PowerSchool (${r.onlyInPs.length}): ${r.onlyInPs.join(', ') || '—'}`);
console.log(`Only in Master Plan (${r.onlyInPlan.length}): ${r.onlyInPlan.join(', ') || '—'}`);
console.log(`Letter mismatches (${r.letterMismatches.length}): ${r.letterMismatches.map((m) => `${m.date} day ${m.cycleDay}=${m.letter}`).join(', ') || '—'}`);
const ok = !r.onlyInPs.length && !r.onlyInPlan.length && !r.letterMismatches.length;
console.log(ok ? 'PARITY OK ✅' : 'PARITY DIFFERS ❌');
process.exit(ok ? 0 : 1);
