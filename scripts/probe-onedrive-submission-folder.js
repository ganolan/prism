// One-off spike (#120): can Prism resolve a student's OneDrive lti_submission file
// link by listing the teacher's OneDrive through SharePoint REST, instead of the
// Schoology Microsoft LTI app launch chain (#107)?
//
// Observed 2026-09-28 (teacher-supplied URLs): the Schoology Microsoft OneDrive app
// stores every student copy in the TEACHER's OneDrive at
//   Documents/Schoology Microsoft OneDrive Assignments/{course} {section} - {sectionId}/
//     {assignment title} - {assignmentId}/{Student Name} - {assignment title} - {n}.pptx
// where {n} is a per-student number that matches no id Prism stores.
//
// This probe (READ-ONLY GETs): SSO into SharePoint with the saved Playwright
// session, list the root folder, find the section + assignment folders by their
// " - {id}" suffix, list the files, and dump the per-file fields that could key a
// file to a student (name, sharing details) — so we can tell whether matching can
// be id/email-based rather than name-based.
//
// PII hygiene: student names/emails are masked to S01,S02… ; only field SHAPES,
// counts and match rates are printed.
//
// Usage: node scripts/probe-onedrive-submission-folder.js <sectionId> <assignmentId> [prismCourseId]
import 'dotenv/config';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';

const sectionId = process.argv[2] || '8458134359';
const assignmentId = process.argv[3] || '8555933030';
const prismCourseId = process.argv[4] || '579';
const SITE = 'https://hkis-my.sharepoint.com/personal/gnolan_hkis_edu_hk';
const SITE_PATH = '/personal/gnolan_hkis_edu_hk';
const ROOT = `${SITE_PATH}/Documents/Schoology Microsoft OneDrive Assignments`;
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');

if (!existsSync(STATE_FILE)) { console.error('No saved session — run npm run mastery:login'); process.exit(1); }

const mask = (() => { const m = new Map(); return (k) => { if (!m.has(k)) m.set(k, 'S' + String(m.size + 1).padStart(2, '0')); return m.get(k); }; })();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();

async function spGet(path) {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { Accept: 'application/json;odata=nometadata' }, credentials: 'include' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, head: text.slice(0, 300) };
  }, `${SITE}/_api/web/${path}`);
}
const byPath = (p) => `GetFolderByServerRelativePath(decodedurl='${encodeURIComponent(p.replace(/'/g, "''"))}')`;

try {
  // SSO: a UI page on the site triggers the MS login redirect chain; wait to land back.
  await page.goto(`${SITE}/_layouts/15/onedrive.aspx`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForURL((u) => u.hostname === 'hkis-my.sharepoint.com', { timeout: 60000 }).catch(() => {});
  console.log('landed on:', new URL(page.url()).hostname);
  if (!page.url().startsWith('https://hkis-my.sharepoint.com')) throw new Error('SSO did not complete — SharePoint not reached with the saved session');

  const root = await spGet(`${byPath(ROOT)}/Folders?$select=Name,ServerRelativeUrl,ItemCount`);
  console.log(`\n[root] status=${root.status} folders=${root.json?.value?.length ?? '?'}`);
  if (!root.json?.value) { console.log(root.head); throw new Error('root listing failed'); }
  for (const f of root.json.value) console.log(`   ${f.Name}  (items=${f.ItemCount})`);

  const sectionFolder = root.json.value.find((f) => f.Name.endsWith(` - ${sectionId}`));
  if (!sectionFolder) throw new Error(`no folder ending " - ${sectionId}"`);
  const secPath = decodeURIComponent(sectionFolder.ServerRelativeUrl);
  const sec = await spGet(`${byPath(secPath)}/Folders?$select=Name,ServerRelativeUrl,ItemCount`);
  console.log(`\n[section] status=${sec.status} assignment folders=${sec.json?.value?.length ?? '?'}`);
  const aFolder = sec.json?.value?.find((f) => f.Name.endsWith(` - ${assignmentId}`));
  if (!aFolder) throw new Error(`no assignment folder ending " - ${assignmentId}"`);
  console.log(`   assignment folder: ${aFolder.Name} (items=${aFolder.ItemCount})`);

  const aPath = decodeURIComponent(aFolder.ServerRelativeUrl);
  const files = await spGet(`${byPath(aPath)}/Files?$expand=ListItemAllFields`);
  console.log(`\n[files] status=${files.status} count=${files.json?.value?.length ?? '?'}`);
  if (!files.json?.value) { console.log(files.head); throw new Error('file listing failed'); }

  const first = files.json.value[0];
  if (first) {
    console.log('   file keys:', Object.keys(first).filter((k) => k !== 'ListItemAllFields').join(','));
    console.log('   ListItemAllFields keys:', Object.keys(first.ListItemAllFields || {}).join(','));
  }

  // Prism roster for the course (read-only), to measure name-match coverage.
  const db = new Database(process.env.DB_PATH || join(process.cwd(), 'server/db/students.db'), { readonly: true, fileMustExist: true });
  const roster = db.prepare(`SELECT s.first_name, s.last_name, s.preferred_name, s.email FROM students s
    JOIN enrolments e ON e.student_id = s.id WHERE e.course_id = ? AND e.status IS NOT '5'`).all(prismCourseId);
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

  let nameHits = 0, emailHits = 0;
  for (const f of files.json.value) {
    const m = f.Name.match(/^(.*?) - (.*) - (\d+)\.(\w+)$/);
    const who = m ? m[1] : f.Name;
    const nameMatch = roster.find((r) => [`${r.first_name} ${r.last_name}`, `${r.preferred_name || ''} ${r.last_name}`].map(norm).includes(norm(who)));
    const shared = JSON.stringify(f.ListItemAllFields?.SharedWithDetails ?? f.ListItemAllFields?.SharedWithUsersId ?? null);
    const emailMatch = roster.find((r) => r.email && shared.toLowerCase().includes(r.email.toLowerCase().split('@')[0]));
    if (nameMatch) nameHits++;
    if (emailMatch) emailHits++;
    console.log(`   ${mask(who)}  n=${m?.[3] ?? '?'} ext=${m?.[4] ?? '?'}  uniqueId=${f.UniqueId}  linkingUrl=${f.LinkingUrl ? 'yes' : 'no'}  nameMatch=${!!nameMatch}  sharedWith=${shared === 'null' ? 'none' : 'present'} emailMatch=${!!emailMatch}  modified=${f.TimeLastModified}`);
  }
  console.log(`\n[coverage] files=${files.json.value.length} roster=${roster.length} nameMatches=${nameHits} emailMatches=${emailHits}`);
  const sw = files.json.value.find((f) => f.ListItemAllFields?.SharedWithDetails)?.ListItemAllFields?.SharedWithDetails;
  if (sw) console.log('   SharedWithDetails shape (masked):', String(sw).replace(/[\w.+-]+@[\w.-]+/g, '<email>').replace(/"DisplayName":"[^"]*"/g, '"DisplayName":"<name>"').slice(0, 400));
  if (first) console.log('   url shapes: ServerRelativeUrl=', first.ServerRelativeUrl.replace(/[^/]+$/, '<file>'), ' LinkingUrl=', (first.LinkingUrl || '').replace(/\/[^/]+\?/, '/<file>?').replace(/d=w[0-9a-f]+/, 'd=w<guid>'));
} catch (e) {
  console.error('PROBE ERROR:', e.message);
} finally {
  await browser.close();
}
