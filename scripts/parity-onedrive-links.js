// Parity (#141): the OneDrive student-copy listing through the old browser transport (a headless page
// signed in to SharePoint, in-page fetch) against plain HTTP (sharePointWeb.signInToSharePoint), with the
// same listing logic (sharePointWeb.listAssignmentFiles). Every OneDrive (LTI) assignment in the
// database, read both ways. Prints counts and differences by assignment id only: file names hold
// student names. Read-only.
//
// Usage: [PRISM_SESSION_DIR=…] [PARITY_DB=path/to/students.db] [HTTP_FIRST=1] node scripts/parity-onedrive-links.js
// (HTTP_FIRST reads each assignment over HTTP before the browser, to see order effects on timing.)
import 'dotenv/config';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { sessionStateFile } from '../server/lib/sessionPaths.js';
import { getMicrosoftConfig } from '../server/middleware/featureGate.js';
import { signInToSharePoint, listAssignmentFiles } from '../server/services/sharePointWeb.js';

const db = new Database(process.env.PARITY_DB || 'server/db/students.db', { readonly: true });
const pairs = db.prepare(`SELECT c.schoology_section_id AS sectionId, a.schoology_assignment_id AS assignmentId
  FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.is_lti_submission = 1 ORDER BY c.archived, a.id`).all();
const origin = new URL(getMicrosoftConfig().sharepointHost).origin;
console.log(`${pairs.length} OneDrive (LTI) assignments`);

async function browserSide() {
  const t = Date.now();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: sessionStateFile() });
  const page = await context.newPage();
  await page.goto(`${origin}/_layouts/15/onedrive.aspx`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForURL((u) => u.origin === origin, { timeout: 60000 }).catch(() => {});
  const getJson = (url) => page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { Accept: 'application/json;odata=nometadata' }, credentials: 'include' });
    if (r.status !== 200) return null;
    try { return await r.json(); } catch { return null; }
  }, url);
  const me = await getJson(`${origin}/_api/SP.UserProfiles.PeopleManager/GetMyProperties?$select=PersonalUrl`);
  return { list: listAssignmentFiles({ origin, personal: me.PersonalUrl.replace(/\/?$/, '/'), getJson }), signIn: Date.now() - t, close: () => browser.close() };
}
async function httpSide() {
  const t = Date.now();
  const s = await signInToSharePoint({ origin });
  if (s.status !== 'ok') throw new Error(`HTTP sign-in: ${s.status}`);
  return { list: listAssignmentFiles(s), signIn: Date.now() - t, close: async () => {} };
}

const sides = { browser: await browserSide(), http: await httpSide() };
console.log(`sign-in: browser ${sides.browser.signIn} ms (launch included), http ${sides.http.signIn} ms`);
const time = { browser: 0, http: 0 };
const canon = (r) => JSON.stringify(r.status === 'ok' ? { ...r, files: [...r.files].sort((x, y) => (x.Name < y.Name ? -1 : 1)) } : r);
let same = 0; let files = 0; const statuses = {}; const diffs = [];
for (const p of pairs) {
  const out = {};
  for (const side of (process.env.HTTP_FIRST ? ['http', 'browser'] : ['browser', 'http'])) {
    const t = Date.now();
    out[side] = await sides[side].list(p.sectionId, p.assignmentId);
    time[side] += Date.now() - t;
  }
  statuses[out.http.status] = (statuses[out.http.status] ?? 0) + 1;
  if (canon(out.browser) === canon(out.http)) { same++; files += out.http.files?.length ?? 0; } else diffs.push(`${p.assignmentId}: browser ${out.browser.status} (${out.browser.files?.length ?? '-'}) vs http ${out.http.status} (${out.http.files?.length ?? '-'})`);
}
await sides.browser.close();
console.log(`identical ${same}/${pairs.length} (${files} files); http statuses ${JSON.stringify(statuses)}`);
console.log(`listing time: browser ${time.browser} ms, http ${time.http} ms`);
for (const d of diffs) console.log(`DIFF ${d}`);
