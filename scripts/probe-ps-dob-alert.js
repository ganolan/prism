#!/usr/bin/env node
// Probe (#191, read only; Graham approved 28/10/2026: one current class, field names and formats only):
// does the attendance app's own read carry each student's date of birth? Its code builds a birthday
// alert from `section_attendance?includeStudentAlerts=true`: each student's alerts in `studentAlerts`,
// one with type "dob" and `attributes.dateOfBirth` (the app shows "Today" or "MMM D"). This reads that
// answer for one section over its recent in-session days and prints only shapes: the answer's keys,
// the alert types with counts, how many students carry a "dob" alert, the dob attribute keys, and the
// format of at most 3 dateOfBirth values (every digit 9, every letter a). Never a value, name or id.
//
// Run from the repo root with a dev clone's own Schoology session:
//   PRISM_SESSION_DIR=~/repos/prism/.playwright-session node scripts/probe-ps-dob-alert.js <schoologySectionId> [days=15] [start end]
// start end (YYYY-MM-DD): read that range instead, to see whether the dob alerts follow the range or today.
import 'dotenv/config';
import { cookieJar } from '../server/services/schoologyWeb.js';
import { PowerSchoolWeb } from '../server/services/powerschoolWeb.js';
import { readSectionInfo } from '../server/services/psGradeLevelRead.js';
import { pickInSessionRange } from '../server/lib/psGradeLevel.js';

const sectionId = process.argv[2];
const days = Number(process.argv[3] || 15);
if (!sectionId) { console.error('usage: probe-ps-dob-alert.js <schoologySectionId> [days]'); process.exit(2); }
const MAX_FORMATS = 3;
const formatOf = (v) => String(v).replace(/\d/g, '9').replace(/[A-Za-z]/g, 'a');
const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o) : []);

const ps = new PowerSchoolWeb({ sgyJar: cookieJar(), fetchImpl: fetch, timeoutMs: 30000 });
const { sectionDcid, userDcid, form } = await ps.launchIds(sectionId);
if (!sectionDcid || !userDcid) { console.error('no sectionDcid or userDcid in the launch form'); process.exit(2); }
await ps.launch(sectionId, { form });
const today = new Date().toISOString().slice(0, 10);
const info = await readSectionInfo(ps, sectionDcid, today);
const range = process.argv[5] ? { startDate: process.argv[4], endDate: process.argv[5] } : pickInSessionRange(info, today, days);
if (!range) { console.error('no in-session days in range'); process.exit(2); }
console.log(`range: ${range.startDate} to ${range.endDate}`);

const sa = await ps.read('/ws/attendance/section_attendance', {
  sectionDcid, userDcid, startDate: range.startDate, endDate: range.endDate,
  includeStudentAlerts: 'true', multiSections: 'false', sortByFirstName: 'false',
}, { method: 'GET', accept: 'application/json' });
const first = Array.isArray(sa) ? sa[0] : sa;
console.log(`answer: ${Array.isArray(sa) ? `array of ${sa.length}` : typeof sa}; keys ${JSON.stringify(keysOf(first))}`);

// studentAlerts, wherever the answer keeps it: { [studentId]: { [alertId]: { type, attributes } } } in the app's code.
const holders = (Array.isArray(sa) ? sa : [sa]).map((x) => x?.studentAlerts).filter(Boolean);
const students = new Map();
for (const h of holders) for (const [sid, alerts] of Object.entries(h)) students.set(sid, alerts);
console.log(`studentAlerts: ${holders.length} block(s), ${students.size} students`);

const types = {};
let withDob = 0;
const dobKeys = new Set();
const formats = [];
for (const alerts of students.values()) {
  let has = false;
  for (const a of Object.values(alerts || {})) {
    types[a?.type] = (types[a?.type] || 0) + 1;
    if (a?.type === 'dob') {
      has = true;
      for (const k of keysOf(a.attributes)) dobKeys.add(k);
      if (formats.length < MAX_FORMATS && a.attributes?.dateOfBirth != null) formats.push(`${typeof a.attributes.dateOfBirth} ${formatOf(a.attributes.dateOfBirth)}`);
    }
  }
  if (has) withDob += 1;
}
console.log(`alert types (counts over all students): ${JSON.stringify(types)}`);
console.log(`students with a dob alert: ${withDob} of ${students.size}`);
console.log(`dob attribute keys: ${JSON.stringify([...dobKeys])}`);
console.log(`dateOfBirth formats (up to ${MAX_FORMATS}): ${JSON.stringify(formats)}`);
