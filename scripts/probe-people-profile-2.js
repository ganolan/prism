#!/usr/bin/env node
// Read-only probe for #190 / #203, second pass (28 Oct 2026, same approval as
// probe-people-profile.js: the same 3 students of one current class). For each
// student: the Info page's row labels, the staff in the Advisors row (their REST
// fields, job title, groups and Info rows) and the student's community groups.
// Reads no group's member list (that would read other students). GETs only.
// Prints labels, job titles and group titles; students and staff appear as S1..S3
// and A1..An, with no names, ids or emails.
// Usage (repo root):
//   PRISM_SESSION_DIR=~/repos/prism/.playwright-session \
//     node --env-file=.env scripts/probe-people-profile-2.js [sectionId]
import { apiGet, getMyUserId, getMySections, getSectionEnrollments } from '../server/services/schoology.js';
import { cookieJar, getResource } from '../server/services/schoologyWeb.js';

const MAX_STUDENTS = 3;
const ROLES = { 263109: 'Parent', 263181: 'Staff', 263107: 'Student', 263103: 'System Admin', 263105: 'Teacher', 293908: 'Counselor', 279440: 'School Admin', 896373: 'Student TA' };
const jar = cookieJar();
if (!jar) { console.error('No saved session (set PRISM_SESSION_DIR)'); process.exit(1); }

const tryGet = async (path) => { try { return { status: 200, body: await apiGet(path) }; } catch (e) { return { status: e.status || 'ERR' }; } };
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const maskNames = (s) => s.replace(/\S+@\S+/g, '<email>').replace(/\d{3,}/g, '<n>').replace(/\b[A-Z][a-z'-]+\b/g, 'Xx');

// The Info page's table rows → [{ label, value html }].
const infoRows = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => {
  const cells = [...m[1].matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/g)].map((c) => c[2]);
  return { label: strip(cells[0] || ''), value: cells.slice(1).join(' ') };
}).filter((r) => r.label && r.label.length < 60);

const me = await getMyUserId();
const sections = (await getMySections(me)).filter((s) => String(s.admin) === '1' && String(s.active ?? '1') === '1');
const section = process.argv[2] ? sections.find((s) => String(s.id) === process.argv[2]) : sections[0];
const students = (await getSectionEnrollments(section.id)).filter((e) => String(e.admin) === '0' && String(e.status) === '1').slice(0, MAX_STUDENTS);

const staff = new Map(); // uid -> { label, students: [S#] }
const communityGroups = new Map(); // gid -> { title, students }

for (const [i, enr] of students.entries()) {
  const S = `S${i + 1}`;
  const uid = String(enr.uid);
  const prof = (await tryGet(`/users/${uid}`)).body || {};
  if (i === 0) console.log(`Student REST keys (all): ${Object.keys(prof).join(', ')}`);
  console.log(`\n${S}: role_id ${prof.role_id ?? '(absent)'}`);
  const page = await getResource(jar, `/user/${uid}/info`, { accept: 'text/html' });
  for (const row of infoRows(page.text)) {
    const links = [...new Set([...row.value.matchAll(/href="\/user\/(\d+)/g)].map((m) => m[1]))];
    console.log(`  row "${row.label}": ${links.length} /user links; text ${maskNames(strip(row.value)).slice(0, 90)}`);
    if (/advis/i.test(row.label)) for (const a of links) {
      if (!staff.has(a)) staff.set(a, { label: `A${staff.size + 1}`, students: [] });
      staff.get(a).students.push(S);
    }
  }
  const groups = ((await tryGet(`/users/${uid}/groups`)).body?.group) || [];
  for (const g of groups) {
    console.log(`  group category ${g.category || '(none)'}: "${g.title}"`);
    if (g.category === 'community') {
      if (!communityGroups.has(String(g.id))) communityGroups.set(String(g.id), { title: g.title, students: [] });
      communityGroups.get(String(g.id)).students.push(S);
    }
  }
}

console.log('\n=== Advisors row staff ===');
for (const [uid, s] of staff) {
  const b = (await tryGet(`/users/${uid}`)).body || {};
  const groups = ((await tryGet(`/users/${uid}/groups`)).body?.group) || [];
  const community = groups.filter((g) => communityGroups.has(String(g.id))).map((g) => `"${communityGroups.get(String(g.id)).title}"${g.admin != null ? ` admin ${g.admin}` : ''}`);
  console.log(`${s.label} (advisor of ${s.students.join(',')}): role ${ROLES[b.role_id] || 'absent'} (${b.role_id ?? '-'}), position "${b.position ?? ''}", name_title "${b.name_title ?? ''}", ${groups.length} groups, of the students' community groups: ${community.join('; ') || 'none'}`);
  console.log(`  REST keys: ${Object.keys(b).join(', ')}`);
  const page = await getResource(jar, `/user/${uid}/info`, { accept: 'text/html' });
  for (const row of infoRows(page.text)) console.log(`  info row "${row.label}": ${/position|title|department|role|job|office|grade|building|school/i.test(row.label) ? strip(row.value).slice(0, 80) : '(value withheld)'}`);
}

console.log('\n=== Students\' community groups ===');
for (const [gid, g] of communityGroups) {
  const r = await tryGet(`/groups/${gid}`);
  console.log(`"${g.title}" (students ${g.students.join(',')}): REST /groups/{id} ${r.status} keys ${r.body ? Object.keys(r.body).join(', ') : ''}; description ${r.body?.description ? `"${strip(r.body.description).slice(0, 120)}"` : '(none)'}`);
}
