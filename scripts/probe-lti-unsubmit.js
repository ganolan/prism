// Probe (Phase 2, triage resubmissions): can Prism unsubmit a student's LTI
// (OneDrive) submission the way the grader's Unsubmit button does?
//   POST /iapi2/assignments/{aid}/submission-action/{uid}  body {"isSubmit":false}
//   headers X-Csrf-Token / X-Csrf-Key from Drupal.settings.s_common (assignment
//   React bundle: sgyCsrf + submitDocument(aid, false, studentDocument.id)).
//
// DEFAULT IS READ-ONLY: prints the pair's grader entries (submitted / in-progress),
// the REST grade record, and whether the page exposes the CSRF pair.
// The WRITE runs only with CONFIRM=<aid>:<uid> matching the arguments — one
// student, one assignment, after the teacher's explicit go-ahead.
//
// Usage: [SESSION_FILE=…] node scripts/probe-lti-unsubmit.js <sectionId> <assignmentId> [uid]
//        [ACTION=resubmit] CONFIRM=<unsubmit|resubmit>:<assignmentId>:<uid> node scripts/probe-lti-unsubmit.js <sectionId> <assignmentId> <uid>
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';
import { getSectionGrades, getSectionEnrollments } from '../server/services/schoology.js';

const [sectionId, aid, uidArg] = process.argv.slice(2);
if (!sectionId || !aid) { console.error('usage: <sectionId> <assignmentId> [uid]'); process.exit(1); }
const STATE_FILE = process.env.SESSION_FILE || join(process.cwd(), '.playwright-session', 'storage-state.json');
// ACTION=resubmit sends {isSubmit:true} (the restore attempt); default unsubmit.
const action = process.env.ACTION === 'resubmit' ? 'resubmit' : 'unsubmit';
const confirmed = uidArg && process.env.CONFIRM === `${action}:${aid}:${uidArg}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();
await page.goto(`${SCHOOLOGY_BASE}/assignments/${aid}/info`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
if (!isLoggedInUrl(page.url())) { console.error('SESSION DEAD — run npm run mastery:login'); await browser.close(); process.exit(1); }

const getJson = (p) => page.evaluate(async (u) => {
  const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' });
  let j = null; try { j = JSON.parse(await r.text()); } catch {}
  return { status: r.status, json: j };
}, `${SCHOOLOGY_BASE}${p}`);

async function state(label) {
  const sub = await getJson(`/iapi2/assignments/${aid}/submitted-documents/`);
  const inp = await getJson(`/iapi2/assignments/${aid}/in-progress-documents/`);
  const pick = (rows) => (rows || []).filter((r) => !uidArg || String(r.id) === String(uidArg));
  const enrol = await getSectionEnrollments(sectionId);
  const enrolId = new Map(enrol.map((e) => [String(e.uid), String(e.id)]));
  const grades = (await getSectionGrades(sectionId)).filter((g) => String(g.assignment_id) === String(aid));
  console.log(`\n=== ${label} === submitted-documents ${sub.status}, in-progress-documents ${inp.status}`);
  const show = (kind, r) => {
    const g = grades.find((x) => String(x.enrollment_id) === enrolId.get(String(r.id)));
    console.log(`  ${kind} uid=${r.id} ${r.firstName} ${r.lastName} | submissionStatus=${r.submissionStatus} timing=${r.submissionTiming} date=${JSON.stringify(r.submissionDate)} revisionCreated=${r.revisionCreated} | grader grade=${r.grade} | REST grade=${g?.grade ?? '—'} exc=${g?.exception ?? '—'} ts=${g?.timestamp ?? '—'} comment_status=${g?.comment_status ?? '—'} comment=${JSON.stringify((g?.comment || '').slice(0, 60))}`);
  };
  for (const r of pick(sub.json?.data)) show('SUB', r);
  for (const r of pick(inp.json?.data)) show('INP', r);
  if (!uidArg) console.log(`  (${(sub.json?.data || []).length} submitted, ${(inp.json?.data || []).length} in progress — pass a uid to focus)`);
}

const csrf = await page.evaluate(() => {
  const s = window.Drupal?.settings?.s_common || {};
  return { hasToken: !!s.csrf_token, hasKey: !!s.csrf_key };
});
console.log(`page: ${page.url()} | CSRF on page: token=${csrf.hasToken} key=${csrf.hasKey}`);
await state('BEFORE');

if (!uidArg) { await browser.close(); process.exit(0); }
if (!confirmed) {
  console.log(`\nREAD-ONLY. To ${action} this one student, re-run with CONFIRM=${action}:${aid}:${uidArg}`);
  await browser.close(); process.exit(0);
}

console.log(`\n>>> WRITE (${action}): POST /iapi2/assignments/${aid}/submission-action/${uidArg} {"isSubmit":${action === 'resubmit'}}`);
const res = await page.evaluate(async ({ u, isSubmit }) => {
  const s = window.Drupal?.settings?.s_common || {};
  const r = await fetch(u, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Csrf-Token': s.csrf_token, 'X-Csrf-Key': s.csrf_key },
    body: JSON.stringify({ isSubmit }),
  });
  return { status: r.status, body: (await r.text()).slice(0, 600) };
}, { u: `${SCHOOLOGY_BASE}/iapi2/assignments/${aid}/submission-action/${uidArg}`, isSubmit: action === 'resubmit' });
console.log(`<<< status ${res.status} body ${res.body}`);
await page.waitForTimeout(3000);
await state('AFTER');
await browser.close();
