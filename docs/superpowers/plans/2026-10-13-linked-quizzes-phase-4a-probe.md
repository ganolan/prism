# Linked Quizzes, Phase 4a (Write Probe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learn exactly which requests Schoology's attempt page sends when a teacher saves an FRQ rubric level and comment, by one supervised same-value save on a past attempt, and record them in the API reference so phase 4b can replay them.

**Architecture:** One probe script (`scripts/probe-attempt-write.js`) with two stages. Stage A is read-only (every non-GET request aborted) and picks an attempt of the 2024-25 Unit 3 Organizing Data theory test whose rubric FRQ is already marked. Stage B, only with `--write` and the attempt id repeated in `--confirm`, drives the page the proven way (popup, level by label, Save, Save Changes), records every non-GET request to a file outside the repo, and reads the attempt back. Pure helpers (picking the FRQ, comparing before and after, the capture record, the output-folder guard) live in `scripts/lib/attemptProbe.js` with tests.

**Tech Stack:** Node ESM, Playwright (`chromium`, saved `storageState`), node-html-parser via Prism's parsers, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-linked-quiz-results-design.md`, §14 ("The probe"), with §2 and §9.

## Global Constraints

- Run from the repo root on the mini (`scripts/` resolves the repo's `node_modules`); never from `/tmp`.
- **Stage A sends no non-GET request** and never fetches a URL containing `unsubmit` or `delete`.
- **Stage B runs only with `--write` and `--confirm <attemptId>` equal to `--attempt`,** and only after Graham approves the attempt Stage A chose. It saves the **same** level and leaves the comment text unchanged.
- Captured requests and page copies go to `OUT_DIR`, which must be **outside the repo** (they hold student work).
- The API reference records only shapes observed in the captured file, with the probe date (AGENTS.md, "Never document a response shape you didn't observe").
- No em dashes in anything a person reads (script output is for Claude; docs follow the house rules).
- Test ids (2024-25, archived course 830): `7724138299` (AP CSP: Unit 3 - Organizing Data Theory Test (S)) and `7768898682` (its extra-time copy).

## Review Focus

1. **A rubric with more than one row:** Stage B refuses (the proven route covers one row); Stage A reports the row count. Test in Task 1.
2. **A stored level whose points match no rubric column:** not a candidate. Test in Task 1.
3. **Read-back differing anywhere** (another question's points, the comment by more than spacing): reported as a difference, never as success. Test in Task 1.
4. **`OUT_DIR` inside the repo, or unset:** refused before the browser starts. Test in Task 1.
5. **A captured request to a URL containing `unsubmit` or `delete`:** aborted, never continued, and logged. Covered by the route handler in Task 3 (reviewed by reading; it is browser code).

---

### Task 1: Pure probe helpers

**Files:**
- Create: `scripts/lib/attemptProbe.js`
- Test: `scripts/lib/attemptProbe.test.js`

**Interfaces:**
- Produces:
  - `pickFrq(attempt, rubricsById) => { qid, rubricId, enrollmentId, levelName, points, comment } | { reason }`; `attempt` is `parseQuizAttempt` output, `rubricsById` maps rubric id to `parseQuizRubric` output.
  - `compareAttempts(before, after) => string[]` (empty means unchanged).
  - `captureRecord(request) => { method, url, contentType, headerNames, body }`.
  - `assertOutsideRepo(dir, repoRoot)` (throws).

- [ ] **Step 1: Write the failing tests** (`scripts/lib/attemptProbe.test.js`)

```js
import { describe, test, expect } from 'vitest';
import { pickFrq, compareAttempts, captureRecord, assertOutsideRepo } from './attemptProbe.js';

const RUBRIC = { id: '77', title: 'FRQ', rows: [{ id: '5', title: 'Content Knowledge', levels: [
  { points: 4, name: 'Exhibiting Depth' }, { points: 3, name: 'Exhibiting' }, { points: 2, name: 'Developing' }, { points: 1, name: 'Emerging' }] }] };
const q = (over) => ({ qid: '100', kind: 'mcq', points: 1, rubricScore: null, comment: '', rubric: null, ...over });
const frq = (over) => q({ qid: '200', kind: 'frq', points: 3, maxPoints: 4, rubricScore: 3, comment: 'Good', rubric: { rubricId: '77', enrollmentId: '9' }, ...over });

describe('pickFrq', () => {
  test('the marked rubric FRQ, with its level name', () => {
    expect(pickFrq({ questions: [q(), frq()] }, { 77: RUBRIC })).toEqual({ qid: '200', rubricId: '77', enrollmentId: '9', levelName: 'Exhibiting', points: 3, comment: 'Good' });
  });
  test('reasons: no FRQ with a rubric, not marked, off the rubric, several rows', () => {
    expect(pickFrq({ questions: [q()] }, {})).toEqual({ reason: 'no FRQ with a Schoology rubric' });
    expect(pickFrq({ questions: [frq({ rubricScore: null })] }, { 77: RUBRIC })).toEqual({ reason: 'FRQ not marked' });
    expect(pickFrq({ questions: [frq({ rubricScore: 2.5 })] }, { 77: RUBRIC })).toEqual({ reason: 'stored score 2.5 is not a rubric level' });
    const two = { ...RUBRIC, rows: [RUBRIC.rows[0], { ...RUBRIC.rows[0], id: '6' }] };
    expect(pickFrq({ questions: [frq()] }, { 77: two })).toEqual({ reason: 'rubric has 2 rows' });
  });
});

describe('compareAttempts', () => {
  const before = { questions: [q(), frq()] };
  test('unchanged, ignoring spacing in the comment', () => {
    expect(compareAttempts(before, { questions: [q(), frq({ comment: ' Good \n' })] })).toEqual([]);
  });
  test('every difference is named', () => {
    const after = { questions: [q({ points: 0 }), frq({ rubricScore: 4, points: 4, comment: 'Changed' })] };
    expect(compareAttempts(before, after)).toEqual([
      'question 100: points 1 -> 0',
      'question 200: points 3 -> 4',
      'question 200: rubric score 3 -> 4',
      'question 200: comment changed',
    ]);
  });
  test('a missing question or page is a difference', () => {
    expect(compareAttempts(before, null)).toEqual(['attempt page did not parse']);
    expect(compareAttempts(before, { questions: [q()] })).toEqual(['question 200: missing after the save']);
  });
});

describe('captureRecord', () => {
  test('method, url, content type, header names only, and the body', () => {
    const req = { method: () => 'POST', url: () => 'https://schoology.hkis.edu.hk/x', headers: () => ({ 'content-type': 'application/json', cookie: 'secret', 'x-csrf-token': 't' }), postData: () => '{"a":1}' };
    expect(captureRecord(req)).toEqual({ method: 'POST', url: 'https://schoology.hkis.edu.hk/x', contentType: 'application/json', headerNames: ['content-type', 'cookie', 'x-csrf-token'], body: '{"a":1}' });
  });
});

describe('assertOutsideRepo', () => {
  test('refuses unset or inside the repo, accepts outside', () => {
    expect(() => assertOutsideRepo('', '/r/prism')).toThrow(/OUT_DIR/);
    expect(() => assertOutsideRepo('/r/prism/tmp', '/r/prism')).toThrow(/outside the repo/);
    expect(() => assertOutsideRepo('/r/prism', '/r/prism')).toThrow(/outside the repo/);
    expect(() => assertOutsideRepo('/tmp/probe', '/r/prism')).not.toThrow();
    expect(() => assertOutsideRepo('/r/prism-other', '/r/prism')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run scripts/lib/attemptProbe.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`scripts/lib/attemptProbe.js`)

```js
// Pure helpers for scripts/probe-attempt-write.js (linked quizzes phase 4a, spec §14).
import path from 'path';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function pickFrq(attempt, rubricsById) {
  const frq = (attempt?.questions || []).find(x => x.kind === 'frq' && x.rubric);
  if (!frq) return { reason: 'no FRQ with a Schoology rubric' };
  const rubric = rubricsById[frq.rubric.rubricId];
  if (!rubric) return { reason: `rubric ${frq.rubric.rubricId} not read` };
  if (rubric.rows.length !== 1) return { reason: `rubric has ${rubric.rows.length} rows` };
  if (frq.rubricScore == null) return { reason: 'FRQ not marked' };
  const level = rubric.rows[0].levels.find(l => l.points === Number(frq.rubricScore));
  if (!level) return { reason: `stored score ${frq.rubricScore} is not a rubric level` };
  return { qid: frq.qid, rubricId: frq.rubric.rubricId, enrollmentId: frq.rubric.enrollmentId, levelName: level.name, points: level.points, comment: frq.comment };
}

export function compareAttempts(before, after) {
  if (!after) return ['attempt page did not parse'];
  const out = [];
  const byQid = new Map(after.questions.map(x => [x.qid, x]));
  for (const b of before.questions) {
    const a = byQid.get(b.qid);
    if (!a) { out.push(`question ${b.qid}: missing after the save`); continue; }
    if (b.points !== a.points) out.push(`question ${b.qid}: points ${b.points} -> ${a.points}`);
    if (b.rubricScore !== a.rubricScore) out.push(`question ${b.qid}: rubric score ${b.rubricScore} -> ${a.rubricScore}`);
    if (norm(b.comment) !== norm(a.comment)) out.push(`question ${b.qid}: comment changed`);
  }
  return out;
}

export function captureRecord(request) {
  const headers = request.headers();
  return {
    method: request.method(), url: request.url(), contentType: headers['content-type'] ?? null,
    headerNames: Object.keys(headers).sort(), body: request.postData() ?? null,
  };
}

export function assertOutsideRepo(dir, repoRoot) {
  if (!dir) throw new Error('Set OUT_DIR to a folder outside the repo (captures hold student work)');
  const rel = path.relative(path.resolve(repoRoot), path.resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error(`OUT_DIR must be outside the repo: ${dir}`);
}
```

- [ ] **Step 4: Run to see them pass**

Run: `npx vitest run scripts/lib/attemptProbe.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/attemptProbe.js scripts/lib/attemptProbe.test.js
git commit -m "feat(quizzes): pure helpers for the attempt write probe"
```

---

### Task 2: Stage A, read-only scan

**Files:**
- Create: `scripts/probe-attempt-write.js`

**Interfaces:**
- Consumes: Task 1 helpers; `parseQuizResults`, `parseStudentStats` (`server/lib/parseQuizResults.js`), `parseQuizAttempt` (`server/lib/parseQuizAttempt.js`), `parseQuizRubric` (`server/lib/parseQuizRubric.js`), `sessionStateFile` (`server/lib/sessionPaths.js`).
- Produces: the CLI. `OUT_DIR=<dir> node scripts/probe-attempt-write.js scan <testId>...` prints one line per attempt checked and a JSON summary of the first candidate; writes the candidate's attempt page HTML to `OUT_DIR`.

- [ ] **Step 1: Write the script's shared part and Stage A**

```js
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
```

Stage A ships alone: Task 3 adds `write()` and its dispatch line.

- [ ] **Step 2: Run Stage A live (read-only)**

Run (from the repo root; `OUT_DIR` outside the repo):
`OUT_DIR=$HOME/prism-probes/attempt-write node scripts/probe-attempt-write.js scan 7724138299 7768898682`
Expected: a "takers" line per test, a reason line per skipped attempt, then a JSON candidate with `levelName`, `points`, `commentLength` and `editable` (`form`, `submit`, `launch`, `pointsDisabled`), and no `ABORTED` line for a Schoology write (an `ABORTED` analytics POST is fine and expected). If the session is dead, run `npm run mastery:login` first.

- [ ] **Step 3: Record and commit**

Write the Stage A result (test, attempt, level, whether editable; no student name, no comment text) into `.claude/build-progress.md` under a new "Linked quizzes, phase 4a" heading, then:

```bash
git add scripts/probe-attempt-write.js .claude/build-progress.md
git commit -m "feat(quizzes): attempt write probe, stage A (read-only scan)"
```

- [ ] **Step 4: Show Graham the candidate and stop**

Ask with AskUserQuestion: the test, the attempt id, the current level and comment length, the editable signals; options "Run Stage B on this attempt", "Use a current-year attempt instead" (spec §14 fallback), "Stop". Stage B waits for "Run Stage B".

---

### Task 3: Stage B, one same-value save

**Files:**
- Modify: `scripts/probe-attempt-write.js` (add `write()` and its dispatch line)

**Interfaces:**
- Consumes: `open({ allowWrites: true })`, `html`, `rubricOf`, Task 1 helpers.
- Produces: `OUT_DIR/stageB-requests-<attemptId>.json` (array of `captureRecord`), `stageB-before-<attemptId>.html`, `stageB-after-<attemptId>.html`, and a printed summary with the read-back differences.

- [ ] **Step 1: Add `write()`**

```js
async function write() {
  const testId = flag('test'), uid = flag('uid'), attemptId = flag('attempt');
  if (!testId || !uid || !attemptId) throw new Error('write needs --test, --uid and --attempt');
  if (flag('confirm') !== attemptId) throw new Error('write needs --confirm equal to --attempt (Graham approves the attempt first)');
  const attemptPath = `/assignment/${testId}/assessment_results/student_stats/${uid}/${attemptId}`;
  const { browser, page, captured } = await open({ allowWrites: true });
  try {
    const beforeHtml = await html(page, attemptPath);
    writeFileSync(`${OUT}/stageB-before-${attemptId}.html`, beforeHtml);
    const before = parseQuizAttempt(beforeHtml);
    const ids = [...new Set((before?.questions || []).filter(x => x.rubric).map(x => x.rubric.rubricId))];
    const rubrics = {};
    for (const id of ids) rubrics[id] = await rubricOf(page, id);
    const pick = pickFrq(before, rubrics);
    if (pick.reason) throw new Error(`Not a candidate: ${pick.reason}`);
    await page.waitForTimeout(1500);

    // The proven route (schoology plugin, export-test-results §6): synthetic mouse events, level by label.
    const clicked = await page.evaluate(({ qid }) => {
      const block = document.querySelector(`[name="components[0][${qid}][points]"]`)?.closest('.question-review');
      const launch = block?.querySelector('.grading-rubric-grading-launch, .s-grades-rubric-grading-launch-btn');
      if (!launch) return false;
      for (const t of ['mousedown', 'mouseup', 'click']) launch.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      return true;
    }, { qid: pick.qid });
    if (!clicked) throw new Error('Rubric launch not found');
    await page.waitForTimeout(2500);
    const chose = await page.evaluate(({ levelName }) => {
      const re = new RegExp(`^\\d\\s*${levelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`);
      const cell = [...document.querySelectorAll('td.rating-wrapper')].find(td => td.offsetParent !== null && re.test(td.textContent.trim()));
      if (!cell) return false;
      for (const t of ['mousedown', 'mouseup', 'click']) cell.dispatchEvent(new MouseEvent(t, { bubbles: true }));
      return true;
    }, { levelName: pick.levelName });
    if (!chose) throw new Error(`Level "${pick.levelName}" not found in the popup`);
    await page.waitForTimeout(800);
    await page.locator('button.submit-btn', { hasText: 'Save' }).first().click();
    await page.waitForTimeout(2500);
    const score = await page.evaluate((qid) => document.querySelector(`[name="components[0][${qid}][rubric_score]"]`)?.value, pick.qid);
    if (Number(score) !== pick.points) throw new Error(`rubric_score is ${score} after the popup, expected ${pick.points}: stopping before Save Changes`);

    // The comment is left as it is; Save Changes posts the form with it.
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 60000 }),
      page.locator('#s-assessment-edit-submission-form input[type=submit], #s-assessment-edit-submission-form button[type=submit]').first().click(),
    ]);
    const saved = (await page.content()).includes('Your changes have been saved');

    const afterHtml = await html(page, attemptPath);
    writeFileSync(`${OUT}/stageB-after-${attemptId}.html`, afterHtml);
    writeFileSync(`${OUT}/stageB-requests-${attemptId}.json`, JSON.stringify(captured, null, 1));
    const diffs = compareAttempts(before, parseQuizAttempt(afterHtml));
    console.log(JSON.stringify({ saved, requests: captured.map(c => `${c.method} ${c.url} (${c.contentType})`), readBack: diffs.length ? diffs : 'unchanged' }, null, 1));
  } finally { await browser.close(); }
}
```

Add the dispatch line `else if (command === 'write') await write();` after the `scan` branch.

- [ ] **Step 2: Check it parses without running it**

Run: `node --check scripts/probe-attempt-write.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit** (nothing has been written to Schoology yet)

```bash
git add scripts/probe-attempt-write.js
git commit -m "feat(quizzes): attempt write probe, stage B (same-value save, behind --write and --confirm)"
```

---

### Task 4: Run Stage B with approval, record the findings

**Files:**
- Modify: `.claude/schoology-api-reference.md` ("Questions, attempts and FRQ rubrics"), `.claude/build-progress.md`

- [ ] **Step 1: Run Stage B** (only after Graham chose "Run Stage B" in Task 2 Step 4)

Run: `OUT_DIR=$HOME/prism-probes/attempt-write node scripts/probe-attempt-write.js write --test <testId> --uid <uid> --attempt <attemptId> --confirm <attemptId>`
Expected: `saved: true`, a list of `SENT` requests, `readBack: "unchanged"`. If the read-back shows a difference, stop and tell Graham at once, with the difference and the attempt link, so he can check it in Schoology.

- [ ] **Step 2: Read the capture file**

Read `OUT_DIR/stageB-requests-<attemptId>.json` in full. For each request: method, URL pattern (ids replaced by their names), content type, header names (note CSRF-like headers), and the body's field names and value shapes. Re-read the file before each line written to the reference.

- [ ] **Step 3: Record in the API reference**

Under "Questions, attempts and FRQ rubrics", add "Saving an FRQ level and comment (write probe, <date>)": the attempt (test id, no student), each request as observed, which one carries the rubric cell, which carries the comment and the points, what the form needs (`form_build_id`, `form_token`, any CSRF header), the response status, and the read-back result. Note the accepted risk (a grading time or a notification may be recorded).

- [ ] **Step 4: Hand-off and commit**

Update the phase 4a section in `.claude/build-progress.md` (Stage B result, where the capture is, next: the phase 4b plan from these requests), then:

```bash
git add .claude/schoology-api-reference.md .claude/build-progress.md
git commit -m "docs(schoology): attempt write requests, from the phase 4a probe"
```

---

## Self-Review Notes

- Spec §14 "The probe": Stage A (Task 2), Stage B with `--write` and approval (Tasks 3, 4), capture outside the repo (Task 1 guard), recording observed shapes only (Task 4), accepted risk (Task 4 Step 3), fallback to a current-year attempt (Task 2 Step 4 option). The writer, UI and tests are phase 4b, planned from the capture.
