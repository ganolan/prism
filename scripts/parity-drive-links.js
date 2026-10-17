// Live check (#142), read only: run the shipped Google Drive link path
// (server/services/ltiSubmissionApps.js + server/lib/ltiSubmissionApp.js) on real
// assignments, then follow one built link through the LTI launch the way the
// teacher's browser would, and report where it lands. Prints counts, hosts and
// masked paths only.
//
// Usage: node scripts/parity-drive-links.js <assignmentId> [...]
import 'dotenv/config';
import { getLtiSubmissionApp, getSubmittedDocuments, ltiAppDeps } from '../server/services/ltiSubmissionApps.js';
import { driveLinksForSubmitted, GOOGLE_DRIVE } from '../server/lib/ltiSubmissionApp.js';
import { getPage, formFields } from '../server/services/schoologyWeb.js';
import { getSchoologyConfig } from '../server/middleware/featureGate.js';

const mask = (s) => String(s).replace(/(\/d\/)[A-Za-z0-9_-]+/g, '$1<fileId>').replace(/\b\d{6,}\b/g, (m) => `<${m.length}d>`);

for (const aid of process.argv.slice(2)) {
  const app = await getLtiSubmissionApp({ assignmentId: aid });
  console.log(`\n${mask(aid)}: app ${app.status} ${app.appId ?? ''} ${app.provider ?? ''}`);
  if (app.provider !== GOOGLE_DRIVE) continue;
  const sub = await getSubmittedDocuments({ assignmentId: aid });
  if (sub.status !== 'ok') { console.log('  submitted:', sub.status); continue; }
  // Every submitted student stands in for the roster here (the course isn't in this DB).
  const roster = sub.entries.map((e) => ({ schoology_uid: String(e.id) }));
  const links = driveLinksForSubmitted(sub.entries, roster, getSchoologyConfig().webBaseUrl, app.launchUrl);
  const n = Object.keys(links).length;
  console.log(`  submitted ${sub.entries.length}, links ${n}, with submittedAt ${Object.values(links).filter((l) => l.submittedAt).length}`);
  const first = Object.values(links)[0];
  if (!first) continue;
  // Follow the link: GET (launch form), POST the form with ext_submit, follow redirects.
  const jar = ltiAppDeps.cookieJar();
  const launch = await getPage(jar, first.url);
  const id = launch.html.match(/<form[^>]*\sid="([^"]+)"/)?.[1];
  const f = formFields(launch.html, id);
  const body = new URLSearchParams({ ...f.inputs, ext_submit: 'Submit' });
  let res = await fetch(f.action, { method: 'POST', body, redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  let url = f.action;
  const cookies = new Map();
  for (let hop = 0; hop < 6 && res.headers.get('location'); hop++) {
    for (const c of res.headers.getSetCookie?.() ?? []) { const [p] = c.split(';'); const i = p.indexOf('='); cookies.set(p.slice(0, i), p.slice(i + 1)); }
    url = new URL(res.headers.get('location'), url).href;
    if (!new URL(url).host.endsWith('schoology.com')) break;
    res = await fetch(url, { redirect: 'manual', headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  }
  console.log(`  first link lands on: ${new URL(url).host}${mask(new URL(url).pathname)}`);
}
