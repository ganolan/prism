#!/usr/bin/env node
// Probe (#116, read only): where does PowerSchool's teacher web surface give a student's
// grade level, gender and postal address? Starts the PowerSchool session over plain HTTP
// (the attendance LTI launch, as server/services/powerschoolWeb.js does), then:
//   bundle  — greps the attendance app's own scripts for /ws/pt/v1/... and /ws/schema/...
//             literals (code, not data) so routes come from the app, not from guesses;
//   roster  — the section roster (GET getStudentsInSection.json) for real student ids;
//   student — the app's own chain: section_info → psmSectionId →
//             /ws/pt/v1/section/{psmSectionId}/students_integration → /ws/pt/v1/student/{psmId};
//   demo    — the PowerTeacher student Demographics screen, by the teacher's click path;
//   schema  — GETs on /ws/schema/query/api, /ws/schema/table/students and /ws/v1/student;
//   page    — (explicit only) a '>'-separated chain of teacher pages: links and labels.
// Findings: .claude/powerschool-api-reference.md "Student grade level, gender and postal
// address (#116)".
//
// Read only: every request is a GET except the LTI launch POST (a sign-in). Masks every
// student value: prints status codes, content types, key paths, value types, lengths and
// counts only. Never prints a name, an id, an address or a gender.
// Usage: node scripts/probe-ps-student-fields.js <schoologySectionId> [bundle|roster|student|demo|schema|page] [n] [pages]
//   no step: every step but page, in order; n = students to probe (default 3).
import 'dotenv/config';
import { cookieJar } from '../server/services/schoologyWeb.js';
import { PowerSchoolWeb, PS_BASE } from '../server/services/powerschoolWeb.js';

const sectionId = process.argv[2];
const only = process.argv[3];
const N = Number(process.argv[4] || 3);
if (!sectionId) { console.error('usage: probe-ps-student-fields.js <schoologySectionId> [step] [n]'); process.exit(1); }
const want = (step) => (!only && step !== 'page') || only === step;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sgyJar = cookieJar();
if (!sgyJar) { console.error('no saved Schoology session (.playwright-session/storage-state.json)'); process.exit(1); }
const ps = new PowerSchoolWeb({ sgyJar });

// A raw read on the PowerSchool session: status + type + body, never thrown on a status.
async function raw(path, { method = 'GET', body, headers = {} } = {}) {
  await sleep(250);
  const res = await fetch(`${PS_BASE}${path}`, {
    method, body, redirect: 'manual',
    headers: { cookie: ps.jar.header(), Accept: 'application/json', ...headers },
  });
  ps.jar.take(res);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, type: (res.headers.get('content-type') || '').split(';')[0], text, json, location: res.headers.get('location') };
}

// Masked shape: keys and value types, strings as string(len).
const shape = (v, depth = 0) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})${v.length && depth < 3 ? ` of ${shape(v[0], depth + 1)}` : ''}`;
  if (typeof v === 'object') return `{ ${Object.keys(v).map(k => `${k}: ${depth < 3 ? shape(v[k], depth + 1) : typeof v[k]}`).join(', ')} }`;
  if (typeof v === 'string') return `string(${v.length})`;
  return typeof v;
};

// Every key path in a JSON value (arrays as []), with the set of value types seen.
function keyPaths(v, path = '$', out = new Map()) {
  const add = (p, t) => { if (!out.has(p)) out.set(p, new Set()); out.get(p).add(t); };
  if (Array.isArray(v)) { add(path, `array(${v.length})`); v.forEach(x => keyPaths(x, `${path}[]`, out)); }
  else if (v && typeof v === 'object') { add(path, 'object'); for (const [k, x] of Object.entries(v)) keyPaths(x, `${path}.${k}`, out); }
  else add(path, v === null ? 'null' : typeof v === 'string' ? (v === '' ? 'string(0)' : 'string') : typeof v);
  return out;
}

const TARGET = { grade: /grade_?level|gradelevel|\bgrade\b|yearlevel|year_?group/i, gender: /gender|\bsex\b/i, address: /address|street|city|zip|postal|postcode|mailing|state_?province/i };
const targetOf = (p) => Object.entries(TARGET).filter(([, re]) => re.test(p.split('.').pop())).map(([k]) => k);

function report(label, r) {
  console.log(`  ${label} → ${r.status} ${r.type}${r.location ? ` (redirect to ${new URL(r.location, PS_BASE).pathname})` : ''}, ${r.text.length} bytes${r.json === undefined ? ', not JSON' : ''}`);
  if (r.json === undefined) return null;
  // An error answer is the server's own message (no student data): print it.
  if (r.status !== 200) { const msg = r.json?.message || r.json?.errorMessage?.message || r.json?.ErrorMessage?.message; console.log(`    error: ${shape(r.json)}${msg ? ` "${String(msg).slice(0, 120)}"` : ""}`); return null; }
  const paths = keyPaths(r.json);
  console.log(`    ${paths.size} key paths; top: ${shape(r.json, 2).slice(0, 600)}`);
  const hits = [...paths].filter(([p]) => targetOf(p).length);
  for (const [p, types] of hits) console.log(`    target ${targetOf(p).join('/')}: ${p} (${[...types].join('|')})`);
  return paths;
}

console.log('1. launch (plain HTTP)');
const { sectionDcid } = await ps.launchIds(sectionId);
await ps.launch(sectionId);
console.log(`  PowerSchool session: ${ps.jar.size} cookies; sectionDcid present: ${Boolean(sectionDcid)}`);

if (want('bundle')) {
  console.log('2. bundle: route literals in the attendance app scripts');
  const app = await raw('/integrations/attendance/index.html', { headers: { Accept: 'text/html' } });
  const srcs = [...app.text.matchAll(/<script[^>]*src="([^"]+)"/gi)].map(m => m[1]);
  console.log(`  app page ${app.status}, ${srcs.length} scripts`);
  const literals = new Map();
  for (const src of srcs) {
    const url = new URL(src, `${PS_BASE}/integrations/attendance/`).href;
    if (!url.startsWith(PS_BASE)) continue;
    await sleep(250);
    const res = await fetch(url, { headers: { cookie: ps.jar.header() } });
    const js = await res.text();
    // PROBE_OUT=<dir>: keep the app bundle (code, no student data) for a closer read.
    if (process.env.PROBE_OUT && /main\./.test(url)) (await import('fs')).writeFileSync(`${process.env.PROBE_OUT}/attendance-main.js`, js);
    for (const m of js.matchAll(/["'`](\/ws\/(?:pt\/v1|schema|v1)\/[^"'`\s]*)["'`]/g)) {
      const at = m.index;
      if (!literals.has(m[1])) literals.set(m[1], js.slice(Math.max(0, at - 160), at + m[0].length + 200).replace(/\s+/g, ' '));
    }
    console.log(`  ${new URL(url).pathname} ${res.status} ${js.length} bytes`);
  }
  for (const [lit, ctx] of literals) {
    console.log(`  literal ${lit}`);
    if (/student|schema/i.test(lit)) console.log(`    context: ${ctx}`);
  }
}

// Roster ids for the student probes (never printed).
let roster = [];
if (want('roster') || want('student') || want('schema') || want('demo') || only === 'page') {
  console.log('3. roster: getStudentsInSection.json');
  const ros = await ps.read('/teachers/mba_alerts/queries/getStudentsInSection.json', { sectionIds: sectionDcid }, { method: 'GET' });
  roster = (Array.isArray(ros) ? ros : []).filter(r => r && r.studentid);
  console.log(`  ${roster.length} students; record keys: ${Object.keys(roster[0] || {}).join(', ')}`);
}
const sample = roster.slice(0, N);

// Per-field coverage: how many records carry a set (non-null, non-empty) value at a target path.
function coverage(label, records) {
  const counts = new Map();
  for (const rec of records) {
    for (const [p, types] of keyPaths(rec)) {
      if (!targetOf(p).length) continue;
      const set = [...types].some(t => t !== 'null' && t !== 'string(0)');
      const c = counts.get(p) || { set: 0, of: 0, types: new Set() };
      c.of++; if (set) c.set++; types.forEach(t => c.types.add(t));
      counts.set(p, c);
    }
  }
  if (!counts.size) console.log(`  ${label}: no grade/gender/address key in ${records.length} records`);
  for (const [p, c] of counts) console.log(`  ${label} ${targetOf(p).join('/')} ${p}: set on ${c.set}/${records.length} (${[...c.types].join('|')})`);
}

if (want('student')) {
  // The attendance app's own chain (main.*.js): section_info gives psmSectionId;
  // getPsmStudents → GET /ws/pt/v1/section/{psmSectionId}/students_integration → "student-list".students[]
  // keyed by .id (the PSM student id); getStudent(t) → GET /ws/pt/v1/student/{t}.
  console.log('4a. section_info → psmSectionId');
  const d = new Date().toISOString().slice(0, 10);
  const info = await raw(`/ws/attendance/section_info?sectionDcid=${sectionDcid}&multiSections=false&startDate=${d}&endDate=${d}`);
  const first = Array.isArray(info.json) ? info.json[0] : info.json;
  const psmSectionId = first?.psmSectionId;
  console.log(`  ${info.status}; psmSectionId present: ${psmSectionId != null}`);

  console.log('4b. /ws/pt/v1/section/{psmSectionId}/students_integration');
  const list = await raw(`/ws/pt/v1/section/${psmSectionId}/students_integration?_=${Math.floor(Date.now() / 1000)}`);
  report('students_integration', list);
  const psmStudents = list.json?.['student-list']?.students || [];
  console.log(`  ${psmStudents.length} students; record keys: ${Object.keys(psmStudents[0] || {}).join(', ')}`);
  if (psmStudents.length) coverage('students_integration', psmStudents);
  // How the PSM id relates to the alert roster's ids (counts only).
  const sids = new Set(roster.map(r => String(r.studentid))); const dcids = new Set(roster.map(r => String(r.studentdcid)));
  for (const k of Object.keys(psmStudents[0] || {})) {
    const vals = psmStudents.map(s => String(s[k]));
    const inSid = vals.filter(v => sids.has(v)).length; const inDcid = vals.filter(v => dcids.has(v)).length;
    if (inSid || inDcid) console.log(`  key ${k}: equals a roster studentid for ${inSid}, a studentdcid for ${inDcid} (of ${vals.length})`);
  }
  // Masked value profile: types, and for short codes the number of distinct values and their lengths.
  for (const k of ['id', 'gender', 'gradeLevel', 'photoURL']) {
    const vals = psmStudents.map(s => s[k]);
    const types = [...new Set(vals.map(v => v === null ? 'null' : typeof v))].join('|');
    const lens = [...new Set(vals.filter(v => v != null).map(v => String(v).length))].sort((a, b) => a - b).join(',');
    console.log(`  ${k}: ${types}; ${new Set(vals.map(String)).size} distinct; lengths ${lens}`);
  }
  // Does the photo URL carry a roster id? (template with digits masked; counts only)
  const tmpl = new Set(psmStudents.map(s => String(s.photoURL || '').replace(/\d+/g, '#')));
  console.log(`  photoURL templates: ${[...tmpl].join(' | ')}`);
  const nums = psmStudents.map(s => String(s.photoURL || '').match(/\d+/g) || []);
  console.log(`  photoURL numbers that equal a roster studentdcid: ${nums.filter(ns => ns.some(n => dcids.has(n))).length}, a studentid: ${nums.filter(ns => ns.some(n => sids.has(n))).length} (of ${nums.length})`);

  console.log(`4c. /ws/pt/v1/student/{id} for ${Math.min(N, psmStudents.length)} students`);
  const records = [];
  for (const [i, s] of psmStudents.slice(0, N).entries()) {
    const r = await raw(`/ws/pt/v1/student/${s.id}?_=${Math.floor(Date.now() / 1000)}`);
    report(`student ${i + 1} by PSM id`, r);
    if (r.status === 200 && r.json) records.push(r.json);
  }
  if (records.length) coverage('/ws/pt/v1/student/{psmId}', records);
  else {
    // Only if the PSM id failed: the other two ids, to scope the negative.
    for (const [key, label] of [['studentdcid', 'dcid'], ['studentid', 'studentid']]) {
      const s = sample[0];
      if (s) report(`student 1 by ${label}`, await raw(`/ws/pt/v1/student/${s[key]}?_=${Math.floor(Date.now() / 1000)}`));
    }
  }
}

// page <path>[>path…]: teacher pages in one session, in the order a teacher clicks them
// (each sent with the previous as Referer); prints links (queries masked), the labels a
// teacher reads, and whether PowerSchool logged the request as a security violation.
// {dcid}/{studentid}/{sectionDcid} take the first roster student and the section.
if (only === 'page') {
  const s = roster[0] || {};
  const fill = (p) => p.replaceAll('{dcid}', s.studentdcid).replaceAll('{studentid}', s.studentid).replaceAll('{sectionDcid}', sectionDcid);
  const chain = (process.argv[5] || '/teachers/home.html').split('>').map(fill);
  let referer = process.env.PROBE_REFERER ? `${PS_BASE}${fill(process.env.PROBE_REFERER)}` : null;
  for (const path of chain) {
    const r = await raw(path, { headers: { Accept: 'text/html', ...(referer ? { Referer: referer } : {}) } });
    referer = `${PS_BASE}${path}`;
    const title = (r.text.match(/<title>([^<]*)/i) || [])[1];
    console.log(`  page ${path.split('?')[0]} → ${r.status} ${r.type}, ${r.text.length} bytes, title "${(title || '').trim()}"${/Security Violation/i.test(r.text) ? ', SECURITY VIOLATION page' : ''}`);
    const hrefs = new Set([...r.text.matchAll(/(?:href|src|action)\s*=\s*["']([^"'#]+)["']/gi)].map(m => m[1].replace(/\?.*/, '?…')).filter(h => /student|demograph|address|contact/i.test(h)));
    for (const h of hrefs) console.log(`    link ${h}`);
    // Header and label text only (no values).
    const labels = new Set([...r.text.matchAll(/<(?:th|td|label|dt|span)[^>]*>\s*([A-Za-z][A-Za-z /&()-]{2,40}?)\s*:?\s*</gi)].map(m => m[1].trim()).filter(t => TARGET.address.test(t) || TARGET.gender.test(t) || TARGET.grade.test(t)));
    console.log(`    target labels: ${[...labels].join(' | ') || '(none)'}`);
    const headers = [...r.text.matchAll(/<th[^>]*>([^<]*)/gi)].map(m => m[1].trim()).filter(Boolean);
    if (headers.length) console.log(`    table headers: ${[...new Set(headers)].join(' | ')}`);
    if (process.env.PROBE_OUT) (await import('fs')).writeFileSync(`${process.env.PROBE_OUT}/page.html`, r.text);
  }
}

// demo: the PowerTeacher student Demographics screen, reached as a teacher clicks to it
// (home → class summary → student menu → student home → Demographics, each with the
// previous page as Referer). Going straight to a student page without the summary and
// menu in the session got PowerSchool's "Security Violation Logged" page (2026-10-17).
// Prints each target row's masked value (line count and lengths), coverage per row and
// agreement with the /ws/pt/v1 record.
const DEMO_ROWS = ['Address', 'Mailing Address', 'Gender', 'Grade Level', 'Graduation Year'];
const cellText = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function demoRows(html) {
  const rows = new Map();
  for (const [, row] of html.replace(/<script[\s\S]*?<\/script>/gi, '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < 2) continue;
    const label = cellText(cells[0]);
    if (DEMO_ROWS.includes(label)) rows.set(label, cells[1].split(/<br\s*\/?>/i).map(cellText).filter(Boolean));
  }
  return rows;
}
if (want('demo')) {
  console.log(`6. demo: PowerTeacher Demographics screen for ${sample.length} students`);
  const q = `sectionid=${sectionDcid}&frn=003${sectionDcid}`;
  let referer = null;
  const page = async (path) => {
    const r = await raw(path, { headers: { Accept: 'text/html', ...(referer ? { Referer: `${PS_BASE}${referer}` } : {}) } });
    referer = path;
    const violation = /Security Violation/i.test(r.text);
    console.log(`  ${path.split('?')[0]} → ${r.status}, ${r.text.length} bytes, title "${((r.text.match(/<title>([^<]*)/i) || [])[1] || '').trim()}"${violation ? ', SECURITY VIOLATION page: stopping' : ''}`);
    if (violation) process.exit(2);
    return r;
  };
  await page('/teachers/home.html');
  await page(`/teachers/summary.html?${q}`);
  const cov = new Map(DEMO_ROWS.map(l => [l, 0]));
  const perDcid = new Map();
  for (const [i, s] of sample.entries()) {
    referer = `/teachers/summary.html?${q}`;
    await page(`/teachers/menu.html?${q}`);
    await page(`/teachers/studentpages/home.html?ac=laststudpage&sectionid=${sectionDcid}&frn=001${s.studentdcid}`);
    const r = await page(`/teachers/studentpages/demo.html?frn=001${s.studentdcid}&sectionid=${sectionDcid}`);
    const rows = demoRows(r.text);
    for (const l of DEMO_ROWS) {
      const v = rows.get(l);
      if (v && v.length) cov.set(l, cov.get(l) + 1);
      console.log(`    student ${i + 1} ${l}: ${rows.has(l) ? (v.length ? `${v.length} line(s), lengths ${v.map(x => x.length).join('+')}` : 'row present, empty') : 'row absent'}`);
    }
    perDcid.set(String(s.studentdcid), rows);
  }
  for (const [l, n] of cov) console.log(`  coverage Demographics "${l}": set on ${n}/${sample.length}`);

  // Agreement with /ws/pt/v1 (joined through photoURL → studentid → roster dcid).
  const d = new Date().toISOString().slice(0, 10);
  const info = await raw(`/ws/attendance/section_info?sectionDcid=${sectionDcid}&multiSections=false&startDate=${d}&endDate=${d}`);
  const psmSectionId = (Array.isArray(info.json) ? info.json[0] : info.json)?.psmSectionId;
  const list = await raw(`/ws/pt/v1/section/${psmSectionId}/students_integration?_=${Math.floor(Date.now() / 1000)}`);
  const dcidOfSid = new Map(roster.map(r => [String(r.studentid), String(r.studentdcid)]));
  let gEq = 0; let lEq = 0; let joined = 0;
  for (const st of list.json?.['student-list']?.students || []) {
    const sid = (String(st.photoURL || '').match(/(\d+)ph\./) || [])[1];
    const rows = perDcid.get(dcidOfSid.get(sid));
    if (!rows) continue;
    joined++;
    if ((rows.get('Gender') || [])[0] === String(st.gender)) gEq++;
    if ((rows.get('Grade Level') || [])[0] === String(st.gradeLevel)) lEq++;
  }
  console.log(`  agreement with students_integration (${joined} joined): gender equal ${gEq}, grade level equal ${lEq}`);
}

if (want('schema')) {
  // GETs only (the brief allows no POST beyond the launch): the PowerQuery list, the
  // schema table read and the /ws/v1 student read, all with a real roster dcid.
  console.log('5. schema and /ws/v1: GET candidates');
  const s = sample[0] || {};
  const COLS = 'dcid,grade_level,gender,street,city,state,zip,mailing_street,mailing_city,mailing_state,mailing_zip';
  const CANDIDATES = (process.env.PROBE_SCHEMA_PATHS || [
    '/ws/schema/query/api',
    `/ws/schema/table/students/{dcid}?projection=${COLS}`,
    `/ws/schema/table/students?q=dcid=={dcid}&projection=${COLS}`,
    '/ws/v1/student/{dcid}?expansions=addresses,demographics,school_enrollment',
  ].join('|')).split('|').filter(Boolean);
  for (const tmpl of CANDIDATES) {
    const path = tmpl.replaceAll('{sectionDcid}', sectionDcid).replaceAll('{dcid}', s.studentdcid).replaceAll('{studentid}', s.studentid);
    report(`GET ${tmpl.replace(/\?.*/, '?…')}`, await raw(path));
  }
}
