// Phase 2 of triage resubmissions: unsubmit a student's LTI (OneDrive) submission when
// the teacher asks them to resubmit, the way the grader's Unsubmit button does
// (docs/superpowers/specs/2026-10-03-triage-resubmissions-design.md, "Phase 2 — LTI
// unsubmit on Ask"; the call is VERIFIED 2026-10-03 in .claude/schoology-api-reference.md):
//
//   POST {SCHOOLOGY_BASE}/iapi2/assignments/{aid}/submission-action/{uid}  {"isSubmit":false}
//   headers X-Csrf-Token / X-Csrf-Key from Drupal.settings.s_common on /assignments/{aid}/info
//   200 {"data":[]} → then the student must show in in-progress-documents.
//   (Sent from a browser page until #141; now plain HTTP, verified live 2026-10-19.)
//
// The grade, comment and REST grade timestamp are untouched. Prism NEVER sends
// {"isSubmit":true}: a teacher re-submit re-stamps the work as submitted now (late) and
// the original date can't be restored — so there is no re-submit, and Undo of an ask
// leaves the work unsubmitted.
//
// Runs inside the triage act() sequence (server/services/triageActions.js), so the
// per-pair lock is already held. Plain HTTP with the saved session's cookies, no browser
// (#141; schoologyWeb.js). A session Schoology sends to sign-in is renewed once through
// Microsoft (schoologyWeb.getResource); when that fails the unsubmit fails with
// SCHOOLOGY_SESSION and the teacher reconnects in Settings.
import { SCHOOLOGY_BASE } from '../lib/browserSession.js';
import { TriageError } from './triageCommon.js';
import { sessionDeps, noteSessionLive } from './schoologySession.js';
import { getPage, getJson, postJson, drupalSettings } from './schoologyWeb.js';

const SESSION_MESSAGE = 'Schoology connection expired: reconnect in Settings';
const VERIFY_ATTEMPTS = 3;
const VERIFY_WAIT_MS = 1500;
const FETCH_TIMEOUT_MS = 20000; // each request (the page, the POST, each verification read)

// The assignment page whose grader has Schoology's own Unsubmit button — the fallback
// link when Prism's unsubmit fails. Its Drupal.settings carry the CSRF pair.
export const unsubmitUrl = (schoologyAssignmentId) => `${SCHOOLOGY_BASE}/assignments/${schoologyAssignmentId}/info`;

// Whether Prism offers to unsubmit this pair: OneDrive/LTI work Prism last saw submitted.
export const canUnsubmit = ({ isLti, ltiState }) => Number(isLti) === 1 && ltiState === 'submitted';

function target(db, studentId, assignmentId) {
  return db.prepare(`
    SELECT s.id AS student_id, s.schoology_uid, a.id AS assignment_id, a.schoology_assignment_id,
           a.is_lti_submission, g.lti_submission_state
    FROM students s JOIN assignments a ON a.id = ?
    LEFT JOIN grades g ON g.student_id = s.id AND g.assignment_id = a.id
    WHERE s.id = ?
  `).get(Number(assignmentId), Number(studentId)) || null;
}

// Does Prism offer the unsubmit for this pair? (false for unknown ids.)
export function unsubmitAvailable(db, { studentId, assignmentId }) {
  const t = target(db, studentId, assignmentId);
  return Boolean(t) && canUnsubmit({ isLti: t.is_lti_submission, ltiState: t.lti_submission_state });
}

// Validation (no request): LTI work, currently submitted, with the Schoology ids.
// → { studentId, assignmentId, uid, schoologyAssignmentId, url }
export function assertCanUnsubmit(db, { studentId, assignmentId }) {
  const t = target(db, studentId, assignmentId);
  if (!t) throw new TriageError('NOT_FOUND', `No student ${studentId} / assignment ${assignmentId}`);
  if (Number(t.is_lti_submission) !== 1) {
    throw new TriageError('NOT_ELIGIBLE', 'Only OneDrive (LTI) work can be unsubmitted from Prism');
  }
  if (t.lti_submission_state !== 'submitted') {
    throw new TriageError('NOT_ELIGIBLE', 'Their work is not submitted in Schoology (as of the last sync): there is nothing to unsubmit');
  }
  if (!t.schoology_uid || !t.schoology_assignment_id) {
    throw new TriageError('NOT_ELIGIBLE', 'Prism has no Schoology ids for that student or assignment: sync first');
  }
  return {
    studentId: t.student_id, assignmentId: t.assignment_id,
    uid: String(t.schoology_uid), schoologyAssignmentId: String(t.schoology_assignment_id),
    url: unsubmitUrl(t.schoology_assignment_id),
  };
}

// The verified body, fixed here and never a parameter, so this can only ever unsubmit.
const UNSUBMIT_BODY = Object.freeze({ isSubmit: false });

// Known NOT done: the POST was never sent, or Schoology rejected it (4xx).
const fail = (message) => new TriageError('SCHOOLOGY_WRITE_FAILED', message);
// Unknown: the POST went out but nothing confirmed it worked (a timeout, a 5xx, an
// unexpected answer, or the student not showing as in progress) — their work MAY still
// be submitted. The message prefix is how a stored unsubmit_error is read back as uncertain.
export const UNCONFIRMED_PREFIX = 'Schoology didn\'t confirm the unsubmit';
export const isUncertainUnsubmitError = (error) => String(error ?? '').startsWith(UNCONFIRMED_PREFIX);
const unconfirmed = (detail) => new TriageError('SCHOOLOGY_UNCONFIRMED', `${UNCONFIRMED_PREFIX}: ${detail}`);
const expired = (message) => {
  noteSessionLive('expired', message);
  return new TriageError('SCHOOLOGY_SESSION', SESSION_MESSAGE);
};

// Unsubmit one student's LTI work. → { unsubmitted: true }. Throws TriageError:
// NOT_FOUND / NOT_ELIGIBLE (before any request), SCHOOLOGY_SESSION (no saved or a dead
// session), SCHOOLOGY_WRITE_FAILED (known not done: not sent, or rejected),
// SCHOOLOGY_UNCONFIRMED (sent, but not confirmed — may or may not have worked).
// `jar` (null = no saved session) and `fetchImpl` default to sessionDeps; `wait` is the
// pause between verification reads.
export async function unsubmitLti(db, { studentId, assignmentId }, opts = {}) {
  const t = assertCanUnsubmit(db, { studentId, assignmentId });
  const jar = 'jar' in opts ? opts.jar : sessionDeps.openJar();
  const fetchImpl = opts.fetchImpl || sessionDeps.fetch;
  const pause = opts.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const io = { fetchImpl, timeoutMs: FETCH_TIMEOUT_MS };
  if (!jar) throw new TriageError('SCHOOLOGY_SESSION', SESSION_MESSAGE);

  let csrf;
  try {
    const { html } = await getPage(jar, `/assignments/${t.schoologyAssignmentId}/info`, io);
    csrf = drupalSettings(html)?.s_common;
  } catch (err) {
    if (err.code === 'SESSION_EXPIRED') throw expired('An unsubmit was sent to the login page');
    throw fail(`Could not open the assignment page in Schoology (${err.message}): nothing was unsubmitted`);
  }
  noteSessionLive('connected');
  if (!csrf?.csrf_token || !csrf?.csrf_key) throw fail('Could not read Schoology\'s security token on the assignment page: nothing was unsubmitted');

  let res;
  try {
    res = await postJson(jar, `/iapi2/assignments/${t.schoologyAssignmentId}/submission-action/${t.uid}`, UNSUBMIT_BODY, { csrf, ...io });
  } catch (err) {
    // Sent to sign-in: Schoology did not take the write.
    if (err.code === 'SESSION_EXPIRED') throw expired('An unsubmit was sent to the login page');
    throw unconfirmed(`no answer (${err.message})`);
  }
  if (res.status >= 400 && res.status < 500) {
    console.warn(`[lti unsubmit] ${t.studentId}:${t.assignmentId} rejected: HTTP ${res.status} ${JSON.stringify(res.json)?.slice(0, 200)}`);
    throw fail(`Schoology refused the unsubmit (HTTP ${res.status})`);
  }
  if (res.status !== 200 || !Array.isArray(res.json?.data)) {
    console.warn(`[lti unsubmit] ${t.studentId}:${t.assignmentId} unexpected answer: HTTP ${res.status}`);
    throw unconfirmed(`unexpected answer (HTTP ${res.status})`);
  }

  // Confirm: the student must now be in the grader's in-progress list.
  const listPath = `/iapi2/assignments/${t.schoologyAssignmentId}/in-progress-documents/`;
  let confirmed = false;
  for (let i = 0; i < VERIFY_ATTEMPTS && !confirmed; i++) {
    if (i > 0) await pause(VERIFY_WAIT_MS);
    const list = await getJson(jar, listPath, io).catch(() => null);
    const ids = list?.status === 200 && Array.isArray(list.json?.data) ? list.json.data.map((d) => String(d?.id)) : [];
    confirmed = ids.includes(t.uid);
  }
  if (!confirmed) throw unconfirmed('the student does not show as in progress yet');
  db.prepare(`UPDATE grades SET lti_submission_state = 'in_progress' WHERE student_id = ? AND assignment_id = ?`).run(t.studentId, t.assignmentId);
  db.prepare(`UPDATE resubmissions SET unsubmit_error = NULL WHERE student_id = ? AND assignment_id = ? AND unsubmit_error IS NOT NULL`)
    .run(t.studentId, t.assignmentId);
  return { unsubmitted: true };
}

// The act() step: never throws. → { ok: true } | { ok: false, error, code, uncertain, url }.
// uncertain = the POST went out unconfirmed: their work may or may not still be submitted.
export async function tryUnsubmitLti(db, { studentId, assignmentId }, opts) {
  try {
    await unsubmitLti(db, { studentId, assignmentId }, opts);
    return { ok: true };
  } catch (err) {
    const known = err instanceof TriageError;
    if (!known) console.error('[lti unsubmit] failed:', err);
    const a = db.prepare('SELECT schoology_assignment_id FROM assignments WHERE id = ?').get(Number(assignmentId));
    // An unexpected throw can't say whether the POST went out — treat it as unconfirmed.
    const error = known ? err.message : `${UNCONFIRMED_PREFIX}: ${err.message}`;
    return {
      ok: false,
      error,
      code: known ? err.code : 'SCHOOLOGY_UNCONFIRMED',
      uncertain: isUncertainUnsubmitError(error),
      url: a ? unsubmitUrl(a.schoology_assignment_id) : null,
    };
  }
}
