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
import { storeAttempt, pruneOlderDuplicates, finishLoad } from './quizStore.js';

const FETCH_TIMEOUT_MS = 30000;
const loading = new Set();

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

async function openReader({ openPage, pauseMs }) {
  const session = await openPage();
  if (!session) throw new QuizError('NO_SESSION', 'No saved Schoology session: reconnect in Settings');
  await session.page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  if (!isLoggedInUrl(session.page.url())) {
    await session.close().catch(() => {});
    noteSessionLive('expired', 'Schoology sent the saved session to the login page');
    throw new QuizError('NO_SESSION', 'Schoology connection expired: reconnect in Settings');
  }
  let first = true;
  const get = async (path, { json = false } = {}) => {
    assertReadOnlyUrl(path);
    if (!first && pauseMs) await new Promise(r => setTimeout(r, pauseMs));
    first = false;
    const r = await session.page.evaluate(inPageFetch, { url: `${SCHOOLOGY_BASE}${path}`, accept: json ? 'application/json' : null, timeoutMs: FETCH_TIMEOUT_MS });
    if (r.finalUrl && !isLoggedInUrl(r.finalUrl)) {
      noteSessionLive('expired', 'Schoology sent the saved session to the login page');
      throw new QuizError('NO_SESSION', 'Schoology connection expired during the load: reconnect in Settings');
    }
    if (!json) return r;
    try { return { ...r, json: JSON.parse(r.text) }; } catch { return { ...r, json: null }; }
  };
  return { get, close: () => session.close().catch(() => {}) };
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
  if (loading.has(group.id)) throw new QuizError('BUSY', 'This quiz is already loading');
  loading.add(group.id);
  const summary = { attempts: 0, notTaken: 0, failed: [], unknownUids: [], mismatches: [], multipleAttempts: [] };
  const rubrics = {};
  let reader;
  try {
    reader = await openReader({ openPage, pauseMs });
    const studentByUid = new Map(db.prepare('SELECT id, schoology_uid FROM students').all().map(s => [String(s.schoology_uid), s.id]));
    for (const member of group.members) {
      const sid = member.schoology_assignment_id;
      const res = await reader.get(`/assignment/${sid}/assessment_results`);
      const rows = res.status === 200 ? parseQuizResults(res.text) : null;
      if (!rows) { summary.failed.push({ uid: null, reason: `results page for "${member.title}" HTTP ${res.status}` }); continue; }
      for (const row of rows) {
        if (!row.attempted) { summary.notTaken++; continue; }
        const studentId = studentByUid.get(row.uid);
        if (!studentId) { summary.unknownUids.push(row.uid); continue; }
        onProgress({ uid: row.uid, member: sid });
        const stats = await reader.get(`/assignment/${sid}/assessment_results/student_stats/${row.uid}`);
        const attempts = stats.status === 200 ? parseStudentStats(stats.text, { uid: row.uid }) : [];
        if (!attempts.length) { summary.failed.push({ uid: row.uid, reason: `attempt list HTTP ${stats.status}` }); continue; }
        if (attempts.length > 1) summary.multipleAttempts.push(row.uid);
        // Counted attempt: latest startedAt; ties/nulls fall back to the later row in page order.
        const counted = attempts.reduce((best, a) => ((a.startedAt || '') >= (best.startedAt || '') ? a : best));
        const page = await reader.get(`/assignment/${sid}/assessment_results/student_stats/${row.uid}/${counted.attemptId}`);
        const parsed = page.status === 200 ? parseQuizAttempt(page.text) : null;
        if (!parsed) { summary.failed.push({ uid: row.uid, reason: `attempt page HTTP ${page.status}` }); continue; }
        const gradeInfo = {};
        for (const q of parsed.questions) {
          if (!q.rubric) continue;
          if (!(q.rubric.rubricId in rubrics)) {
            const rj = await reader.get(`/iapi/grades/rubric/${q.rubric.rubricId}`, { json: true });
            rubrics[q.rubric.rubricId] = parseQuizRubric(rj.json);
          }
          const gi = await reader.get(`/iapi/grades/assessment_component_submission_rubric_grade_info/${q.rubric.rubricId}/${q.qid}/${q.rubric.enrollmentId}/${counted.attemptId}`, { json: true });
          gradeInfo[q.qid] = parseRubricGradeInfo(gi.json);
        }
        const stored = storeAttempt(db, { groupId: group.id, assignmentId: member.id, studentId, attempt: counted, attemptCount: attempts.length, parsed, rubrics, gradeInfo });
        summary.mismatches.push(...stored.mismatches);
        summary.attempts++;
      }
    }
    pruneOlderDuplicates(db, { groupId: group.id });
    summary.attempts = db.prepare('SELECT COUNT(*) n FROM quiz_attempts WHERE group_id = ?').get(group.id).n;
    finishLoad(db, { groupId: group.id, summary, mismatches: summary.mismatches });
    return summary;
  } finally {
    loading.delete(group.id);
    await reader?.close();
  }
}
