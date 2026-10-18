#!/usr/bin/env node
// Probe (#163, read only): the detail behind two PowerSchool alerts, the SPP
// (accommodation plan) and the Student Support Summary. Each alert icon in the
// attendance grid is a link the MBA custom-alerts plugin builds (api.makeAlert in
// the plugin code from /ws/pagecustomizations/insertions) and PowerSchool opens as a
// dialog from the attendance page:
//   /teachers/alerts/aet_customalert_custompopup.html?url={stub_url}&frn=001{dcid}&id={alertId}
//   + sf alerts: &frn=001{dcid}&mba_frn=001{dcid}&student_field={table}.{FIELD}&tableName={table}
//   + adv alerts: &{querystring}&studentid=…&sectionid=… (when the plugin has them)
// This probe follows that path: the LTI launch lands on the attendance page, and the
// popup is requested from it (Referer = the attendance page, as the dialog does).
//
// Masks every student value: prints status, the page title, label texts and the
// length and kind of each value, never a value or a name. Stops at once on a
// "Security Violation" page (a wrong click path is logged at school, #116).
//
//   node --env-file=.env scripts/probe-ps-alert-popups.js <sgySectionId> catalogue
//   node --env-file=.env scripts/probe-ps-alert-popups.js <sgySectionId> pick <pickFile>
//        (one student per alert from the section's roster, saved to pickFile; counts only)
//   node --env-file=.env scripts/probe-ps-alert-popups.js <sgySectionId> popup <alertId> <pickFile>
import { readFileSync, writeFileSync } from 'fs';
import { cookieJar } from '../server/services/schoologyWeb.js';
import { PowerSchoolWeb, PS_BASE } from '../server/services/powerschoolWeb.js';

const [sectionId, step, arg3, arg4] = process.argv.slice(2);
const ALERTS = ['10593860', '11290981']; // Accommodation Plan (SPP), Student Support Summary
const ATTENDANCE_PAGE = `${PS_BASE}/integrations/attendance/index.html`;

const ps = new PowerSchoolWeb({ sgyJar: cookieJar() });
await ps.launch(sectionId);
console.log('launch: PowerSchool session started');

const types = await ps.read('/teachers/mba_alerts/queries/getAlertTypes.json', { disabled: 0, student_schoolid: 40 });
const defs = (Array.isArray(types) ? types : []).filter((t) => ALERTS.includes(String(t.id)));

if (step === 'catalogue') {
  for (const t of defs) {
    const { id, name, trigger_type, stub_url, querystring, trigger_url, student_field, ext_table_name } = t;
    console.log(JSON.stringify({ id, name, trigger_type, stub_url, querystring, trigger_url, student_field, ext_table_name }));
  }
  process.exit(0);
}

const Q = '/teachers/mba_alerts/queries/';
if (step === 'pick') {
  const { sectionDcid } = await ps.launchIds(sectionId);
  const roster = (await ps.read(`${Q}getStudentsInSection.json`, { sectionIds: sectionDcid })).filter((r) => r && r.studentid);
  const ids = roster.map((r) => r.studentid).join(',');
  const spp = await ps.read(`${Q}stuFieldValues.json`, { stuList: ids, student_id: ids, field1: 'x_spp', fieldTbl1: 'U_DEF_EXT_STUDENTS', table1: 'U_DEF_EXT_STUDENTS' });
  const sppRows = (Array.isArray(spp) ? spp : []).filter((r) => r && String(r.x_spp ?? '').trim() === '1');
  const ss = defs.find((t) => String(t.id) === '11290981');
  const adv = await ps.read(`${Q}getAdvTriggerMatches.html`, { trigger_url: ss.trigger_url, studentIds: ids, frn: '', querystring: ss.querystring || '' });
  const ssIds = Object.keys(adv || {}).filter((k) => k !== '-1');
  const byId = new Map(roster.map((r) => [String(r.studentid), r]));
  const sppStudent = byId.get(String(sppRows[0]?.studentid ?? sppRows[0]?.id ?? ''));
  const ssStudent = byId.get(ssIds[0]);
  const pick = {
    sectionDcid,
    10593860: sppStudent && { dcid: sppStudent.studentdcid, studentid: sppStudent.studentid },
    11290981: ssStudent && { dcid: ssStudent.studentdcid, studentid: ssStudent.studentid },
  };
  writeFileSync(arg3, JSON.stringify(pick));
  console.log(`roster ${roster.length}; with X_SPP = 1: ${sppRows.length}; Support Summary matches: ${ssIds.length}; spp row keys: ${JSON.stringify(Object.keys(spp?.[0] || {}))}`);
  console.log(`picked: SPP ${pick[10593860] ? 'yes' : 'none'}, Support Summary ${pick[11290981] ? 'yes' : 'none'} (saved, not printed)`);
  process.exit(0);
}

if (step !== 'popup' || !arg3 || !arg4) {
  console.error('usage: <sgySectionId> catalogue | pick <pickFile> | popup <alertId> <pickFile>');
  process.exit(2);
}
const alertId = arg3;
const picked = JSON.parse(readFileSync(arg4, 'utf8'));
const chosen = picked[alertId];
if (!chosen) throw new Error(`no student picked for alert ${alertId}`);
const dcid = String(chosen.dcid);
const studentId = String(chosen.studentid);
const def = defs.find((t) => String(t.id) === String(alertId));
if (!def) throw new Error(`alert ${alertId} is not one of ${ALERTS.join(', ')}`);

// The plugin's href, built the same way (api.makeAlert).
const p = new URLSearchParams({ url: def.stub_url, frn: `001${dcid}`, id: String(def.id) });
let href = `/teachers/alerts/aet_customalert_custompopup.html?${p}`;
if (def.trigger_type === 'sf') {
  const field = String(def.student_field).includes('.') ? `${def.ext_table_name}.${String(def.student_field).split('.')[1]}` : def.student_field;
  const sf = new URLSearchParams({ frn: `001${dcid}`, mba_frn: `001${dcid}`, student_field: field });
  if (def.ext_table_name) sf.set('tableName', def.ext_table_name);
  href += `&${sf}`;
}
if (def.trigger_type === 'adv') {
  if (def.querystring) href += `&${def.querystring}`;
  if (studentId) href += `&${new URLSearchParams({ studentid: studentId })}`;
}
console.log('popup path (ids masked):', href.replace(/\d{5,}/g, (m) => (m === String(def.id) ? m : '…')));

const res = await fetch(`${PS_BASE}${href}`, {
  headers: {
    cookie: ps.jar.header(), Referer: ATTENDANCE_PAGE,
    Accept: 'text/html, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
  },
  redirect: 'manual',
});
ps.jar.take(res);
const html = await res.text();
console.log('status', res.status, res.headers.get('content-type'), `${html.length} bytes`, res.headers.get('location') ? `→ ${new URL(res.headers.get('location'), PS_BASE).pathname}` : '');
if (/Security Violation/i.test(html)) {
  console.log('STOP: PowerSchool answered with a Security Violation page.');
  process.exit(3);
}

if (html.length < 400) {
  // A short answer: show its shape only (tags and words of 3+ letters kept, other text masked).
  console.log('short answer shape:', html.replace(/>([^<]*)</g, (m, t) => `>${t.replace(/[A-Za-z0-9]/g, 'x')}<`).replace(/\d/g, '9'));
}
// Masked structure: labels as text, values as kind + length only.
const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
console.log('title:', strip((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '(none)'));
const labels = [...html.matchAll(/<(th|label|dt|h[1-4]|b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => strip(m[2])).filter(Boolean);
console.log('labels:', JSON.stringify([...new Set(labels)].slice(0, 60)));
const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
const kind = (v) => (!v ? 'empty' : /^\d+(\.\d+)?$/.test(v) ? `number(${v.length})` : /\d+\s*%|\d+\s*(min|minutes|x|time)/i.test(v) ? `measure-like(${v.length})` : `text(${v.length})`);
console.log('cells:', cells.length, JSON.stringify(cells.slice(0, 80).map(kind)));
const forms = [...html.matchAll(/<(input|select|textarea)\b[^>]*name="([^"]+)"/gi)].map((m) => `${m[1]}:${m[2]}`);
console.log('form fields:', JSON.stringify([...new Set(forms)].slice(0, 40)));
const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|json|html)[^"]*)"/gi)].map((m) => m[1].replace(/\d{5,}/g, '…'));
console.log('linked:', JSON.stringify([...new Set(scripts)].slice(0, 30)));
