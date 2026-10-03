// Probe (#53, triage resubmissions): can Prism see an LTI (OneDrive) resubmission?
//
// Question: when a teacher unsubmits graded LTI work and the student submits
// again, does the grader's `submitted-documents` `submissionDate` move to the
// new time while the REST grade `timestamp` stays at the grading time? If so,
// `submissionDate > grade timestamp` on a graded cell = resubmitted, exactly
// like native dropbox's latest_revision_at > submitted_at (#49).
//
// READ-ONLY: Schoology GETs only (reminders drill-down, grader document lists,
// REST /sections/{id}/grades + enrollments) and a read-only open of the DB.
// Student identities are masked (S01…); no names are printed.
//
// Usage: DB_PATH=<db> [SESSION_FILE=<storage-state.json>] [ARCHIVED=1] node scripts/probe-lti-resubmission.js
import 'dotenv/config';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { join } from 'path';
import { existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';
import { parseSubmissionDate } from '../server/lib/parseGraderDocuments.js';
import { getSectionGrades, getSectionEnrollments } from '../server/services/schoology.js';

const DB_PATH = process.env.DB_PATH;
// ARCHIVED=1: probe last year's graded LTI work instead of current courses.
const ARCHIVED = process.env.ARCHIVED === '1' ? 1 : 0;
const STATE_FILE = process.env.SESSION_FILE || join(process.cwd(), '.playwright-session', 'storage-state.json');
if (!DB_PATH || !existsSync(DB_PATH)) { console.error('Set DB_PATH to an existing database'); process.exit(1); }
if (!existsSync(STATE_FILE)) { console.error(`No session at ${STATE_FILE}`); process.exit(1); }

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();
await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
if (!isLoggedInUrl(page.url())) { console.error('SESSION DEAD — run npm run mastery:login'); await browser.close(); process.exit(1); }

async function fetchText(path) {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' });
    return { status: r.status, text: await r.text() };
  }, `${SCHOOLOGY_BASE}${path}`);
}
async function fetchJson(path) {
  const r = await fetchText(path);
  let json = null; try { json = JSON.parse(r.text); } catch {}
  return { status: r.status, json };
}

let n = 0; const mask = new Map();
const m = (uid) => { if (!mask.has(uid)) mask.set(uid, 'S' + String(++n).padStart(2, '0')); return mask.get(uid); };
const iso = (epoch) => (epoch ? new Date(epoch * 1000).toLocaleString('en-GB', { hour12: false }) : '—');

const assignmentRow = db.prepare(`
  SELECT a.id, a.schoology_assignment_id AS aid, a.title, a.is_lti_submission AS lti, a.accepts_submissions,
         c.schoology_section_id AS sectionId, c.course_name AS course, c.archived
  FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.schoology_assignment_id = ?
`);

// ── 1. Schoology's own resubmission reminders (assignment-level counts) ──
console.log('===== 1. Reminders: re-submitted assignments =====');
const rem = await fetchText('/home/reminders_list/resubmission?get_selector=grade-item,resubmission');
let remHtml = rem.text; try { remHtml = JSON.parse(rem.text); } catch {}
console.log(`status=${rem.status} htmlLen=${typeof remHtml === 'string' ? remHtml.length : 'n/a'}`);
const reminders = [];
if (typeof remHtml === 'string') {
  const re = /href="\/assignment\/(\d+)\/info"[\s\S]*?reminder-list-count[^>]*>\s*([^<]*)</g;
  let mt;
  while ((mt = re.exec(remHtml))) reminders.push({ aid: mt[1], count: mt[2].trim() });
}
const remByAid = new Map(reminders.map((r) => [r.aid, r.count]));
for (const r of reminders) {
  const a = assignmentRow.get(r.aid);
  console.log(`  aid=${r.aid} count=${r.count} → ${a ? `${a.lti ? 'LTI' : 'native'} | ${a.course}${a.archived ? ' (archived)' : ''} | ${a.title}` : 'not in Prism DB'}`);
}
if (reminders.length === 0) console.log('  (none parsed) head:', String(remHtml).slice(0, 400));

// ── 2. LTI assignments: grader submissionDate vs REST grade timestamp ──
const ltiTargets = db.prepare(`
  SELECT DISTINCT a.schoology_assignment_id AS aid FROM assignments a JOIN courses c ON c.id = a.course_id
  WHERE a.is_lti_submission = 1 AND a.published = 1 AND c.excluded = 0
    AND (c.archived = 0 OR (? = 1 AND EXISTS (SELECT 1 FROM grades g WHERE g.assignment_id = a.id AND g.score IS NOT NULL)))
    AND (? = 0 OR c.archived = 1)
`).all(ARCHIVED, ARCHIVED).map((r) => r.aid);
for (const r of reminders) {
  const a = assignmentRow.get(r.aid);
  if (a?.lti && !ltiTargets.includes(r.aid)) ltiTargets.push(r.aid);
}

const sectionCache = new Map();
async function sectionData(sectionId) {
  if (!sectionCache.has(sectionId)) {
    const [grades, enrollments] = await Promise.all([getSectionGrades(sectionId), getSectionEnrollments(sectionId)]);
    const uidByEnrol = new Map((enrollments || []).map((e) => [String(e.id), String(e.uid)]));
    sectionCache.set(sectionId, { grades, uidByEnrol });
  }
  return sectionCache.get(sectionId);
}

console.log('\n===== 2. LTI: submissionDate vs REST grade timestamp =====');
const summary = [];
for (const aid of ltiTargets) {
  const a = assignmentRow.get(aid);
  const { grades, uidByEnrol } = await sectionData(a.sectionId);
  const restByUid = new Map(grades.filter((g) => String(g.assignment_id) === String(aid))
    .map((g) => [uidByEnrol.get(String(g.enrollment_id)), g]));
  const sub = await fetchJson(`/iapi2/assignments/${aid}/submitted-documents/`);
  const inp = await fetchJson(`/iapi2/assignments/${aid}/in-progress-documents/`);
  const subRows = sub.json?.data || [];
  const inpRows = inp.json?.data || [];
  const graded = [...restByUid.values()].filter((g) => g.grade != null && g.grade !== '').length;
  console.log(`\n--- aid=${aid} | ${a.course} | ${a.title} | reminders=${remByAid.get(aid) ?? '-'}`);
  console.log(`    submitted=${subRows.length} (status ${sub.status}) in-progress=${inpRows.length} (status ${inp.status}) restGraded=${graded}`);
  let candidates = 0; let gradedAfter = 0; let gradedInProgress = 0;
  for (const r of subRows) {
    const uid = String(r.id);
    const g = restByUid.get(uid);
    const subAt = parseSubmissionDate(r.submissionDate);
    const ts = Number(g?.timestamp) || 0;
    const hasGrade = g && g.grade != null && g.grade !== '';
    // submissionDate has minute resolution: allow 60 s slack.
    const verdict = !hasGrade ? 'ungraded'
      : subAt && ts && subAt > ts + 60 ? 'SUBMITTED-AFTER-GRADE'
      : 'graded-after-submission';
    if (verdict === 'SUBMITTED-AFTER-GRADE') candidates++;
    if (verdict === 'graded-after-submission') gradedAfter++;
    console.log(`    ${m(uid)} SUB  date=${JSON.stringify(r.submissionDate)} (${iso(subAt)}) timing=${r.submissionTiming} | REST grade=${g?.grade ?? '—'} exc=${g?.exception ?? '—'} ts=${iso(ts)} → ${verdict}`);
  }
  for (const r of inpRows) {
    const uid = String(r.id);
    const g = restByUid.get(uid);
    const hasGrade = g && g.grade != null && g.grade !== '';
    if (hasGrade) gradedInProgress++;
    if (hasGrade || r.revisionCreated) {
      console.log(`    ${m(uid)} INP  revisionCreated=${r.revisionCreated} date=${JSON.stringify(r.submissionDate)} | REST grade=${g?.grade ?? '—'} ts=${iso(Number(g?.timestamp) || 0)}${hasGrade ? ' ← GRADED but in-progress (unsubmitted after grading?)' : ''}`);
    }
  }
  summary.push({ aid, title: a.title, submitted: subRows.length, candidates, gradedAfter, gradedInProgress, reminders: remByAid.get(aid) ?? '-' });
}

// ── 3. Native reminder assignments: Schoology's count vs Prism's isResubmitted ──
console.log('\n===== 3. Native reminders vs Prism DB (latest_revision_at > submitted_at) =====');
for (const r of reminders) {
  const a = assignmentRow.get(r.aid);
  if (!a || a.lti) continue;
  const prism = db.prepare(`
    SELECT COUNT(*) AS n FROM grades WHERE assignment_id = ? AND submitted_at > 0 AND latest_revision_at > submitted_at
      AND (score IS NOT NULL OR exception > 0)
  `).get(a.id).n;
  console.log(`  aid=${r.aid} Schoology=${r.count} Prism=${prism} | ${a.title}`);
}

console.log('\n===== SUMMARY (LTI) =====');
console.table(summary);
await browser.close();
db.close();
