// Linked quizzes phase 4a (spec §14): learn the requests Schoology's attempt page sends when a
// teacher saves an FRQ rubric level and comment.
//   scan <testId>...   Stage A, read-only: every non-GET request is aborted. Finds an attempt whose
//                      one-row rubric FRQ is marked, and reports whether its form is editable.
//   write --test <testId> --uid <uid> --attempt <attemptId> --confirm <attemptId>
//                      Stage B: the same level saved again, the comment unchanged, every non-GET
//                      request recorded, the attempt read back. Only with Graham's approval.
// Captures go to OUT_DIR, outside the repo (they hold student work).
// Usage: OUT_DIR=<dir> [PRISM_SESSION_DIR=<dir>] node scripts/probe-attempt-write.js <command> ...
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { sessionStateFile } from '../server/lib/sessionPaths.js';
import { parseQuizResults, parseStudentStats } from '../server/lib/parseQuizResults.js';
import { parseQuizAttempt } from '../server/lib/parseQuizAttempt.js';
import { parseQuizRubric } from '../server/lib/parseQuizRubric.js';
import { pickFrq, compareAttempts, captureRecord, assertOutsideRepo } from './lib/attemptProbe.js';

const BASE = 'https://schoology.hkis.edu.hk';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OUT_DIR;
assertOutsideRepo(OUT, REPO);
mkdirSync(OUT, { recursive: true });

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : null; };
const WRITE_ACTION = /unsubmit|delete/i;

async function open({ allowWrites }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: sessionStateFile() });
  const captured = [];
  await context.route('**/*', (route) => {
    const req = route.request();
    if (WRITE_ACTION.test(req.url())) { console.log('ABORTED write-action URL', req.method(), req.url()); return route.abort(); }
    if (req.method() === 'GET') return route.continue();
    if (!allowWrites || !req.url().startsWith(BASE)) { console.log('ABORTED', req.method(), req.url()); return route.abort(); }
    captured.push(captureRecord(req));
    console.log('SENT', req.method(), req.url());
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!page.url().startsWith(BASE)) throw new Error(`Not logged in to Schoology (landed on ${page.url()}): run npm run mastery:login`);
  return { browser, page, captured };
}

async function html(page, p) {
  await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle', timeout: 60000 });
  return page.content();
}

async function rubricOf(page, rubricId) {
  const r = await page.evaluate(async (u) => (await fetch(u, { headers: { Accept: 'application/json' } })).text(), `${BASE}/iapi/grades/rubric/${rubricId}`);
  return parseQuizRubric(JSON.parse(r));
}

// Signals that the teacher can edit this attempt in the archived section.
async function editable(page, qid) {
  return page.evaluate((id) => {
    const form = document.querySelector('#s-assessment-edit-submission-form');
    const submit = form?.querySelector('input[type=submit], button[type=submit]');
    const block = document.querySelector(`[name="components[0][${id}][points]"]`)?.closest('.question-review');
    return {
      form: !!form,
      submit: submit ? { value: submit.value || submit.textContent.trim(), disabled: submit.disabled } : null,
      launch: !!block?.querySelector('.grading-rubric-grading-launch, .s-grades-rubric-grading-launch-btn'),
      pointsDisabled: !!document.querySelector(`[name="components[0][${id}][points]"]`)?.disabled,
    };
  }, qid);
}

async function scan(testIds) {
  const { browser, page } = await open({ allowWrites: false });
  try {
    for (const testId of testIds) {
      const takers = parseQuizResults(await html(page, `/assignment/${testId}/assessment_results`)) || [];
      console.log(`test ${testId}: ${takers.filter(t => t.attempted).length} takers`);
      for (const t of takers.filter(x => x.attempted)) {
        const stats = parseStudentStats(await html(page, `/assignment/${testId}/assessment_results/student_stats/${t.uid}`), { uid: t.uid });
        const latest = stats?.[stats.length - 1];
        if (!latest) { console.log(`  ${t.uid}: no attempt link`); continue; }
        const attemptPath = `/assignment/${testId}/assessment_results/student_stats/${t.uid}/${latest.attemptId}`;
        const attemptHtml = await html(page, attemptPath);
        const attempt = parseQuizAttempt(attemptHtml);
        const ids = [...new Set((attempt?.questions || []).filter(x => x.rubric).map(x => x.rubric.rubricId))];
        const rubrics = {};
        for (const id of ids) rubrics[id] = await rubricOf(page, id);
        const pick = pickFrq(attempt, rubrics);
        if (pick.reason) { console.log(`  ${t.uid}/${latest.attemptId}: ${pick.reason}`); continue; }
        const edit = await editable(page, pick.qid);
        writeFileSync(`${OUT}/stageA-attempt-${latest.attemptId}.html`, attemptHtml);
        console.log(JSON.stringify({ candidate: { testId, uid: t.uid, attemptId: latest.attemptId, ...pick, commentLength: pick.comment.length, comment: undefined }, editable: edit }, null, 1));
        return;
      }
    }
    console.log('No candidate found');
  } finally { await browser.close(); }
}

if (command === 'scan') await scan(rest);
else { console.log('Usage: scan <testId>... | write --test <id> --uid <uid> --attempt <id> --confirm <id>'); process.exitCode = 1; }
