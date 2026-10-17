#!/usr/bin/env node
// Probe (#117, read only): can the PowerSchool MBA custom-alert reads run over plain
// HTTP, with no browser? Launches the attendance LTI tool by fetch (Schoology run URL
// → launch form → POST its fields to the form's PowerSchool action), keeps PowerSchool's
// cookies, then reads the alert catalogue, a section's roster, the field values, the
// advanced-alert matches and the manual alerts. Findings: .claude/powerschool-api-reference.md
// "Student alerts over plain HTTP (#117)".
//
// Masks every student value: prints status codes, field names, value types and counts only.
// Usage: node scripts/probe-ps-alerts-http.js <schoologySectionId> [step]
//   step: launch | catalogue | roster (stop after it), wsinfo (section_info only),
//         insertions (the plugin code, saved to PROBE_OUT), scripts (the app's script tags);
//   no step: every read in order.
import 'dotenv/config';
import { readFileSync } from 'fs';
import { sessionStateFile } from '../server/lib/sessionPaths.js';

const SGY = 'https://schoology.hkis.edu.hk';
const PS = 'https://powerschool.hkis.edu.hk';
const APP = '4980125287';
const sectionId = process.argv[2];
const only = process.argv[3];
if (!sectionId) { console.error('usage: probe-ps-alerts-http.js <schoologySectionId> [step]'); process.exit(1); }

// One jar per host (name → value), seeded from the saved session.
const jars = new Map();
const jarFor = (host) => { if (!jars.has(host)) jars.set(host, new Map()); return jars.get(host); };
const state = JSON.parse(readFileSync(sessionStateFile(), 'utf8'));
for (const c of state.cookies || []) {
  const domain = String(c.domain || '').replace(/^\./, '');
  jarFor(domain).set(c.name, c.value);
}
const cookieHeader = (host) => {
  const out = [];
  for (const [domain, jar] of jars) {
    if (host === domain || host.endsWith(`.${domain}`)) for (const [k, v] of jar) out.push(`${k}=${v}`);
  }
  return out.join('; ');
};
const take = (host, res) => {
  for (const line of res.headers.getSetCookie?.() || []) {
    const [pair, ...attrs] = line.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const dom = attrs.map(a => a.trim()).find(a => /^domain=/i.test(a));
    const d = dom ? dom.slice(7).replace(/^\./, '') : host;
    jarFor(d).set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
};
const maskUrl = (u) => { try { const x = new URL(u); return `${x.host}${x.pathname}${x.search ? '?…' : ''}`; } catch { return '(bad url)'; } };

async function request(url, { method = 'GET', body, headers = {}, follow = 8 } = {}) {
  let cur = url; let m = method; let b = body;
  for (let hop = 0; hop <= follow; hop++) {
    const host = new URL(cur).host;
    const res = await fetch(cur, {
      method: m, body: b, redirect: 'manual',
      headers: { cookie: cookieHeader(host), 'User-Agent': 'Mozilla/5.0', ...headers },
    });
    take(host, res);
    console.log(`  ${m} ${maskUrl(cur)} → ${res.status}`);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location') || '';
      cur = new URL(loc, cur).href;
      if (res.status !== 307 && res.status !== 308) { m = 'GET'; b = undefined; }
      continue;
    }
    return { url: cur, status: res.status, text: await res.text(), type: res.headers.get('content-type') };
  }
  throw new Error('too many redirects');
}

const shape = (v, depth = 0) => {
  if (Array.isArray(v)) return `array(${v.length})${v.length && depth < 2 ? ` of ${shape(v[0], depth + 1)}` : ''}`;
  if (v && typeof v === 'object') return `{ ${Object.keys(v).map(k => `${k}: ${depth < 2 ? shape(v[k], depth + 1) : typeof v[k]}`).join(', ')} }`;
  if (typeof v === 'string') return `string(${v.length})`;
  return typeof v;
};

function formOf(html) {
  const action = (html.match(/<form[^>]*action="([^"]+)"/i) || [])[1];
  const inputs = {};
  for (const [tag] of html.matchAll(/<input\b[^>]*>/gi)) {
    const name = (tag.match(/name="([^"]*)"/i) || [])[1];
    const value = (tag.match(/value="([^"]*)"/i) || [])[1] ?? '';
    if (name) inputs[name] = value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  return { action: action?.replace(/&amp;/g, '&'), inputs };
}

const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' };

console.log('1. launch');
const run = await request(`${SGY}/apps/lti/${APP}/run/course/${sectionId}`);
const launch = formOf(run.text);
console.log(`  form action: ${launch.action ? maskUrl(launch.action) : '(none)'}; fields: ${Object.keys(launch.inputs).join(', ')}`);
const sectionDcid = launch.inputs.custom_sectiondcid;
if (!launch.action) process.exit(1);
const landed = await request(launch.action, { method: 'POST', body: form(launch.inputs), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
console.log(`  landed on ${maskUrl(landed.url)} (${landed.type}, ${landed.text.length} bytes)`);
console.log(`  PowerSchool cookies: ${[...(jars.get(new URL(PS).host) || new Map()).keys()].join(', ') || '(none)'}`);
if (only === 'launch') process.exit(0);
if (only === 'wsinfo') {
  // #141 lead: does the plain-HTTP session also carry the /ws/attendance reads?
  const d = new Date().toISOString().slice(0, 10);
  const res = await request(`${PS}/ws/attendance/section_info?sectionDcid=${sectionDcid}&multiSections=false&startDate=${d}&endDate=${d}`, { headers: { Accept: 'application/json' } });
  let j = null; try { j = JSON.parse(res.text); } catch { /* */ }
  const first = Array.isArray(j) ? j[0] : j;
  console.log(`  section_info: ${res.status}, ${j ? `${Array.isArray(j) ? `array(${j.length})` : 'object'}; first has bellScheduleItems: ${Boolean(first?.bellScheduleItems)}, calenderDays: ${first?.calenderDays ? Object.keys(first.calenderDays).length : 0}` : 'not JSON'}`);
  process.exit(0);
}
if (only === 'insertions') {
  const res = await request(`${PS}/ws/pagecustomizations/insertions?_=${Math.floor(Date.now() / 1000)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', Origin: PS, Referer: `${PS}/integrations/attendance/index.html` },
    body: JSON.stringify({ path: '/integrations/attendance/index.html', insertions: ['content.footer'], parameters: [{ sectionid: String(sectionDcid), frn: `003${sectionDcid}`, att_period: '', att_date: new Date().toLocaleDateString('en-US'), Att_Mode_Code: 'ATT_ModeMeeting', pagetype: 'meeting', ATT_Source_Code: 'Teacher', Period_ID: '' }] }),
  });
  console.log(`  ${res.type}, ${res.text.length} bytes`);
  if (process.env.PROBE_OUT) (await import('fs')).writeFileSync(process.env.PROBE_OUT, res.text);
  process.exit(0);
}
if (only === 'scripts') {
  for (const [, src] of landed.text.matchAll(/<script[^>]*src="([^"]+)"/gi)) console.log(`  script ${src}`);
  process.exit(0);
}

console.log('2. catalogue: getAlertTypes.json');
const cat = await request(`${PS}/teachers/mba_alerts/queries/getAlertTypes.json`, { method: 'POST', body: form({ disabled: 0, student_schoolid: 40 }), headers: FORM });
let defs = [];
try { defs = JSON.parse(cat.text); } catch { console.log(`  not JSON: ${cat.type} ${cat.text.length} bytes`); }
if (Array.isArray(defs)) {
  console.log(`  ${defs.length} entries; first: ${shape(defs[0])}`);
  for (const d of defs) if (d && d.id) console.log(`   ${d.id}\t${d.trigger_type}\t${d.ext_table_name || ''}\t${d.student_field || ''}\top=${d.student_field_operator}\toperand=${JSON.stringify(d.student_field_operand)}\tinv=${d.student_field_invert}\tqs=${d.querystring}\turl=${d.trigger_url}\tstub=${d.stub_url}\t${d.name}`);
  console.log(`  last entry: ${shape(defs[defs.length - 1])}`);
}
if (only === 'catalogue') process.exit(0);

console.log(`3. roster: getStudentsInSection.json (sectionDcid present: ${Boolean(sectionDcid)})`);
const ros = await request(`${PS}/teachers/mba_alerts/queries/getStudentsInSection.json`, { method: 'POST', body: form({ sectionIds: sectionDcid }), headers: FORM });
let roster = [];
try { roster = JSON.parse(ros.text); } catch { console.log(`  not JSON: ${ros.type} ${ros.text.length} bytes`); }
console.log(`  ${shape(roster)}`);
if (only === 'roster') process.exit(0);

console.log('4. values: stuFieldValues.json (as the plugin builds it: stuList = PS studentid)');
const sids = (Array.isArray(roster) ? roster : []).map(r => r.studentid).filter(Boolean);
const sfTypes = defs.filter(d => d && d.trigger_type === 'sf');
const buildParams = (list) => {
  const params = new URLSearchParams({ stuList: list, student_id: list });
  const joins = new Set();
  sfTypes.forEach((t, n) => {
    let field = t.student_field; let table = 'students';
    if (field.includes('.')) { field = field.split('.')[1]; table = t.ext_table_name; joins.add(table); }
    params.append(`field${n + 1}`, field.toLowerCase());
    params.append(`fieldTbl${n + 1}`, table);
  });
  [...joins].forEach((t, n) => params.append(`table${n + 1}`, t));
  return params;
};
const cls = (val) => val === null ? 'null' : typeof val === 'string' ? `string(${val.length})` : typeof val;
const getValues = async (list, method) => {
  const p = buildParams(list);
  const res = method === 'POST'
    ? await request(`${PS}/teachers/mba_alerts/queries/stuFieldValues.json`, { method: 'POST', body: p.toString(), headers: FORM })
    : await request(`${PS}/teachers/mba_alerts/queries/stuFieldValues.json?${p}`, { headers: { Accept: 'application/json' } });
  let j = null; try { j = JSON.parse(res.text); } catch { /* */ }
  return { res, j };
};
const one = await getValues(String(sids[0]), 'GET');
console.log(`  single student (GET): ${one.res.status}, ${Array.isArray(one.j) ? `array(${one.j.length})` : 'not JSON'}`);
if (Array.isArray(one.j)) console.log(`   [0] keys/types: ${Object.entries(one.j[0] || {}).map(([k, v]) => `${k}=${cls(v)}`).join(' ')}\n   last: ${JSON.stringify(Object.keys(one.j[one.j.length - 1] || {}))}`);
for (const method of ['GET', 'POST']) {
  const all = await getValues(sids.join(','), method);
  if (!Array.isArray(all.j)) { console.log(`  batch (${method}): not JSON (${all.res.status})`); continue; }
  const recs = all.j.filter(r => r && r.id != null);
  const inRoster = new Set(sids.map(String));
  const dcidOf = new Map(roster.filter(r => r && r.studentid).map(r => [String(r.studentid), String(r.studentdcid)]));
  const last = all.j[all.j.length - 1];
  console.log(`  batch of ${sids.length} (${method}): ${all.j.length} entries, ${recs.length} with id, ${recs.filter(r => inRoster.has(String(r.id))).length} ids in roster, ${recs.filter(r => dcidOf.get(String(r.id)) === String(r.dcid)).length} whose dcid = the roster studentdcid; last entry ${Array.isArray(last) ? 'array' : typeof last} keys ${JSON.stringify(Object.keys(last || {}))}`);
  if (method === 'GET') {
    // Which alerts fire, by the plugin's own rules: counts only.
    const match = (t, stu) => {
      const fld = (t.student_field.split('.')[1] || t.student_field).toLowerCase();
      let fieldVal = stu[fld] == null ? '' : String(stu[fld]).toLowerCase();
      const operand = t.student_field_operand ? t.student_field_operand.split(',').map(e => e.trim() === '' ? '\u0000blank' : e.trim().toLowerCase()) : [];
      if (operand.includes('\u0000blank') && fieldVal === '') fieldVal = '\u0000blank';
      const op = t.student_field_operator;
      if (op === 'notblank') return stu[fld] != null;
      if (op === 'blank') return stu[fld] == null;
      if (op === 'notin') return !operand.includes(fieldVal);
      if (op === 'in') return operand.includes(fieldVal);
      if (op === 'contains') return fieldVal.includes(operand[0]);
      if (op === 'notcontain') return !fieldVal.includes(operand[0]);
      return false;
    };
    for (const t of sfTypes) {
      const fld = (t.student_field.split('.')[1] || t.student_field).toLowerCase();
      const present = recs.filter(r => fld in r).length;
      const nonNull = recs.filter(r => r[fld] != null).length;
      const types = [...new Set(recs.map(r => cls(r[fld])))].join('|');
      console.log(`   ${t.name}: field ${fld} present ${present}, non-null ${nonNull} (${types}), fires ${recs.filter(r => match(t, r)).length}`);
    }
  }
}

console.log('5. adv: getAdvTriggerMatches.html (shape only)');
for (const t of defs.filter(d => d && d.trigger_type === 'adv' && d.trigger_url !== 'QUERY_CHECK.html')) {
  const path = `${PS}/teachers/mba_alerts/queries/getAdvTriggerMatches.html${t.querystring ? `?${t.querystring}` : ''}`;
  const res = await request(path, { method: 'POST', body: form({ trigger_url: t.trigger_url, studentIds: sids.join(','), frn: '', querystring: t.querystring }), headers: FORM });
  let j = null; try { j = JSON.parse(res.text); } catch { /* */ }
  const keys = j && typeof j === 'object' ? (Array.isArray(j) ? j.filter(x => x && typeof x === 'object').flatMap(Object.keys) : Object.keys(j)) : [];
  const inRoster = new Set(sids.map(String));
  const vt = j && !Array.isArray(j) ? [...new Set(Object.entries(j).map(([k, v]) => `${k === '-1' ? 'meta:' : ''}${v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v === 'object' ? `{${Object.keys(v).join(',')}}` : typeof v === 'string' ? `string(${v.length})` : typeof v}`))] : [];
  console.log(`   value types: ${vt.join(' | ')}`);
  console.log(`   ${t.name} (${t.trigger_url}): ${res.status} ${res.type}, ${res.text.length} bytes, ${j ? `${Array.isArray(j) ? `array(${j.length})` : 'object'}, ${keys.filter(k => inRoster.has(k)).length} roster-studentid keys, other keys ${JSON.stringify([...new Set(keys.filter(k => !inRoster.has(k)))].slice(0, 5))}` : 'not JSON'}`);
}

console.log('6. man: getAlerts.json (shape only)');
const manTypes = defs.filter(d => d && d.trigger_type === 'man');
const man = await request(`${PS}/teachers/mba_alerts/queries/getAlerts.json`, { method: 'POST', body: form({ typeIds: manTypes.map(t => t.id).join(','), studentIds: sids.join(',') }), headers: FORM });
let mj = null; try { mj = JSON.parse(man.text); } catch { /* */ }
console.log(`  ${man.status} ${man.type}, ${mj ? shape(mj) : 'not JSON'}`);
