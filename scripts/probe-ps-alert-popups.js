#!/usr/bin/env node
// Probe (#160, read only; first written for #163): the pop-up behind each PowerSchool
// alert Prism keeps. Each alert icon in the attendance grid is a link the MBA
// custom-alerts plugin builds (api.makeAlert in the plugin code from
// /ws/pagecustomizations/insertions) and PowerSchool opens as a dialog from the
// attendance page:
//   /teachers/alerts/aet_customalert_custompopup.html?url={stub_url}&frn=001{dcid}&id={alertId}
//   + sf alerts:  &mba_frn=001{dcid}&student_field={table}.{FIELD}&tableName={table}
//   + adv alerts: &{querystring}&studentid={studentid}
// Task 1 of the roster redesign: for each kept alert with a stub_url in the LIVE catalogue
// (getAlertTypes.json, as psAlertsSync reads it), read the pop-up for up to 3 students of ONE
// current course who hold it (student_ps_alerts), and print its SHAPE per alert: HTTP status,
// content type, byte length, tag counts, table headers, the number of cells and of non-empty
// cells. It never prints a name, a student id or any cell text (Graham approved the reads on
// 25/10/2026: read only, up to 3 students per alert, one course).
//
// Stops at the first "Security Violation Logged" page (a wrong click path is logged at school,
// #116). Exit codes: 0 done, 2 usage, 3 security violation, 4 no usable Schoology session.
//
// The database is only read (opened readonly). Point DB_PATH at a read-only backup copy of
// prod's database (`sqlite3 -readonly <prod db> ".backup <copy>"`), then delete the copy.
//
//   DB_PATH=<copy> node scripts/probe-ps-alert-popups.js --list
//        (current courses and how many students hold a kept alert; counts only, no PowerSchool read)
//   DB_PATH=<copy> node scripts/probe-ps-alert-popups.js --course <courseId> [--per-alert 3]
import 'dotenv/config';
import Database from 'better-sqlite3';
import { cookieJar } from '../server/services/schoologyWeb.js';
import { PowerSchoolWeb, PS_BASE } from '../server/services/powerschoolWeb.js';
import { ALERT_DEFS } from '../server/lib/psAlerts.js';
import { PS_SCHOOL_ID } from '../server/services/psAlertsSync.js';
import { popupLink } from '../server/services/psSupportSummary.js';

const args = process.argv.slice(2);
const flag = (name) => args.indexOf(`--${name}`);
const value = (name) => (flag(name) >= 0 ? args[flag(name) + 1] : undefined);
// Never more than 3 students per alert: Graham's approval of these reads (25/10/2026) is shapes only, up to 3 per alert,
// so a larger --per-alert is capped rather than honoured.
const perAlert = Math.min(3, Number(value('per-alert') ?? 3));
const courseArg = value('course');
if (flag('list') < 0 && !courseArg) {
  console.error('usage: probe-ps-alert-popups.js --list | --course <courseId> [--per-alert 3]');
  process.exit(2);
}

const dbPath = process.env.DB_PATH;
if (!dbPath || dbPath === ':memory:') { console.error('Set DB_PATH to a read-only backup copy of the database.'); process.exit(2); }
const db = new Database(dbPath, { readonly: true });

const ATTENDANCE_PAGE = `${PS_BASE}/integrations/attendance/index.html`;
const Q = '/teachers/mba_alerts/queries/';

// Current courses with the number of their current students holding any kept alert.
const COURSES = `
  SELECT c.id, c.course_name, c.schoology_section_id,
         COUNT(DISTINCT e.student_id) AS students,
         COUNT(DISTINCT a.student_id) AS holders
  FROM courses c
  JOIN enrolments e ON e.course_id = c.id AND e.dropped_at IS NULL
  LEFT JOIN student_ps_alerts a ON a.student_id = e.student_id
  WHERE c.archived = 0 AND c.excluded = 0 AND c.schoology_section_id IS NOT NULL
  GROUP BY c.id ORDER BY holders DESC, c.id`;

if (flag('list') >= 0) {
  for (const c of db.prepare(COURSES).all()) console.log(`course ${c.id} (${c.course_name}): ${c.students} students, ${c.holders} hold a kept alert`);
  process.exit(0);
}

const course = db.prepare(COURSES).all().find((c) => String(c.id) === String(courseArg));
if (!course) { console.error(`No current course ${courseArg}.`); process.exit(2); }

// The course's current students who hold the alert, with their PowerSchool dcid.
const holders = db.prepare(`
  SELECT s.school_uid FROM student_ps_alerts a
  JOIN enrolments e ON e.student_id = a.student_id AND e.course_id = ? AND e.dropped_at IS NULL
  JOIN students s ON s.id = a.student_id
  WHERE a.alert_key = ? ORDER BY s.id`);

const jar = cookieJar();
if (!jar) { console.error('BLOCKED: no Schoology session file (.playwright-session/storage-state.json). Graham must run `npm run mastery:login`.'); process.exit(4); }
const ps = new PowerSchoolWeb({ sgyJar: jar });
let sectionDcid;
try {
  ({ sectionDcid } = await ps.launch(course.schoology_section_id));
} catch (err) {
  if (err.code === 'SESSION_EXPIRED') { console.error('BLOCKED: the Schoology session has lapsed. Graham must run `npm run mastery:login`.'); process.exit(4); }
  throw err;
}
console.log(`launch: PowerSchool session started through course ${course.id}`);

const catalogue = await ps.read(`${Q}getAlertTypes.json`, { disabled: 0, student_schoolid: PS_SCHOOL_ID });
const typeById = new Map((Array.isArray(catalogue) ? catalogue : []).filter((t) => t && t.id != null).map((t) => [String(t.id), t]));
const roster = await ps.read(`${Q}getStudentsInSection.json`, { sectionIds: sectionDcid });
const studentidByDcid = new Map((Array.isArray(roster) ? roster : []).filter((r) => r && r.studentid != null).map((r) => [String(r.studentdcid), String(r.studentid)]));
console.log(`roster: ${studentidByDcid.size} students`);

// The plugin's link (api.makeAlert) is popupLink in psSupportSummary.js; `bare` leaves the sf / adv extras off (what #163 sent).
const href = (def, dcid, studentid, bare) => popupLink(def, dcid, studentid, bare);

// The page's shape, never its text: tag counts, <th> headers, class names, cell counts.
const strip = (s) => s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
function shape(html) {
  const tags = {};
  for (const [, t] of html.matchAll(/<([a-z][a-z0-9]*)\b/gi)) tags[t.toLowerCase()] = (tags[t.toLowerCase()] || 0) + 1;
  const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
  const classes = [...new Set([...html.matchAll(/\sclass="([^"]*)"/gi)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean))];
  return {
    tags,
    headers: [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => strip(m[1])),
    rows: (html.match(/<tr\b/gi) || []).length,
    cells: cells.length,
    nonEmptyCells: cells.filter(Boolean).length,
    links: (html.match(/<a\b/gi) || []).length,
    textLength: strip(html).length,
    classes: classes.slice(0, 20),
  };
}

// One pop-up GET, as the dialog sends it. Stops the whole probe on a security page.
async function get(path) {
  const res = await fetch(`${PS_BASE}${path}`, {
    headers: { cookie: ps.jar.header(), Referer: ATTENDANCE_PAGE, Accept: 'text/html, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  });
  ps.jar.take(res);
  const html = await res.text();
  if (/Security Violation Logged/i.test(html)) {
    console.log('STOP: PowerSchool answered with its "Security Violation Logged" page. Nothing more was read.');
    process.exit(3);
  }
  const location = res.headers.get('location');
  return { status: res.status, type: res.headers.get('content-type'), html, redirect: location ? new URL(location, PS_BASE).pathname : null };
}
const pause = () => new Promise((r) => setTimeout(r, 400));

// Read one link and print its shape. → 'refused' | 'readable' | 'empty'
async function readOne(label, path) {
  const a = await get(path);
  await pause();
  const s = shape(a.html);
  const verdict = a.status !== 200 ? 'refused' : (s.nonEmptyCells > 0 || s.textLength > 0) ? 'readable' : 'empty';
  console.log(`  ${label}: HTTP ${a.status}${a.redirect ? ` -> ${a.redirect}` : ''}, ${a.type}, ${a.html.length} bytes, ${verdict}`);
  console.log(`    tags ${JSON.stringify(s.tags)}; th ${JSON.stringify(s.headers)}; rows ${s.rows}; cells ${s.cells}, non-empty ${s.nonEmptyCells}; links ${s.links}; text ${s.textLength} chars; classes ${JSON.stringify(s.classes)}`);
  // A short answer's markup, every text run (and every attribute value) replaced by its length.
  if (a.html.length < 400) console.log(`    short answer, text masked: ${a.html.replace(/="[^"]*"/g, '="…"').replace(/>([^<]*)</g, (m, t) => (t.trim() ? `>[${t.trim().length} chars]<` : '><'))}`);
  return verdict;
}

const summary = [];
for (const def of ALERT_DEFS) {
  const id = def.psAlertIds[0];
  const type = typeById.get(id);
  if (!type) { console.log(`\n${def.key}: not in the live catalogue`); summary.push(`${def.key}: not in the catalogue`); continue; }
  if (!type.stub_url) {
    console.log(`\n${def.key} (id ${id}): no stub_url (trigger_type ${type.trigger_type}, trigger_url ${JSON.stringify(type.trigger_url || '')}); not read`);
    summary.push(`${def.key}: no stub_url`);
    continue;
  }
  const picked = holders.all(course.id, def.key)
    .map((h) => String(h.school_uid || '').match(/^1_(\d+)$/)?.[1])
    .filter((dcid) => dcid && studentidByDcid.has(dcid))
    .slice(0, perAlert)
    .map((dcid) => ({ dcid, studentid: studentidByDcid.get(dcid) }));
  console.log(`\n${def.key} (id ${id}, ${type.trigger_type}, stub_url ${type.stub_url}, querystring ${JSON.stringify(type.querystring || '')}): ${picked.length} holders read`);
  if (!picked.length) { summary.push(`${def.key}: no holder in this course`); continue; }
  const verdicts = [];
  for (const [i, h] of picked.entries()) {
    let verdict = await readOne(`student ${i + 1}, full link`, href(type, h.dcid, h.studentid, false));
    // The bare link (what #163 sent) is tried only when the full one answered nothing, and only if it differs.
    if (verdict === 'empty' && href(type, h.dcid, h.studentid, true) !== href(type, h.dcid, h.studentid, false)) {
      const bare = await readOne(`student ${i + 1}, bare link`, href(type, h.dcid, h.studentid, true));
      if (bare === 'readable') verdict = bare;
    }
    verdicts.push(verdict);
  }
  const verdict = verdicts.includes('readable') ? 'readable' : verdicts.includes('refused') ? 'refused' : 'empty';
  summary.push(`${def.key}: ${verdict} (${verdicts.filter((v) => v === 'readable').length} of ${verdicts.length} readable, ${verdicts.filter((v) => v === 'empty').length} empty, ${verdicts.filter((v) => v === 'refused').length} refused)`);
}

console.log('\nSummary:');
for (const line of summary) console.log(line);
