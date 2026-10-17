// Spike (#142), read only: which Schoology app (Microsoft OneDrive or Google
// Drive) backs each current lti_submission task? Lists the teacher's current
// sections through the public API, then for each lti_submission assignment
// reads the assignment's public record and its web page over plain HTTP (saved
// session cookies, no browser) and reports the app hints it finds. Prints ids
// and titles only, no student data.
//
// Usage: node scripts/probe-lti-submission-apps.js [sectionId ...]
//        DUMP=<assignmentId> also prints the app-related snippets of that page.
import 'dotenv/config';
import { getMyUserId, getMySections, getSectionAssignments, apiGet } from '../server/services/schoology.js';
import { cookieJar, getPage } from '../server/services/schoologyWeb.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = cookieJar();
if (!jar) { console.error('No saved session'); process.exit(1); }

let sectionIds = process.argv.slice(2);
if (!sectionIds.length) {
  const me = await getMyUserId();
  const sections = await getMySections(me);
  sectionIds = sections.map((s) => String(s.id));
  console.log(`current sections: ${sectionIds.length}`);
}

const HINTS = [/google/ig, /onedrive/ig, /microsoft/ig];
// The page's React props name the app: "launchUrl":"/apps/lti/{appId}/run/assignment/{aid}…"
// and "submissionsTargetUrl":"https://lti-submission-{provider}.app.schoology.com/…".
function appOf(html) {
  const unesc = html.replace(/\\\//g, '/');
  const appId = unesc.match(/"launchUrl":"\/apps\/lti\/(\d+)\/run\/assignment\//)?.[1] ?? null;
  const target = unesc.match(/"submissionsTargetUrl":"(https:\/\/[^"]+)"/)?.[1] ?? null;
  return { appId, targetHost: target ? new URL(target).host : null };
}
const tally = new Map();

for (const sid of sectionIds) {
  const assignments = await getSectionAssignments(sid);
  const lti = assignments.filter((a) => a.assignment_type === 'lti_submission');
  console.log(`\nsection ${sid}: ${assignments.length} assignments, ${lti.length} lti_submission`);
  for (const a of lti) {
    await sleep(800);
    const detail = await apiGet(`/sections/${sid}/assignments/${a.id}`).catch((e) => ({ error: e.message }));
    const extraKeys = Object.keys(detail || {}).filter((k) => /lti|tool|app|external|provider|drive/i.test(k));
    let hints = {};
    try {
      const { html } = await getPage(jar, `/assignment/${a.id}`);
      const app = appOf(html);
      const k = `${app.appId} ${app.targetHost}`;
      tally.set(k, (tally.get(k) || 0) + 1);
      hints.app = app;
      for (const re of HINTS) {
        for (const m of html.matchAll(re)) hints[m[0].toLowerCase()] = (hints[m[0].toLowerCase()] || 0) + 1;
      }
      if (process.env.DUMP === String(a.id)) {
        for (const re of [/google/ig, /onedrive/ig, /microsoft/ig, /\/apps\/lti/ig]) {
          for (const m of html.matchAll(re)) console.log('   …' + html.slice(Math.max(0, m.index - 160), m.index + 160).replace(/\s+/g, ' ') + '…');
        }
      }
    } catch (e) { hints = { error: e.code || e.message }; }
    console.log(`  ${a.id} "${a.title}" detailKeys=[${extraKeys.join(',')}] hints=${JSON.stringify(hints)}`);
  }
}

console.log('\napps (appId targetHost → lti_submission tasks):');
for (const [k, n] of tally) console.log(`  ${k} → ${n}`);
