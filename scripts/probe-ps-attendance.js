#!/usr/bin/env node
// Probe (#39, read only, Graham asked for the spike 29 Oct 2026: one current class): how PowerSchool's attendance app
// reads a class's attendance, where its code catalog comes from, and whether a read says attendance was taken. GETs
// only, after the LTI launch sign-in; the save routes the app's code names (POST /ws/attendance/section_attendance,
// PUT /ws/pt/v1/attendance/saveattendance(s)) are never sent.
// Prints key paths, value types, counts and the school's code catalog (codes and descriptions, not student data);
// never a student's name, id or comment.
// Findings: .claude/powerschool-api-reference.md "Attendance: reading and marking (#39)".
// Usage (repo root): node --env-file=.env scripts/probe-ps-attendance.js <schoologySectionId> [days back, default 14]
import 'dotenv/config';
import { cookieJar } from '../server/services/schoologyWeb.js';
import { PowerSchoolWeb, PS_BASE } from '../server/services/powerschoolWeb.js';

const sectionId = process.argv[2];
const back = Math.min(30, Number(process.argv[3] || 14) || 14);
if (!sectionId) { console.error('usage: probe-ps-attendance.js <schoologySectionId> [days back]'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = new PowerSchoolWeb({ sgyJar: cookieJar() });

async function get(path, params) {
  await sleep(300);
  const url = `${PS_BASE}${path}?${new URLSearchParams({ ...params, _: String(Math.floor(Date.now() / 1000)) })}`;
  const res = await fetch(url, { redirect: 'manual', headers: { cookie: ps.jar.header(), Accept: 'application/json' } });
  ps.jar.take(res);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, bytes: text.length };
}
// Key paths with value types; arrays as [], numeric object keys as <id>; strings as string(len).
function paths(v, p = '$', out = new Map(), depth = 0) {
  const add = (k, t) => { if (!out.has(k)) out.set(k, new Set()); out.get(k).add(t); };
  if (depth > 6) return out;
  if (Array.isArray(v)) { add(p, `array(${v.length})`); v.slice(0, 50).forEach((x) => paths(x, `${p}[]`, out, depth + 1)); }
  else if (v && typeof v === 'object') { add(p, 'object'); for (const [k, x] of Object.entries(v)) paths(x, `${p}.${/^\d+$/.test(k) || /^\d{4}-\d{2}-\d{2}$/.test(k) ? '<key>' : k}`, out, depth + 1); }
  else add(p, v === null ? 'null' : typeof v === 'string' ? `string(${v.length})` : `${typeof v}${typeof v === 'boolean' ? `=${v}` : ''}`);
  return out;
}
const printPaths = (label, json, filter = () => true, max = 80) => {
  const ps_ = [...paths(json)].filter(([k]) => filter(k));
  console.log(`  ${label}: ${ps_.length} key paths`);
  for (const [k, t] of ps_.slice(0, max)) console.log(`    ${k}: ${[...t].slice(0, 4).join(' | ')}`);
};

console.log('1. launch');
const { sectionDcid, userDcid } = await ps.launchIds(sectionId);
await ps.launch(sectionId);
const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const start = new Date(today.getTime() - back * 86400000);

console.log(`2. section_info ${iso(start)} to ${iso(today)}`);
const info = await get('/ws/attendance/section_info', { sectionDcid, multiSections: 'false', startDate: iso(start), endDate: iso(today) });
const first = Array.isArray(info.json) ? info.json[0] : info.json;
console.log(`  ${info.status}, ${info.bytes} bytes; top keys: ${Object.keys(first || {}).join(', ')}`);
printPaths('section_info (code, period and mode keys)', first, (k) => /code|period|mode|psm|track|editable|comment/i.test(k));
const codeLists = Object.entries(first || {}).filter(([k, v]) => /code/i.test(k) && Array.isArray(v));
for (const [k, list] of codeLists) {
  console.log(`  catalog ${k}: ${list.length} codes`);
  for (const c of list) console.log(`    ${JSON.stringify(c).slice(0, 220)}`);
}
// The days this class meets: in session, and the day's cycle letter is one of the section's meeting letters.
const letters = new Set((first?.sectionMeetings || []).map((m) => m.cycleDayLetter ?? m.cycleDay?.letter ?? m.letter).filter(Boolean));
console.log(`  sectionMeetings keys: ${Object.keys(first?.sectionMeetings?.[0] || {}).join(', ')}; meeting letters: ${[...letters].join(', ') || '(none found)'}`);
const meets = Object.entries(first?.calenderDays || {})
  .filter(([d, v]) => v?.inSession && d >= iso(start) && d <= iso(today) && (!letters.size || letters.has(v?.cycleDay?.letter)))
  .map(([d]) => d).sort();
console.log(`  meeting days in range: ${meets.length}: ${meets.join(', ')}`);
const day = meets[meets.length - 1];

console.log(`3. section_attendance for ${day} (the grid's read)`);
const att = await get('/ws/attendance/section_attendance', { sectionDcid, userDcid, startDate: day, endDate: day, includeStudentAlerts: 'false', multiSections: 'false' });
console.log(`  ${att.status}, ${att.bytes} bytes; top keys: ${Object.keys(att.json || {}).join(', ')}`);
printPaths('section_attendance', att.json, (k) => !/studentAlerts/.test(k));
const recs = (att.json?.sectionAttendances || att.json?.record || []);
const codes = new Map();
for (const sa of [].concat(att.json?.sectionAttendances || [])) for (const st of sa.studentAttendance || []) for (const m of st.meetingAttendance || []) codes.set(m.code || '(blank)', (codes.get(m.code || '(blank)') || 0) + 1);
console.log(`  codes on ${day}: ${JSON.stringify(Object.fromEntries(codes))}; attendanceTakenBySectionId: ${JSON.stringify(att.json?.attendanceTakenBySectionId ?? null).replace(/\d{5,}/g, '<id>')}; editable window: ${att.json?.maxEditablePastDate} to ${att.json?.maxEditableFutureDate}`);
void recs;

// 3b. The last 3 meeting days, counts only: codes, students marked, and whether attendance is recorded as taken.
for (const d of meets.slice(-3)) {
  const a = await get('/ws/attendance/section_attendance', { sectionDcid, userDcid, startDate: d, endDate: d, includeStudentAlerts: 'false', multiSections: 'false' });
  const c = new Map(); let students = 0; let readOnly = 0; let comments = 0;
  for (const sa of [].concat(a.json?.sectionAttendances || [])) for (const st of sa.studentAttendance || []) {
    students += 1;
    for (const m of st.meetingAttendance || []) { c.set(m.code || '(blank)', (c.get(m.code || '(blank)') || 0) + 1); if (m.readOnly) readOnly += 1; if (m.comment) comments += 1; }
  }
  const taken = Object.values(a.json?.attendanceTakenBySectionId || {}).map((v) => (Array.isArray(v) ? `array(${v.length})${v.length ? ` of ${JSON.stringify(v[0]).replace(/\d{5,}/g, '<id>').slice(0, 120)}` : ''}` : typeof v));
  console.log(`  ${d}: ${a.status}; ${[].concat(a.json?.sectionAttendances || []).length} section-days, ${students} students; codes ${JSON.stringify(Object.fromEntries(c))}; readOnly ${readOnly}; with comment ${comments}; attendanceTaken ${taken.join(' ')}`);
  if (d === meets[meets.length - 1]) printPaths('section_attendance on a meeting day', a.json, (k) => !/studentAlerts/.test(k), 40);
}

// 3c. The whole range in one read: the mark fields, and code counts across it.
{
  const a = await get('/ws/attendance/section_attendance', { sectionDcid, userDcid, startDate: iso(start), endDate: iso(today), includeStudentAlerts: 'false', multiSections: 'false' });
  const c = new Map();
  const sas = [].concat(a.json?.sectionAttendances || []);
  for (const sa of sas) for (const st of sa.studentAttendance || []) for (const m of st.meetingAttendance || []) c.set(m.code || '(blank)', (c.get(m.code || '(blank)') || 0) + 1);
  console.log(`3c. range ${iso(start)} to ${iso(today)}: ${a.status}; ${sas.length} section-days (${sas.map((x) => x.date).join(', ')}); codes ${JSON.stringify(Object.fromEntries(c))}`);
  printPaths('section_attendance over the range', a.json, (k) => !/studentAlerts/.test(k), 60);
}

console.log('4. getattendance_integration, with the parameter names the app sends (sectionId, date, periodId: PSM ids)');
const psm = first?.psmSectionId;
const periodMap = first?.periodIdToPsmPeriodIdMap || {};
const periods = Object.values(periodMap);
console.log(`  psmSectionId present: ${psm != null}; periodIdToPsmPeriodIdMap entries: ${Object.keys(periodMap).length}`);
for (const periodId of periods.slice(0, 2)) {
  const r = await get('/ws/pt/v1/attendance/getattendance_integration', { sectionId: String(psm), date: process.env.DAY || day, periodId: String(periodId) });
  console.log(`  period …${String(periodId).slice(-2)}: ${r.status}, ${r.bytes} bytes${r.status !== 200 && r.json ? ` ${JSON.stringify(r.json).slice(0, 160)}` : ''}`);
  if (r.status === 200) {
    printPaths('getattendance_integration', r.json, () => true, 60);
    const c = new Map();
    for (const st of r.json?.sectionAttendance?.studentAttendance || []) for (const m of st.meetingAttendance || []) c.set(m.code || '(blank)', (c.get(m.code || '(blank)') || 0) + 1);
    console.log(`  codes: ${JSON.stringify(Object.fromEntries(c))}`);
  }
}
