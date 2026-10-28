#!/usr/bin/env node
// Read-only probe for #190 (counsellors) and #203 (People profile pages): what
// Schoology shows about a person, and where a student's counsellors appear.
// Approved by Graham 28 Oct 2026 for a bounded set: at most 3 students from one
// current class, plus Graham's own account and up to 2 staff found through them.
// GETs only. Prints shapes, role ids, staff job titles and group categories; no
// student names, ids or text (uids are printed as S1..S3 and P1..Pn).
// Usage (repo root):
//   PRISM_SESSION_DIR=~/repos/prism/.playwright-session \
//     node --env-file=.env scripts/probe-people-profile.js [sectionId]
import { apiGet, getMyUserId, getMySections, getSectionEnrollments } from '../server/services/schoology.js';
import { cookieJar, getResource, drupalSettings } from '../server/services/schoologyWeb.js';

const MAX_STUDENTS = 3;
const MAX_ASSOCIATED_PER_STUDENT = 10;
const MAX_STAFF_PAGES = 2;
const ROLES = { 263109: 'Parent', 263181: 'Staff', 263107: 'Student', 263103: 'System Admin', 263105: 'Teacher', 293908: 'Counselor', 279440: 'School Admin', 896373: 'Student TA' };
const KEYWORDS = /advis|counsel|associat|community|principal|dean|case manager|relationship/gi;

const jar = cookieJar();
if (!jar) { console.error('No saved session (set PRISM_SESSION_DIR)'); process.exit(1); }

const shape = (v, depth = 0) => {
  if (Array.isArray(v)) return `array(${v.length})${v.length && depth < 2 ? ` of ${shape(v[0], depth + 1)}` : ''}`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return depth >= 2 ? `{${keys.length} keys}` : `{${keys.slice(0, 20).map((k) => (/^\d+$/.test(k) ? '<id>' : k)).join(', ')}${keys.length > 20 ? ', …' : ''}}`;
  }
  return v === null || v === '' ? `${typeof v}(empty)` : typeof v;
};
const tryGet = async (path) => {
  try { return { status: 200, body: await apiGet(path) }; } catch (e) { return { status: e.status || 'ERR', error: e.message }; }
};
const role = (id) => `${ROLES[id] || 'unknown'} (${id})`;

// A web page's text near each keyword hit, digits and capitalised words masked
// (names are capitalised; labels such as "Advisor" are kept when they match KEYWORDS).
const keywordContext = (html) => {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const out = [];
  for (const m of text.matchAll(KEYWORDS)) {
    if (out.length >= 8) break;
    const s = text.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50)
      .replace(/\d{3,}/g, '<n>')
      .replace(/\b[A-Z][a-z]+\b/g, (w) => (w.match(KEYWORDS) ? w : 'Xx'));
    out.push(`…${s}…`);
  }
  return out;
};

async function webPage(path, selfUid) {
  const r = await getResource(jar, path, { accept: 'text/html' });
  const links = [...new Set([...r.text.matchAll(/href="\/user\/(\d+)/g)].map((m) => m[1]))].filter((u) => u !== String(selfUid));
  const tabs = [...new Set([...r.text.matchAll(/href="\/user\/\d+\/([a-z_-]+)/g)].map((m) => m[1]))];
  const xhr = [...new Set([...r.text.matchAll(/["'](\/iapi2?\/[a-z0-9_/-]+)/gi)].map((m) => m[1].replace(/\d{5,}/g, '<id>')))];
  const settings = drupalSettings(r.text);
  return { status: r.status, bytes: r.text.length, links, tabs, xhr, settingsKeys: settings ? Object.keys(settings) : [], keywords: keywordContext(r.text), text: r.text };
}

const me = await getMyUserId();
const sections = (await getMySections(me)).filter((s) => String(s.admin) === '1' && String(s.active ?? '1') === '1');
const section = process.argv[2] ? sections.find((s) => String(s.id) === process.argv[2]) : sections[0];
if (!section) { console.error('No current section found'); process.exit(1); }
console.log(`Section: ${section.course_title} ${section.section_title}`);
const students = (await getSectionEnrollments(section.id))
  .filter((e) => String(e.admin) === '0' && String(e.status) === '1')
  .slice(0, MAX_STUDENTS);

const people = new Map(); // associated uid -> label
const staffSeen = [];
const label = (uid) => { if (!people.has(uid)) people.set(uid, `P${people.size + 1}`); return people.get(uid); };

for (const [i, enr] of students.entries()) {
  const uid = String(enr.uid);
  const S = `S${i + 1}`;
  console.log(`\n=== ${S} ===`);
  const prof = await tryGet(`/users/${uid}`);
  if (prof.body) {
    const b = prof.body;
    console.log(`REST /users/{uid}: ${prof.status}, role ${role(b.role_id)}, keys ${shape(b)}`);
    console.log(`  parents: ${(b.parents?.parent || []).length}, child_uids: ${shape(b.child_uids)}, position: ${shape(b.position)}, permissions: ${shape(b.permissions)}`);
    for (const k of Object.keys(b)) if (/advis|counsel|community|house|homeroom|group/i.test(k)) console.log(`  field ${k}: ${shape(b[k])}`);
  } else console.log(`REST /users/{uid}: ${prof.status} ${prof.error}`);

  for (const sub of ['groups', 'advisors', 'advisees', 'associations', 'relationships', 'network', 'parents']) {
    const r = await tryGet(`/users/${uid}/${sub}`);
    console.log(`REST /users/{uid}/${sub}: ${r.status} ${r.body ? shape(r.body) : ''}`);
    if (sub === 'groups' && r.body) {
      const groups = r.body.group || [];
      const cats = groups.reduce((m, g) => ({ ...m, [g.category || '(none)']: (m[g.category || '(none)'] || 0) + 1 }), {});
      console.log(`  ${groups.length} groups by category: ${JSON.stringify(cats)}`);
      for (const g of groups) if (new RegExp(KEYWORDS.source, "i").test(`${g.title} ${g.description}`)) console.log(`  keyword group: "${g.title}" category ${g.category}`);
    }
  }

  for (const path of [`/user/${uid}`, `/user/${uid}/info`]) {
    const p = await webPage(path, uid);
    console.log(`WEB ${path.replace(uid, '{uid}')}: ${p.status}, ${p.bytes} bytes, ${p.links.length} other /user links, tabs ${JSON.stringify(p.tabs)}`);
    if (p.xhr.length) console.log(`  XHR literals: ${p.xhr.join(' ')}`);
    if (p.keywords.length) console.log(`  keyword context:\n    ${p.keywords.join('\n    ')}`);
    for (const other of p.links.slice(0, MAX_ASSOCIATED_PER_STUDENT)) {
      const L = label(other);
      const r = await tryGet(`/users/${other}`);
      const b = r.body || {};
      const near = p.text.slice(Math.max(0, p.text.indexOf(`/user/${other}`) - 300), p.text.indexOf(`/user/${other}`)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(-80).replace(/\b[A-Z][a-z]+\b/g, (w) => (w.match(KEYWORDS) ? w : 'Xx')).replace(/\d{3,}/g, '<n>');
      console.log(`  ${L}: ${r.status} role ${role(b.role_id)}${b.position ? `, position "${b.position}"` : ''}; text before link: "${near}"`);
      if (b.role_id && String(b.role_id) !== '263107' && String(b.role_id) !== '263109' && !staffSeen.includes(other)) staffSeen.push(other);
    }
  }
}

console.log('\n=== Staff ===');
const mine = await tryGet(`/users/${me}`);
console.log(`Graham REST /users/{uid}: role ${role(mine.body?.role_id)}, keys ${shape(mine.body)}`);
for (const sub of ['groups', 'advisees']) {
  const r = await tryGet(`/users/${me}/${sub}`);
  console.log(`Graham REST /users/{uid}/${sub}: ${r.status} ${r.body ? shape(r.body) : ''}${sub === 'groups' && r.body ? `, ${(r.body.group || []).length} groups, admin flags ${JSON.stringify((r.body.group || []).map((g) => g.admin ?? '-'))}` : ''}`);
}
for (const uid of staffSeen.slice(0, MAX_STAFF_PAGES)) {
  const p = await webPage(`/user/${uid}/info`, uid);
  console.log(`WEB staff ${label(uid)} /user/{uid}/info: ${p.status}, ${p.bytes} bytes, tabs ${JSON.stringify(p.tabs)}`);
  const fields = [...p.text.matchAll(/<(?:th|dt|label)[^>]*>([^<]{2,40})<\/(?:th|dt|label)>/g)].map((m) => m[1].trim());
  console.log(`  info labels: ${JSON.stringify([...new Set(fields)])}`);
  if (p.keywords.length) console.log(`  keyword context:\n    ${p.keywords.join('\n    ')}`);
}
