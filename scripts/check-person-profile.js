#!/usr/bin/env node
// Live check for #203 (read only; Graham approved 28 Oct 2026: one student of one current class, up to 2 of their
// parents and 3 of their advisors): readPerson (server/services/personProfile.js) on each. Prints each person's kind
// and which fields are filled, with counts; never a name, email or value. Writes nothing.
// Usage (repo root): PRISM_SESSION_DIR=… node --env-file=.env scripts/check-person-profile.js [sectionId]
import { getMyUserId, getMySections, getSectionEnrollments, getUserProfile, getUserProfilesBatch, getUserGroups } from '../server/services/schoology.js';
import { cookieJar, getResource } from '../server/services/schoologyWeb.js';
import { readPerson, infoRows } from '../server/services/personProfile.js';
import { advisorUids } from '../server/lib/psCounselors.js';

const MAX_PARENTS = 2;
const MAX_ADVISORS = 3;
const jar = cookieJar();
if (!jar) { console.error('No saved session (set PRISM_SESSION_DIR)'); process.exit(1); }
const readInfoPage = async (uid) => (await getResource(jar, `/user/${uid}/info`, { accept: 'text/html' })).text;
const readers = { getProfile: getUserProfile, getProfiles: getUserProfilesBatch, getSections: getMySections, getGroups: getUserGroups, readInfoPage };

const me = await getMyUserId();
const sections = (await getMySections(me)).filter((s) => String(s.admin) === '1');
const section = process.argv[2] ? sections.find((s) => String(s.id) === process.argv[2]) : sections[0];
const first = (await getSectionEnrollments(section.id)).find((e) => String(e.admin) === '0' && String(e.status) === '1');
const page = await readInfoPage(first.uid);
const parentRow = [...page.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]).find((r) => /<th[^>]*>\s*Parents\s*</i.test(r)) || '';
const parents = [...new Set([...parentRow.matchAll(/href="\/user\/(\d+)/g)].map((m) => m[1]))];
const targets = [
  ['student', String(first.uid)],
  ...parents.slice(0, MAX_PARENTS).map((u, i) => [`parent ${i + 1}`, u]),
  ...advisorUids(page).slice(0, MAX_ADVISORS).map((u, i) => [`advisor ${i + 1}`, u]),
];
for (const [label, uid] of targets) {
  try {
    const p = await readPerson(uid, readers);
    const d = p.details;
    const email = p.email ? (/^\d+@hkis\.edu\.hk$/i.test(p.email) ? 'school, numbered' : /@hkis\.edu\.hk$/i.test(p.email) ? 'school, named' : 'other') : 'none';
    console.log(`${label}: kind ${p.kind ?? 'null'}; email ${email}; photo ${Boolean(p.picture_url)}; position ${Boolean(d.position)}, ` +
      `subjects ${Boolean(d.subjects)}, phone ${Boolean(d.phone)}; parents ${d.parents?.length ?? 0}; children ${d.children?.length ?? 0} ` +
      `(named ${d.children?.filter((c) => c.name).length ?? 0}); courses ${d.courses?.length ?? '-'}; groups ${d.groups?.length ?? 0}; ` +
      `info rows ${JSON.stringify([...infoRows(await readInfoPage(uid)).keys()])}`);
    if (label.startsWith('parent')) {
      const rest = await getUserProfile(uid);
      console.log(`  ${label} REST child_uids shape: ${Array.isArray(rest.child_uids) ? 'array' : typeof rest.child_uids}${typeof rest.child_uids === 'object' && rest.child_uids ? ` keys ${JSON.stringify(Object.keys(rest.child_uids))}` : ''}; REST keys ${Object.keys(rest).join(', ')}`);
    }
  } catch (err) {
    console.log(`${label}: not read (${err.status || ''} ${err.message.replace(/\d{5,}/g, '<id>')})`);
  }
}
