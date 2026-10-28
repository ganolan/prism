#!/usr/bin/env node
// Probe (#190, read only, Graham approved 28 Oct 2026: 3 students of one current
// class): which PowerTeacher student screen, if any, names a student's counsellor or
// community. Follows the teacher's click path (home → class summary → student menu →
// student home, each with the previous page as Referer; see AGENTS.md), lists the
// student home page's screen picker, then reads each screen for student 1 and prints its
// row labels. Screens with a counsellor-like label are read for students 2 and 3 too.
// Never prints a value: a matching row's value is shown as its format (letters a, digits 9).
// Headings print only when they match a counsellor word, names masked: a list screen's
// headings can be student names (Schedule Matrix (All), 28 Oct 2026).
// Stops on PowerSchool's Security Violation page. GETs only, after the LTI launch sign-in.
// Findings: .claude/powerschool-api-reference.md "Student counsellors (#190)".
// Usage (repo root): node --env-file=.env scripts/probe-ps-counsellor.js <schoologySectionId>
//   COUNSELORS=1 the counsellor read (JOIN=1 also matches each to the Schoology Advisors row);
//   SCREENS="A|B" only these screens; CODE="/scripts/x.js" fetch script files; PROBE_OUT=<dir> keep pages.
import 'dotenv/config';
import { cookieJar, getResource } from '../server/services/schoologyWeb.js';
import { apiGet, getSectionEnrollments } from '../server/services/schoology.js';
import { PowerSchoolWeb, PS_BASE } from '../server/services/powerschoolWeb.js';

const MAX_STUDENTS = 3;
const MAX_SCREENS = 30;
const HIT = /counsel|advis|community|house|mentor|case manager|dean|guidance/i;
const sectionId = process.argv[2];
if (!sectionId) { console.error('usage: probe-ps-counsellor.js <schoologySectionId>'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sgyJar = cookieJar();
if (!sgyJar) { console.error('no saved Schoology session'); process.exit(1); }
const ps = new PowerSchoolWeb({ sgyJar });

const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const maskNames = (s) => s.replace(/\S+@\S+/g, '<email>').replace(/\d{3,}/g, '<n>').replace(/\b[A-Z][a-z'-]+\b/g, (w) => (HIT.test(w) ? w : 'Xx'));
const formatOf = (v) => v.replace(/\S+@\S+/g, '<email>').replace(/\d/g, '9').replace(/[A-Za-z]/g, 'a');

let referer = null;
async function page(path, ref = referer) {
  await sleep(300);
  const res = await fetch(`${PS_BASE}${path}`, { redirect: 'manual', headers: { cookie: ps.jar.header(), Accept: 'text/html', ...(ref ? { Referer: `${PS_BASE}${ref}` } : {}) } });
  ps.jar.take(res);
  const body = await res.text();
  referer = path;
  const title = ((body.match(/<title>([^<]*)/i) || [])[1] || '').trim();
  if (/Security Violation/i.test(body)) { console.log(`  ${path.split('?')[0]} → SECURITY VIOLATION page: stopping`); process.exit(2); }
  return { status: res.status, body, title };
}

// Label/value rows of a screen: a <tr> whose first cell is a short label.
function rows(html) {
  const out = [];
  for (const [, row] of html.replace(/<script[\s\S]*?<\/script>/gi, '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => text(m[1]));
    if (cells.length >= 2 && cells[0] && cells[0].length <= 50) out.push({ label: cells[0], value: cells.slice(1).join(' | ') });
  }
  return out;
}
// Headings and table header cells, for screens that are lists rather than label rows.
const headings = (html) => [...new Set([...html.matchAll(/<(h\d|th)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => text(m[2])).filter((t) => t && t.length <= 50))];

console.log('1. launch');
const { sectionDcid } = await ps.launchIds(sectionId);
await ps.launch(sectionId);
// CODE="/scripts/a.js|/scripts/b.js": fetch these script files (code, no student data) into PROBE_OUT and stop.
if (process.env.CODE) {
  for (const path of process.env.CODE.split('|')) {
    const res = await fetch(`${PS_BASE}${path}`, { headers: { cookie: ps.jar.header() } });
    const js = await res.text();
    console.log(`  code ${path} → ${res.status}, ${js.length} bytes`);
    if (process.env.PROBE_OUT) (await import('fs')).writeFileSync(`${process.env.PROBE_OUT}/${path.replace(/\W+/g, '_')}`, js);
  }
  process.exit(0);
}
const roster = ((await ps.read('/teachers/mba_alerts/queries/getStudentsInSection.json', { sectionIds: sectionDcid }, { method: 'GET' })) || []).filter((r) => r?.studentid);
const sample = roster.slice(0, MAX_STUDENTS);
console.log(`  roster ${roster.length}; probing ${sample.length}`);

const q = `sectionid=${sectionDcid}&frn=003${sectionDcid}`;
await page('/teachers/home.html', null);
await page(`/teachers/summary.html?${q}`);

async function studentHome(s) {
  referer = `/teachers/summary.html?${q}`;
  await page(`/teachers/menu.html?${q}`);
  return page(`/teachers/studentpages/home.html?ac=laststudpage&sectionid=${sectionDcid}&frn=001${s.studentdcid}`);
}

// COUNSELORS=1: the student header's counsellor pop-up read, GET /ws/studentcounselor/{dcid}
// (/scripts/components/counselor/services/counselorService.js; the same file's POSTs save
// counsellors and are never sent), after each student's Demographics screen as a teacher
// clicks it. Prints keys, value types, the count and how many are primary; never a value.
if (process.env.COUNSELORS) {
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v === 'string' ? `string(${v.length})` : typeof v);
  let enrolments = null;
  const seen = new Map(); // uniform key per counsellor, to count distinct counsellors across students
  for (const [i, s] of sample.entries()) {
    await studentHome(s);
    const demo = `/teachers/studentpages/demo.html?frn=001${s.studentdcid}&sectionid=${sectionDcid}`;
    await page(demo);
    await sleep(300);
    const res = await fetch(`${PS_BASE}/ws/studentcounselor/${s.studentdcid}`, { redirect: 'manual', headers: { cookie: ps.jar.header(), Accept: 'application/json', Referer: `${PS_BASE}${demo}` } });
    const body = await res.text();
    let json; try { json = JSON.parse(body); } catch { /* not JSON */ }
    console.log(`student ${i + 1}: ${res.status} ${(res.headers.get('content-type') || '').split(';')[0]}, ${body.length} bytes${json === undefined ? ', not JSON' : ''}`);
    if (!Array.isArray(json)) { if (json) console.log(`  top keys: ${Object.keys(json).join(', ')}`); continue; }
    console.log(`  ${json.length} counsellor(s), ${json.filter((c) => c.isPrimary).length} primary`);
    for (const c of json) {
      console.log(`  record: ${Object.entries(c).map(([k, v]) => `${k}: ${typeOf(v)}${typeof v === 'boolean' ? `=${v}` : ''}`).join(', ')}`);
      const key = JSON.stringify([c.userFirstName, c.userLastName]);
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(`S${i + 1}${c.isPrimary ? '*' : ''}`);
    }
    // JOIN=1: is each counsellor in the student's Schoology Advisors row (/user/{uid}/info), and does
    // that profile carry an email? The student is joined by school_uid = "1_" + dcid; names are
    // compared in code (first or preferred first, and last, case-folded) and only counts print.
    if (process.env.JOIN) {
      enrolments ??= await getSectionEnrollments(sectionId);
      const enr = enrolments.find((e) => e.school_uid === `1_${s.studentdcid}`);
      if (!enr) { console.log('  join: no Schoology enrolment with this school_uid'); continue; }
      const info = await getResource(sgyJar, `/user/${enr.uid}/info`, { accept: 'text/html' });
      const row = [...info.text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).find((r) => /<th[^>]*>\s*Advisors\s*</i.test(r)) || '';
      const advisors = [...new Set([...row.matchAll(/href="\/user\/(\d+)/g)].map((m) => m[1]))];
      const profiles = [];
      for (const a of advisors) { try { profiles.push(await apiGet(`/users/${a}`)); } catch { /* skip */ } }
      const fold = (x) => String(x || '').trim().toLowerCase();
      for (const [j, c] of json.entries()) {
        const hit = profiles.filter((p) => fold(p.name_last) === fold(c.userLastName) && [p.name_first, p.name_first_preferred].map(fold).includes(fold(c.userFirstName)));
        console.log(`  join counsellor ${j + 1}${c.isPrimary ? ' (primary)' : ''}: ${hit.length} of ${advisors.length} advisors match by name${hit.length ? `; email set: ${Boolean(hit[0].primary_email)}, @hkis.edu.hk: ${/@hkis\.edu\.hk$/i.test(hit[0].primary_email || '')}` : ''}`);
      }
    }
  }
  console.log(`distinct counsellors across the ${sample.length} students: ${[...seen.values()].map((v, j) => `C${j + 1} on ${v.join(',')}`).join('; ')} (* = primary)`);
  process.exit(0);
}

// 2. The screen picker, from student 1's home page.
const home = await studentHome(sample[0]);
const picker = [];
for (const m of home.body.matchAll(/<(a|option)[^>]*(?:href|value)\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/\1>/gi)) {
  const href = m[2].replace(/&amp;/g, '&');
  const name = text(m[3]);
  if (!name || /delete|save|submit|logout|signout/i.test(href)) continue;
  if (!/studentpages|\.html/i.test(href)) continue;
  if (/^\[|^\d+$|^'/.test(name)) continue; // score and attendance-count links, template strings
  if (!picker.some((p) => p.href.split('?')[0] === href.split('?')[0])) picker.push({ name, href });
}
console.log(`2. student home "${home.title}": ${picker.length} screen links`);
for (const p of picker) console.log(`  "${p.name}" → ${p.href.replace(/\d{4,}/g, '<n>').replace(/\?.*/, '?…')}`);

// 3. Each screen for student 1: its row labels and headings.
const absolute = (href) => (href.startsWith('/') ? href : `/teachers/studentpages/${href}`);
const fill = (href, s) => href.replace(new RegExp(String(sample[0].studentdcid), 'g'), String(s.studentdcid));
const hitScreens = [];
const homePath = referer;
// SCREENS="Name|Name": read only these screens (by picker name).
const only = process.env.SCREENS ? new Set(process.env.SCREENS.split('|')) : null;
for (const p of picker.filter((x) => !only || only.has(x.name)).slice(0, MAX_SCREENS)) {
  const path = absolute(p.href);
  if (!path.startsWith('/teachers/') && !path.startsWith('/guardian/') && !path.startsWith('/ws/')) { console.log(`  skip "${p.name}" (outside PowerTeacher)`); continue; }
  const r = await page(path, homePath);
  // PROBE_OUT=<dir>: keep the screen's page for a closer read of its scripts (holds student data: delete after).
  if (process.env.PROBE_OUT) (await import('fs')).writeFileSync(`${process.env.PROBE_OUT}/${p.name.replace(/\W+/g, '_')}.html`, r.body);
  const rs = rows(r.body);
  const hits = rs.filter((x) => HIT.test(x.label));
  const heads = headings(r.body);
  console.log(`3. "${p.name}" → ${r.status}, ${r.body.length} bytes, title "${r.title}", ${rs.length} rows`);
  console.log(`    labels: ${JSON.stringify([...new Set(rs.map((x) => x.label))].slice(0, 40))}`);
  // Headings can be student names (Schedule Matrix (All) lists the class): print only matching ones, masked.
  const hitHeads = heads.filter((h) => HIT.test(h));
  console.log(`    ${heads.length} headings${hitHeads.length ? `; matching: ${JSON.stringify(hitHeads.map(maskNames))}` : ''}`);
  const textHits = [...text(r.body).matchAll(new RegExp(HIT.source, 'gi'))].length;
  if (hits.length || textHits) {
    hitScreens.push(p);
    for (const h of hits) console.log(`    HIT row "${h.label}": format ${formatOf(h.value).slice(0, 80)}`);
    console.log(`    keyword mentions in page text: ${textHits}`);
    for (const m of [...text(r.body).matchAll(new RegExp(HIT.source, 'gi'))].slice(0, 4)) console.log(`      …${maskNames(text(r.body).slice(Math.max(0, m.index - 40), m.index + m[0].length + 40))}…`);
  }
}

// 4. Screens with a hit, for students 2 and 3 (same click path per student).
for (const [i, s] of sample.slice(1).entries()) {
  const h = await studentHome(s);
  const hp = referer;
  for (const p of hitScreens) {
    const r = await page(fill(absolute(p.href), s), hp);
    const hits = rows(r.body).filter((x) => HIT.test(x.label));
    console.log(`4. student ${i + 2} "${p.name}" (${h.status}/${r.status}): ${hits.map((x) => `"${x.label}" format ${formatOf(x.value).slice(0, 60)}`).join('; ') || 'no matching row'}`);
  }
}
