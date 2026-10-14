// server/services/quizLoader.js
// Reads a quiz group's Schoology pages through the saved browser session (spec §5).
// GET only. Pages are fetched as text inside the logged-in page and parsed in Node,
// one request at a time with a short pause. Any URL holding "unsubmit" or "delete"
// is refused: the results pages carry GET-href write actions.
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../lib/browserSession.js';
import { sessionDeps, noteSessionLive } from './schoologySession.js';
import { QuizError } from './quizError.js';
import { getGroup, resolveAssignment } from './quizGroups.js';
import { parseQuizQuestions } from '../lib/parseQuizQuestions.js';
import { parseQuizResults, parseStudentStats } from '../lib/parseQuizResults.js';
import { parseQuizAttempt } from '../lib/parseQuizAttempt.js';
import { parseQuizRubric, parseRubricGradeInfo } from '../lib/parseQuizRubric.js';
import { storeAttempt, removeAttempts, pruneOlderDuplicates, finishLoad } from './quizStore.js';
import { reconcileMarks } from './frqMarks.js';
import { holdGroup } from './quizLocks.js';

const FETCH_TIMEOUT_MS = 30000;

export function assertReadOnlyUrl(path) {
  if (/unsubmit|delete/i.test(path)) throw new Error(`Refusing a write-action URL: ${path}`);
}

async function inPageFetch({ url, accept, timeoutMs }) {
  try {
    const r = await fetch(url, { credentials: 'include', headers: accept ? { Accept: accept } : {}, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, text: await r.text(), finalUrl: r.url };
  } catch (err) {
    return { status: 0, text: '', finalUrl: url, error: String(err?.message || err) };
  }
}

// Opens Schoology's home page in the session page. Mirrors checkSessionLive: no page, or a browser error
// page, means Schoology was not reached, which says nothing about the session (UNREACHABLE). Only a real
// landing on another page (SSO) is expiry (NO_SESSION).
async function checkHome(page, expired) {
  let navError = null;
  const from = page.url();
  await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => { navError = err; });
  const landed = page.url();
  // A failed visit that left the page where it was reached nothing (on a recheck that is already home).
  if (navError && landed === from) throw new QuizError('UNREACHABLE', 'Could not reach Schoology: try again');
  if (isLoggedInUrl(landed)) return;
  if (navError || !landed || landed.startsWith('about:') || landed.startsWith('chrome-error:')) {
    throw new QuizError('UNREACHABLE', 'Could not reach Schoology: try again');
  }
  noteSessionLive('expired', 'Schoology sent the saved session to the login page');
  throw new QuizError('NO_SESSION', expired);
}

// `expired`: the NO_SESSION message for a session that ends after the reader opened.
export async function openReader({ openPage, pauseMs, expired = 'Schoology connection expired during the load: reconnect in Settings' }) {
  const session = await openPage();
  if (!session) throw new QuizError('NO_SESSION', 'No saved Schoology session: reconnect in Settings');
  try {
    await checkHome(session.page, 'Schoology connection expired: reconnect in Settings');
  } catch (err) {
    await session.close().catch(() => {});
    throw err;
  }
  // A read that fails outright (HTTP 0) may be a sign-in bounce: an in-page fetch redirected to SSO on
  // another origin is blocked, so it never shows the login URL. Home is opened again to tell a bounce
  // (NO_SESSION) and an unreachable Schoology (UNREACHABLE) from one failed read, which is returned.
  const recheck = () => checkHome(session.page, expired);
  let first = true;
  const get = async (path, { json = false } = {}) => {
    assertReadOnlyUrl(path);
    if (!first && pauseMs) await new Promise(r => setTimeout(r, pauseMs));
    first = false;
    const url = `${SCHOOLOGY_BASE}${path}`;
    let r;
    try {
      r = await session.page.evaluate(inPageFetch, { url, accept: json ? 'application/json' : null, timeoutMs: FETCH_TIMEOUT_MS });
    } catch (err) {
      // The page itself failed (crashed, navigated away): a failed read, not a bounce.
      r = { status: 0, text: '', finalUrl: url, error: String(err?.message || err) };
    }
    if (r.status !== 0 && r.finalUrl && !isLoggedInUrl(r.finalUrl)) {
      noteSessionLive('expired', 'Schoology sent the saved session to the login page');
      throw new QuizError('NO_SESSION', expired);
    }
    if (r.status === 0) await recheck();
    if (!json) return r;
    try { return { ...r, json: JSON.parse(r.text) }; } catch { return { ...r, json: null }; }
  };
  return { get, recheck, page: session.page, close: () => session.close().catch(() => {}) };
}

export async function readQuestionLists(db, { assignmentRefs }, { openPage = () => sessionDeps.openPage(), pauseMs = 400 } = {}) {
  const reader = await openReader({ openPage, pauseMs });
  try {
    const out = [];
    for (const ref of assignmentRefs) {
      const a = resolveAssignment(db, ref);
      if (!a) throw new QuizError('NOT_FOUND', `Unknown assignment ${ref}`);
      const r = await reader.get(`/assignment/${a.schoology_assignment_id}/assessment_questions`);
      const questions = r.status === 200 ? parseQuizQuestions(r.text) : null;
      if (!questions) throw new QuizError('NOT_FOUND', `Could not read the questions of "${a.title}" (HTTP ${r.status})`);
      out.push({ assignmentId: a.id, schoologyId: a.schoology_assignment_id, title: a.title, questions });
    }
    return out;
  } finally {
    await reader.close();
  }
}

export async function loadGroup(db, { groupId }, { openPage = () => sessionDeps.openPage(), pauseMs = 400, onProgress = () => {} } = {}) {
  const group = getGroup(db, groupId);
  const release = holdGroup(group.id, 'loading');
  const summary = { attempts: 0, notTaken: 0, failed: [], unknownUids: [], mismatches: [], multipleAttempts: [], removed: 0, marksPosted: 0 };
  const rubrics = {};
  let reader;
  try {
    reader = await openReader({ openPage, pauseMs });
    const studentByUid = new Map(db.prepare('SELECT id, schoology_uid FROM students').all().map(s => [String(s.schoology_uid), s.id]));
    // Reads and stores one student's counted attempt. Returns a failure reason, or null when stored.
    const loadStudent = async (uid, studentId, member) => {
      const sid = member.schoology_assignment_id;
      const stats = await reader.get(`/assignment/${sid}/assessment_results/student_stats/${uid}`);
      const attempts = stats.status === 200 ? parseStudentStats(stats.text, { uid }) : [];
      if (!attempts.length) return `attempt list HTTP ${stats.status}`;
      // Counted attempt: latest startedAt; ties/nulls fall back to the later row in page order.
      const counted = attempts.reduce((best, a) => ((a.startedAt || '') >= (best.startedAt || '') ? a : best));
      const page = await reader.get(`/assignment/${sid}/assessment_results/student_stats/${uid}/${counted.attemptId}`);
      const parsed = page.status === 200 ? parseQuizAttempt(page.text) : null;
      if (!parsed) return `attempt page HTTP ${page.status}`;
      const gradeInfo = {};
      for (const q of parsed.questions) {
        if (!q.rubric) continue;
        if (!rubrics[q.rubric.rubricId]) {
          const rj = await reader.get(`/iapi/grades/rubric/${q.rubric.rubricId}`, { json: true });
          const rubric = rj.status === 200 ? parseQuizRubric(rj.json) : null;
          if (!rubric) return `rubric HTTP ${rj.status}`;
          rubrics[q.rubric.rubricId] = rubric;
        }
        const gi = await reader.get(`/iapi/grades/assessment_component_submission_rubric_grade_info/${q.rubric.rubricId}/${q.qid}/${q.rubric.enrollmentId}/${counted.attemptId}`, { json: true });
        const info = gi.status === 200 ? parseRubricGradeInfo(gi.json) : null;
        if (!info) return `grade info HTTP ${gi.status}`;
        gradeInfo[q.qid] = info;
      }
      const stored = storeAttempt(db, { groupId: group.id, assignmentId: member.id, studentId, attempt: counted, attemptCount: attempts.length, parsed, rubrics, gradeInfo });
      summary.mismatches.push(...stored.mismatches);
      if (attempts.length > 1 && !summary.multipleAttempts.includes(uid)) summary.multipleAttempts.push(uid);
      return null;
    };
    // A student assigned both copies sits one: "not taken" counts a student no copy shows as sat.
    const notSat = new Set();
    const sat = new Set();
    for (const member of group.members) {
      const sid = member.schoology_assignment_id;
      const res = await reader.get(`/assignment/${sid}/assessment_results`);
      let rows = null;
      try { rows = res.status === 200 ? parseQuizResults(res.text) : null; } catch { rows = null; }
      if (!rows) { summary.failed.push({ uid: null, reason: `results page for "${member.title}" HTTP ${res.status}` }); continue; }
      // The page parsed, so a student it lists as not attempted has no attempt in Schoology now:
      // drop any stored one (the teacher deleted it there). Failed, unknown and unlisted students are left alone.
      const gone = rows.filter(r => r.attempted === false).map(r => studentByUid.get(r.uid)).filter(Boolean);
      summary.removed += removeAttempts(db, { assignmentId: member.id, studentIds: gone });
      for (const row of rows) {
        if (row.attempted === false) { notSat.add(row.uid); continue; }
        sat.add(row.uid);
        if (row.attempted === null) { summary.failed.push({ uid: row.uid, reason: `results page shows "${row.text}"` }); continue; }
        const studentId = studentByUid.get(row.uid);
        if (!studentId) { if (!summary.unknownUids.includes(row.uid)) summary.unknownUids.push(row.uid); continue; }
        onProgress({ uid: row.uid, member: sid });
        try {
          const problem = await loadStudent(row.uid, studentId, member);
          if (problem) summary.failed.push({ uid: row.uid, reason: problem });
        } catch (err) {
          if (err instanceof QuizError && (err.code === 'NO_SESSION' || err.code === 'UNREACHABLE')) throw err;
          summary.failed.push({ uid: row.uid, reason: String(err?.message || err) });
        }
      }
    }
    summary.notTaken = [...notSat].filter(uid => !sat.has(uid)).length;
    pruneOlderDuplicates(db, { groupId: group.id });
    // A mark posted in Schoology (by an agent or by hand) shows in the copy just stored.
    summary.marksPosted = reconcileMarks(db, { groupId: group.id }).posted;
    summary.attempts = db.prepare('SELECT COUNT(*) n FROM quiz_attempts WHERE group_id = ?').get(group.id).n;
    finishLoad(db, { groupId: group.id, summary, mismatches: summary.mismatches });
    return summary;
  } finally {
    release();
    await reader?.close();
  }
}
