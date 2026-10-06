// Spike: does PowerSchool tell us which school days each class MEETS?
//
// For every active course, fetch the same /ws/attendance/section_info the sync
// uses and report, per section:
//   - expression + sectionMeetings (the meeting pattern, e.g. "1(A-B)")
//   - its calenderDays: how many dates are school days (inSession + cycleDay)
//   - its bell schedules: which bellScheduleIds include the section's period,
//     and on how many school days the date's bellScheduleId is one of those
// …and whether the sections' school-day sets differ from each other (if every
// section marks the same days, the per-section calendar does NOT encode
// meeting days). Saves the raw section_info objects to /tmp for inspection.
//
// Read-only: GETs only. Run from the REPO ROOT:
//   PRISM_SESSION_DIR=~/prism/data/.playwright-session DB_PATH=~/prism/data/students.db \
//     node scripts/probe-section-meeting-days.js
import { writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';
import { sectionDcidFromLaunchForm } from '../server/lib/psBlockNumber.js';
import { sessionStateFile } from '../server/lib/sessionPaths.js';

const PS_HOST = 'powerschool.hkis.edu.hk';
const APP_ID = '4980125287';
const runUrl = (sid) => `${SCHOOLOGY_BASE}/apps/lti/${APP_ID}/run/course/${sid}`;

const db = new Database(process.env.DB_PATH || 'server/db/students.db', { readonly: true, fileMustExist: true });
const courses = db.prepare(`
  SELECT id, schoology_section_id, course_name, section_name, block_number FROM courses
  WHERE archived = 0 AND excluded = 0 ORDER BY block_number, course_name
`).all();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: sessionStateFile() });
const page = await context.newPage();
const raw = {};

try {
  await page.goto(runUrl(courses[0].schoology_section_id), { waitUntil: 'load', timeout: 45000 });
  if (!page.url().includes(PS_HOST)) {
    if (!isLoggedInUrl(page.url())) throw new Error('Not logged in to Schoology');
    await Promise.all([
      page.waitForURL((u) => u.toString().includes(PS_HOST), { timeout: 45000 }).catch(() => {}),
      page.evaluate(() => document.forms[0].submit()),
    ]);
  }
  if (!page.url().includes(PS_HOST)) throw new Error('PowerSchool did not load');

  const sets = [];
  for (const c of courses) {
    const html = await (await context.request.get(runUrl(c.schoology_section_id), { maxRedirects: 5 })).text();
    const dcid = sectionDcidFromLaunchForm(html);
    if (!dcid) { console.log(`\n${c.course_name} ${c.section_name}: no PS section`); continue; }
    const today = new Date().toISOString().slice(0, 10);
    const { status, text } = await page.evaluate(async ({ host, dcid, date }) => {
      const r = await fetch(`https://${host}/ws/attendance/section_info?sectionDcid=${dcid}&multiSections=false&startDate=${date}&endDate=${date}`,
        { credentials: 'include', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      return { status: r.status, text: await r.text() };
    }, { host: PS_HOST, dcid, date: today });
    if (status !== 200) { console.log(`\n${c.course_name}: section_info ${status}`); continue; }
    const parsed = JSON.parse(text);
    const s = Array.isArray(parsed) ? parsed[0] : parsed;
    raw[`${c.course_name} ${c.section_name}`] = s;

    const days = Object.entries(s.calenderDays || {});
    const school = days.filter(([, d]) => d?.inSession && d?.cycleDay);
    const ownPeriodIds = new Set(Object.keys(s.periodIdToPsmPeriodIdMap || {}).map(String));
    const items = s.bellScheduleItems || [];
    const myBellIds = new Set(items.filter((i) => ownPeriodIds.has(String(i.periodId)))
      .map((i) => String(i.bellScheduleId ?? i.bellSchedule?.id ?? i.bellSchedule)));
    const allBellIds = new Set(items.map((i) => String(i.bellScheduleId ?? i.bellSchedule?.id ?? i.bellSchedule)));
    const meetByBell = school.filter(([, d]) => myBellIds.has(String(d.bellScheduleId)));
    const letters = {};
    for (const [, d] of school) letters[d.cycleDay.letter] = (letters[d.cycleDay.letter] || 0) + 1;
    sets.push({ name: `${c.course_name} ${c.section_name}`, school: new Set(school.map(([d]) => d)) });

    console.log(`\n${c.course_name} | Schoology "${c.section_name}" | Block ${c.block_number ?? '-'} | PS dcid ${dcid}`);
    console.log(`  expression: ${s.expression}   sectionMeetings: ${JSON.stringify(s.sectionMeetings)}`);
    console.log(`  calenderDays: ${days.length} dates, ${school.length} school days ${JSON.stringify(letters)}; inSessionDays: ${(s.inSessionDays || []).length}`);
    console.log(`  bell schedules: ${allBellIds.size} total, ${myBellIds.size} include this section's period(s) ${JSON.stringify([...myBellIds])}`);
    console.log(`  school days whose bellScheduleId includes this section: ${meetByBell.length}/${school.length}`);
    console.log(`  first 10 school days: ${school.slice(0, 10).map(([d, x]) => `${d.slice(5)}${x.cycleDay.letter}/b${x.bellScheduleId}${myBellIds.has(String(x.bellScheduleId)) ? '✓' : '·'}`).join(' ')}`);
  }

  console.log('\n== Do the sections mark different school days? ==');
  const base = sets[0];
  for (const s of sets.slice(1)) {
    const onlyA = [...base.school].filter((d) => !s.school.has(d)).length;
    const onlyB = [...s.school].filter((d) => !base.school.has(d)).length;
    console.log(`  ${base.name} vs ${s.name}: ${onlyA} only in first, ${onlyB} only in second`);
  }
} finally {
  writeFileSync('/tmp/section-info-raw.json', JSON.stringify(raw, null, 2));
  console.log('\nRaw section_info saved to /tmp/section-info-raw.json');
  await browser.close();
}
