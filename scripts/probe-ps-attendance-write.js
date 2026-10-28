#!/usr/bin/env node
// Probe (#39): the first live attendance write, approved by Graham 29 Oct 2026 for one target he named: AP CSP
// (Schoology section 8458134140), today's lesson, after he took attendance in Schoology. It re-saves that lesson's
// marks UNCHANGED, as the attendance app's list grid saves (POST /ws/attendance/section_attendance, a JSON array of
// section-days built from the grid's own read), then reads them back. The quizWriteback.js safety pattern:
//   read → refuse unless attendance was taken that day and the lesson has marks → read again just before the write
//   and refuse if anything changed → write → read back and compare every mark.
// Without --write it is a dry run: the two reads and the body's shape, nothing sent. Prints counts, codes and
// MATCH / MISMATCH only; never a student's name, id or comment.
// Usage (repo root): node --env-file=.env scripts/probe-ps-attendance-write.js <schoologySectionId> <YYYY-MM-DD> [--write]
import 'dotenv/config';
import { cookieJar } from '../server/services/schoologyWeb.js';
import { PowerSchoolWeb, PS_BASE } from '../server/services/powerschoolWeb.js';

const [sectionId, day, flag] = process.argv.slice(2);
const APPROVED = { section: '8458134140' }; // Graham's named target; any other section is refused
if (sectionId !== APPROVED.section) { console.error(`Refused: only section ${APPROVED.section} is approved for this write.`); process.exit(1); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) { console.error('usage: <schoologySectionId> <YYYY-MM-DD> [--write]'); process.exit(1); }
const write = flag === '--write';
const ps = new PowerSchoolWeb({ sgyJar: cookieJar() });
const stamp = () => String(Math.floor(Date.now() / 1000));

async function call(method, path, params, body) {
  const url = `${PS_BASE}${path}?${new URLSearchParams({ ...(params || {}), _: stamp() })}`;
  const res = await fetch(url, {
    method, redirect: 'manual',
    headers: { cookie: ps.jar.header(), Accept: 'application/json, text/plain, */*', ...(body ? { 'Content-Type': 'application/json' } : {}), Referer: `${PS_BASE}/integrations/attendance/index.html` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  ps.jar.take(res);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, type: res.headers.get('content-type') || '' };
}

// The one-day grid read → { sectionDays, taken, marks: Map key → code+comment, body (as the app builds it) }.
async function readDay(sectionDcid, userDcid) {
  const r = await call('GET', '/ws/attendance/section_attendance', { sectionDcid, userDcid, startDate: day, endDate: day, includeStudentAlerts: 'false', multiSections: 'false' });
  if (r.status !== 200 || !r.json) throw new Error(`read answered ${r.status}`);
  const sectionDays = [].concat(r.json.sectionAttendances || []);
  const taken = Object.values(r.json.attendanceTakenBySectionId || {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  const marks = new Map();
  const body = sectionDays.map((sa) => ({
    commentsEnabled: sa.commentsEnabled, date: sa.date, meetingMode: sa.meetingMode, meetingType: sa.meetingType,
    periodId: sa.periodId, sectionId: sa.sectionId,
    studentAttendance: (sa.studentAttendance || []).map((st) => {
      const meetingAttendance = [];
      if (st.onTrack) for (const m of st.meetingAttendance || []) {
        marks.set(`${sa.sectionId}|${sa.periodId}|${st.studentId}|${m.intervalNumber}`, `${m.code ?? ''}|${m.comment ?? ''}`);
        meetingAttendance.push({ code: m.code, comment: m.comment, intervalDuration: m.intervalDuration, intervalNumber: m.intervalNumber });
      }
      return { studentId: st.studentId, dcid: st.dcid, meetingAttendance };
    }),
  }));
  return { sectionDays, taken, marks, body };
}
const codesOf = (marks) => [...marks.values()].reduce((m, v) => { const c = v.split('|')[0] || '(blank)'; m[c] = (m[c] || 0) + 1; return m; }, {});
const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

console.log(`1. launch; ${write ? 'WRITE' : 'dry run'} for ${day}`);
const { sectionDcid, userDcid } = await ps.launchIds(sectionId);
await ps.launch(sectionId);

const first = await readDay(sectionDcid, userDcid);
console.log(`2. read: ${first.sectionDays.length} section-day(s), ${first.marks.size} marks ${JSON.stringify(codesOf(first.marks))}, attendance taken records: ${first.taken}`);
if (first.sectionDays.length !== 1) { console.log('Refused: the class does not have exactly one lesson that day.'); process.exit(2); }
if (!first.taken || !first.marks.size) { console.log('Refused: attendance has not been taken for this lesson yet.'); process.exit(2); }
const students = first.body[0].studentAttendance.length;
console.log(`   body: 1 section-day, ${students} students, ${first.body[0].studentAttendance.filter((s) => s.meetingAttendance.length).length} with marks; keys ${Object.keys(first.body[0]).join(', ')}`);
if (!write) { console.log('Dry run: nothing sent.'); process.exit(0); }

const again = await readDay(sectionDcid, userDcid);
if (!same(first.marks, again.marks)) { console.log('Refused: the marks changed between the two reads; nothing sent.'); process.exit(3); }
console.log('3. re-read just before the write: unchanged');

const w = await call('POST', '/ws/attendance/section_attendance', {}, again.body);
console.log(`4. write: ${w.status} ${w.type.split(';')[0]}, ${w.text.length} bytes${w.json !== undefined ? `, JSON ${Array.isArray(w.json) ? `array(${w.json.length})` : typeof w.json === 'object' && w.json ? `{${Object.keys(w.json).join(', ')}}` : String(w.json).slice(0, 80)}` : `, text ${w.text.slice(0, 120).replace(/\d{5,}/g, '<id>')}`}`);
if (w.status < 200 || w.status >= 300) { console.log('Write not accepted: stopping.'); process.exit(4); }

const back = await readDay(sectionDcid, userDcid);
console.log(`5. read-back: ${back.marks.size} marks ${JSON.stringify(codesOf(back.marks))}, attendance taken records: ${back.taken}; ${same(again.marks, back.marks) ? 'MATCH: every mark as before' : 'MISMATCH'}`);
if (!same(again.marks, back.marks)) process.exit(5);
