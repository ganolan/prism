#!/usr/bin/env node
// Probe (#66, read only): which PowerSchool guardian is which Prism parent, and who
// may be contacted. Over plain HTTP on the attendance LTI session (no browser):
//   catalogue — the guardian-contact alerts in getAlertTypes.json (school configuration);
//   values    — stuFieldValues.json for X_HomeEmail and the four contact fields, per section
//               (value codes and counts; these fields hold codes, not contact details);
//   emg       — the class Emergency Contact List (/teachers/StudEmgContacts.html), reached as
//               a teacher clicks to it (home.html, then the list, with home as Referer);
//   corr      — the correspondence pop-up (stub_url of the Correspondence alerts) for n
//               students, requested as its dialog requests it from the attendance page
//               (PowerSchoolWeb.page, the #163 path the Support Summary read uses).
// Joins each answer to the Prism parents of the same student (by school_uid) in the
// database at PROBE_DB (opened read only) and prints match counts.
//
// Masks every student and guardian value: prints status codes, headers, labels, cell
// lengths and counts, never a name, an email, a phone number or an id. Stops at once
// on a "Security Violation" page.
//
//   PRISM_SESSION_DIR=… PROBE_DB=… node scripts/probe-ps-guardian-contacts.js <sgySectionId,…> [step] [n]
import 'dotenv/config';
import Database from 'better-sqlite3';
import { cookieJar } from '../server/services/schoologyWeb.js';
import { PowerSchoolWeb, PS_BASE } from '../server/services/powerschoolWeb.js';

const sections = String(process.argv[2] || '').split(',').filter(Boolean);
const only = process.argv[3];
const N = Number(process.argv[4] || 3);
if (!sections.length) { console.error('usage: probe-ps-guardian-contacts.js <sgySectionId,…> [catalogue|values|emg|corr] [n]'); process.exit(1); }
const want = (s) => !only || only === s;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Q = '/teachers/mba_alerts/queries/';
const CORR_IDS = ['32012479', '32012481', '32012482'];
const CONTACT_FIELDS = ['x_homeemail', 'x_dnc_g1', 'x_dnc_g2', 'x_g1deceased', 'x_g2deceased', 'x_g1g2relationship'];

const db = process.env.PROBE_DB ? new Database(process.env.PROBE_DB, { readonly: true, fileMustExist: true }) : null;
const parentsOf = (dcid) => (db ? db.prepare(`
  SELECT p.first_name, p.last_name, p.email FROM parents p JOIN students s ON s.id = p.student_id
  WHERE s.school_uid = ?`).all(`1_${dcid}`) : []);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9@.]/g, '');
const words = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1));

const cellText = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function tables(html) {
  const out = [];
  for (const [, t] of html.replace(/<script[\s\S]*?<\/script>/gi, '').matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [];
    for (const [, row] of t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row.matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => ({ th: m[1].toLowerCase() === 'h', html: m[2], text: cellText(m[2]) }));
      if (cells.length) rows.push(cells);
    }
    out.push(rows);
  }
  return out;
}
const mask = (t) => (t === '' ? '·' : /@/.test(t) ? `email(${(t.match(EMAIL) || []).length})` : /\d{4}/.test(t) ? `digits(${t.length})` : `text(${t.length})`);

const sgyJar = cookieJar();
if (!sgyJar) { console.error('no saved Schoology session'); process.exit(1); }
const ps = new PowerSchoolWeb({ sgyJar });
async function raw(path, referer) {
  await sleep(300);
  const res = await fetch(`${PS_BASE}${path}`, { redirect: 'manual', headers: { cookie: ps.jar.header(), Accept: 'text/html', ...(referer ? { Referer: `${PS_BASE}${referer}` } : {}) } });
  ps.jar.take(res);
  const text = await res.text();
  const title = ((text.match(/<title>([^<]*)/i) || [])[1] || '').trim();
  console.log(`    ${path.split('?')[0]} → ${res.status}, ${text.length} bytes, title "${title}"`);
  if (/Security Violation/i.test(text)) { console.log('    SECURITY VIOLATION page: stopping'); process.exit(2); }
  return { status: res.status, text };
}

console.log('launch (plain HTTP)');
await ps.launch(sections[0]);
const cat = await ps.read(`${Q}getAlertTypes.json`, { disabled: 0, student_schoolid: 40 });
const corrDefs = (Array.isArray(cat) ? cat : []).filter((t) => CORR_IDS.includes(String(t.id)));
if (want('catalogue')) {
  for (const t of (Array.isArray(cat) ? cat : []).filter((x) => /x_homeemail|x_dnc|deceased|relationship/i.test(String(x.student_field)))) {
    const { id, name, trigger_type, stub_url, student_field, ext_table_name, student_field_operator, student_field_operand } = t;
    console.log('  ' + JSON.stringify({ id, name, trigger_type, stub_url, student_field, ext_table_name, student_field_operator, student_field_operand }));
  }
}

const totals = { students: 0, homeemail: new Map(), contact: new Map(), emg: { rows: 0, joined: 0 }, slots: new Map(), corr: [] };
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
for (const sid of sections) {
  const { sectionDcid } = await ps.launchIds(sid);
  if (!sectionDcid) { console.log(`section ${sections.indexOf(sid) + 1}: no sectionDcid`); continue; }
  console.log(`section ${sections.indexOf(sid) + 1}`);
  const roster = (await ps.read(`${Q}getStudentsInSection.json`, { sectionIds: sectionDcid })).filter((r) => r && r.studentid);
  const ids = roster.map((r) => String(r.studentid)).join(',');
  const params = new URLSearchParams({ stuList: ids, student_id: ids });
  CONTACT_FIELDS.forEach((f, i) => { params.append(`field${i + 1}`, f); params.append(`fieldTbl${i + 1}`, 'U_DEF_EXT_STUDENTS'); });
  params.append('table1', 'U_DEF_EXT_STUDENTS');
  const values = (await ps.read(`${Q}stuFieldValues.json`, params, { method: 'GET' })).filter((r) => r && r.id != null);
  const valueById = new Map(values.map((v) => [String(v.id), v]));
  totals.students += roster.length;
  if (want('values')) {
    for (const v of values) {
      const he = v.x_homeemail;
      bump(totals.homeemail, he == null ? 'null' : String(he).length <= 2 ? `code "${he}"` : `string(${String(he).length})`);
      for (const f of CONTACT_FIELDS.slice(1, 5)) if (v[f] != null) bump(totals.contact, `${f} = "${String(v[f]).length <= 2 ? v[f] : `len ${String(v[f]).length}`}"`);
    }
    console.log(`  roster ${roster.length}, values ${values.length}; record keys: ${Object.keys(values[0] || {}).join(', ')}`);
  }

  if (want('emg')) {
    console.log('  emg: home → Emergency Contact List');
    await raw('/teachers/home.html');
    const r = await raw(`/teachers/StudEmgContacts.html?sectionid=${sectionDcid}`, '/teachers/home.html');
    const ts = tables(r.text).filter((t) => t.length > 1);
    const t = ts.sort((a, b) => b.length - a.length)[0] || [];
    const header = (t.find((row) => row.some((c) => c.th)) || t[0] || []).map((c) => c.text);
    console.log(`    ${ts.length} tables; biggest ${t.length} rows; header: ${header.join(' | ')}`);
    const body = t.filter((row) => !row.some((c) => c.th) && row.length === header.length);
    const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    console.log(`    body rows ${body.length}; first row masked: ${(body[0] || []).map((c) => mask(c.text)).join(' | ')}`);
    // Per column: how often set, and email counts per cell.
    header.forEach((h, i) => {
      const set = body.filter((row) => row[i].text !== '').length;
      const em = [...new Set(body.map((row) => (row[i].text.match(EMAIL) || []).length))].join(',');
      const brs = [...new Set(body.map((row) => (row[i].html.match(/<br/gi) || []).length))].join(',');
      console.log(`    column "${h}": set ${set}/${body.length}; emails per cell {${em}}; <br> per cell {${brs}}`);
    });
    // Join each row to the roster by the student's name (lastfirst), then match G1/G2 to Prism parents.
    const iStu = col('Student');
    const byName = new Map(roster.map((s) => [norm(s.lastfirst), s]));
    totals.emg.rows += body.length;
    for (const row of body) {
      const s = byName.get(norm(row[iStu]?.text));
      if (!s) continue;
      totals.emg.joined++;
      const parents = parentsOf(s.studentdcid);
      const emails = (i) => (i >= 0 ? (row[i].text.match(EMAIL) || []).map((e) => e.toLowerCase()) : []);
      const slot = { G1: { name: row[col('Guardian 1')]?.text || '', emails: emails(col('G1 Email')) }, G2: { name: row[col('Guardian 2')]?.text || '', emails: emails(col('G2 Email')) } };
      if (!totals.nameFormat) totals.nameFormat = slot.G1.name.replace(/[A-Za-z]+/g, 'w');
      bump(totals.slots, `list: G1 name ${slot.G1.name ? 'set' : 'empty'} email ${slot.G1.emails.length}; G2 name ${slot.G2.name ? 'set' : 'empty'} email ${slot.G2.emails.length}; same email both slots ${slot.G1.emails.some((e) => slot.G2.emails.includes(e))}; same surname both slots ${[...words(slot.G1.name)].some((w) => words(slot.G2.name).has(w))}`);
      const surnameSlots = (p) => ['G1', 'G2'].filter((k) => words(slot[k].name).has(String(p.last_name).toLowerCase().split(/\s+/).pop()));
      const fullSlots = (p) => surnameSlots(p).filter((k) => String(p.first_name).toLowerCase().split(/[^a-z]+/).filter(Boolean).some((w) => words(slot[k].name).has(w)));
      const taken = new Set();
      for (const p of parents) {
        const e = String(p.email || '').toLowerCase();
        const byEmail = e ? ['G1', 'G2'].filter((k) => slot[k].emails.includes(e)) : [];
        const bySurname = surnameSlots(p); const byFull = fullSlots(p);
        const agree = byEmail.length === 1 && byFull.length === 1 ? (byEmail[0] === byFull[0] ? 'agree' : 'DISAGREE') : '';
        byEmail.forEach((k) => taken.add(k));
        bump(totals.slots, `parent ${e ? 'with' : 'without'} email: by email [${byEmail.join('+') || '-'}], by first+surname [${byFull.join('+') || '-'}], by surname [${bySurname.join('+') || '-'}] ${agree}`);
      }
      bump(totals.slots, `student: ${parents.length} Prism parents; slots taken by email ${taken.size}`);
    }
  }

  if (only === 'notes') {
    // The pop-ups whose text may name a contact guardian: Divorced (sf, X_G1G2Relationship)
    // and Student Support Summary (adv). Prints structure and which contact words appear.
    const byId = (id) => (Array.isArray(cat) ? cat : []).find((t) => String(t.id) === id);
    const div = byId('10593857'); const ss = byId('11290981');
    const divIds = values.filter((v) => /divorced|separated/i.test(String(v.x_g1g2relationship || ''))).map((v) => String(v.id));
    const adv = await ps.read(`${Q}getAdvTriggerMatches.html`, { trigger_url: ss.trigger_url, studentIds: ids, frn: '', querystring: ss.querystring || '' });
    const ssIds = Object.keys(adv || {}).filter((k) => k !== '-1');
    const WORDS = { G1: /\bG\s?1\b|guardian\s*1/i, G2: /\bG\s?2\b|guardian\s*2/i, 'G1+G2': /G\s?1\s*(\+|&|and)\s*G\s?2|both/i, contact: /contact/i, correspondence: /correspond/i, custody: /custod/i, 'do not': /do not|don't|not to be/i, mother: /mother|\bmum\b|\bmom\b/i, father: /father|\bdad\b/i, email: /e-?mail/i };
    const report = (label, html) => {
      const t = tables(html); const text = cellText(html.replace(/<script[\s\S]*?<\/script>/gi, ''));
      const hits = Object.entries(WORDS).filter(([, re]) => re.test(text)).map(([k]) => k);
      const labels = t.flat().map((r) => r[0]?.text).filter((x) => x && x.length < 40);
      console.log(`  ${label}: ${html.length} bytes, ${t.length} tables, first-cell labels [${labels.join(' | ')}], text ${text.length} chars, contact words [${hits.join(', ') || 'none'}]`);
    };
    for (const sidStr of divIds) {
      const s = roster.find((r) => String(r.studentid) === sidStr);
      const q = new URLSearchParams({ url: div.stub_url, frn: `001${s.studentdcid}`, id: String(div.id), mba_frn: `001${s.studentdcid}`, student_field: `${div.ext_table_name}.X_G1G2Relationship`, tableName: div.ext_table_name });
      report('divorced pop-up', await ps.page(`/teachers/alerts/aet_customalert_custompopup.html?${q}`)); await sleep(300);
    }
    for (const sidStr of ssIds) {
      const s = roster.find((r) => String(r.studentid) === sidStr);
      const q = new URLSearchParams({ url: ss.stub_url, frn: `001${s.studentdcid}`, id: String(ss.id), studentid: sidStr });
      const html = await ps.page(`/teachers/alerts/aet_customalert_custompopup.html?${q}`); await sleep(300);
      // Per row: which contact words the description holds.
      const rows = tables(html).flat().filter((r) => r.length >= 2 && !r[0].th);
      const perRow = rows.map((r) => [r[0].text, Object.entries(WORDS).filter(([, re]) => re.test(r[1].text)).map(([k]) => k)]).filter(([, h]) => h.length);
      console.log(`  support summary: ${rows.length} rows; rows with contact words: ${perRow.map(([l, h]) => `${l} [${h.join(', ')}]`).join('; ') || 'none'}`);
    }
    console.log(`  section: divorced ${divIds.length}, support summary ${ssIds.length}`);
  }

  if (want('corr')) {
    // Students with a one-guardian correspondence code first, then the rest, up to n.
    const pick = [...roster].sort((a, b) => {
      const rank = (s) => (['1', '2'].includes(String(valueById.get(String(s.studentid))?.x_homeemail)) ? 0 : 1);
      return rank(a) - rank(b);
    }).slice(0, N);
    for (const s of pick) {
      const v = valueById.get(String(s.studentid)) || {};
      const code = String(v.x_homeemail ?? '');
      const def = corrDefs.find((d) => String(d.student_field_operand) === code) || corrDefs[0];
      if (!def?.stub_url) { console.log('  corr: no stub_url for the correspondence alert'); break; }
      const q = new URLSearchParams({ url: def.stub_url, frn: `001${s.studentdcid}`, id: String(def.id), mba_frn: `001${s.studentdcid}`, student_field: `${def.ext_table_name}.X_HomeEmail`, tableName: def.ext_table_name });
      let html;
      try { html = await ps.page(`/teachers/alerts/aet_customalert_custompopup.html?${q}`); } catch (err) { console.log(`  corr: ${err.code} ${err.message}`); if (err.code === 'PS_SECURITY') process.exit(2); continue; }
      await sleep(300);
      const ts = tables(html);
      const rows = ts.flat();
      const header = (rows.find((r) => r.some((c) => c.th)) || []).map((c) => c.text);
      const body = rows.filter((r) => !r.some((c) => c.th));
      const outside = cellText(html.replace(/<table[\s\S]*?<\/table>/gi, ' '));
      const parents = parentsOf(s.studentdcid);
      const popEmails = (html.match(EMAIL) || []).map((e) => e.toLowerCase());
      const matched = parents.filter((p) => p.email && popEmails.includes(p.email.toLowerCase())).length;
      const nameMatched = parents.filter((p) => body.some((r) => r.some((c) => words(c.text).has(String(p.last_name).toLowerCase())))).length;
      console.log(`  corr code "${code}" (alert ${def.id}): ${html.length} bytes, ${ts.length} tables, header [${header.join(' | ')}], ${body.length} body rows [${body.map((r) => r.map((c) => mask(c.text)).join(' | ')).join(' ; ')}], text outside tables ${outside.length} chars; Prism parents ${parents.length} (with email ${parents.filter((p) => p.email).length}); pop-up emails ${popEmails.length}; parents matched by email ${matched}, by surname ${nameMatched}`);
      totals.corr.push({ code, rows: body.length, matched, parents: parents.length });
    }
  }
}

console.log('\nTotals');
console.log(`  students on rosters: ${totals.students}`);
if (totals.homeemail.size) console.log(`  X_HomeEmail: ${[...totals.homeemail].map(([k, n]) => `${k} ×${n}`).join(', ')}`);
console.log(`  contact fields set: ${[...totals.contact].map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'}`);
if (want('emg')) {
  console.log(`  emergency list rows ${totals.emg.rows}, joined to roster ${totals.emg.joined}; guardian name shape (letters as w): "${totals.nameFormat}"`);
  for (const [k, n] of [...totals.slots].sort()) console.log(`    ${k}: ${n}`);
}
