#!/usr/bin/env node
// Probe (#187, read only): what PowerSchool's section_info.bellScheduleItems hold for each class's
// start and end times. Reads section_info for every current course over the sync's own plain-HTTP
// PowerSchool session (powerschoolWeb.js) and prints, per section, each bell schedule item that holds
// the section's own period: the bell schedule's name, and the type and value of startTime and endTime.
// Then, for the next school days the class meets, which item the day's bellScheduleId picks.
// School timetable configuration only: no student data is read or printed.
//
// The course list comes from a running Prism's API (prod by default), never its database file.
// Run from the repo root with a dev clone's own Schoology session:
//   PRISM_SESSION_DIR=~/repos/prism/.playwright-session node scripts/probe-ps-bell-times.js [days=6] [apiBase]
import 'dotenv/config';
import { cookieJar } from '../server/services/schoologyWeb.js';
import { PowerSchoolWeb } from '../server/services/powerschoolWeb.js';
import { extractCalendarDays } from '../server/lib/psCalendar.js';

const days = Number(process.argv[2] || 6);
const api = process.argv[3] || 'http://127.0.0.1:3001';
const courses = (await (await fetch(`${api}/api/courses`)).json())
  .filter((c) => !c.archived && !c.excluded)
  .sort((a, b) => String(a.block_number ?? '').localeCompare(String(b.block_number ?? '')) || a.course_name.localeCompare(b.course_name));

const ps = new PowerSchoolWeb({ sgyJar: cookieJar(), fetchImpl: fetch, timeoutMs: 30000 });
const today = new Date().toISOString().slice(0, 10);
const shape = (v) => `${typeof v} ${JSON.stringify(v)}`;

for (const c of courses) {
  const { sectionDcid, form } = await ps.launchIds(c.schoology_section_id);
  if (!sectionDcid) { console.log(`\n${c.course_name}: no PowerSchool section`); continue; }
  if (!ps.launched) await ps.launch(c.schoology_section_id, { form });
  let info;
  try {
    const parsed = await ps.read('/ws/attendance/section_info', { sectionDcid, multiSections: 'false', startDate: today, endDate: today },
      { method: 'GET', accept: 'application/json' });
    info = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    console.log(`\n${c.course_name}: section_info failed (${err.status ?? err.message})`);
    continue;
  }
  const own = new Set(Object.keys(info?.periodIdToPsmPeriodIdMap || {}).map(String));
  const items = (info?.bellScheduleItems || []).filter((i) => own.has(String(i.periodId)));
  console.log(`\n${c.course_name} | Block ${c.block_number ?? '-'} | ${items.length} own bell schedule items`);
  for (const i of items.slice(0, 40)) {
    console.log(`  bell ${i.bellScheduleId} "${String(i.bellSchedule?.name ?? '').trim()}" start ${shape(i.startTime)} end ${shape(i.endTime)} minutes ${shape(i.minutesAttended)}`);
  }
  const byBell = new Map(items.map((i) => [String(i.bellScheduleId), i]));
  const next = extractCalendarDays(info)
    .filter((d) => d.inSession && d.date >= today)
    .map((d) => ({ date: d.date, bell: String(JSON.parse(d.raw)?.bellScheduleId) }))
    .filter((d) => byBell.has(d.bell))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, days);
  for (const d of next) {
    const i = byBell.get(d.bell);
    console.log(`  meets ${d.date}: bell ${d.bell} "${String(i.bellSchedule?.name ?? '').trim()}" ${i.startTime} to ${i.endTime}`);
  }
}
