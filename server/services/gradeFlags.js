// Schoology's grade flags, set and cleared from Prism (#40; spec
// docs/superpowers/specs/2026-10-21-flags-excused-late-design.md, probes in
// .claude/schoology-api-reference.md "Grade exceptions (flags)").
//
// Schoology removes the grade while a flag is set (1, 2, 5, 6 remove the score and blank every
// topic level; 3 Missing sets the score to 0 and keeps the levels; the comment always stays), so
// before any flag Prism keeps a copy of the grade in excused_grades, and clearing the flag can put
// that copy back as the card's draft. The write follows the quizWriteback safety pattern:
//   lock the pair -> resolve it -> eligibility -> fresh read -> refuse if it differs from what the
//   page loaded -> keep the copy (the write goes ahead only once it is stored) -> PUT (the code,
//   every other field echoed from the fresh read, #46) -> read back and confirm -> mirror the
//   read-back into grades -> withdraw Prism's open records (Exempt only) -> the status
//   line -> (clearing) the draft -> release.
// Clearing Missing sends `grade: null` as well, so no 0 is left counting; that also blanks the topic
// levels Missing kept (probe dd0509e), so the copy takes them first, like a flag that removes them.
// Those levels are read fresh from Schoology (readPairLevels): Prism's local mastery_scores can be
// stale (levels entered in Schoology since Prism last read them). A failed read writes nothing. The
// read-back must then show no score, or the clear is reported as not confirmed.
// A gateway error (non-2xx, or a per-entry response_code of 400+) means Schoology wrote nothing:
// nothing in Prism changes and it is never retried here (one transient 502 was seen in the probes).
import { getSectionGrades, pushGradeUpdates } from './schoology.js';
import {
  lockPair, pairTarget, freshGrade, putSucceeded, publishStatusLine, removeStatusLine, checkLine,
} from './statusLinePublisher.js';
import { TriageError } from './triageCommon.js';
import { FLAG_CODES, FLAG_NAMES, isExempt, removesLevels } from '../lib/flags.js';
import { flagLine } from '../lib/statusLines.js';
import { todayLocal } from '../lib/schoolDays.js';
import { levelForScore } from '../lib/scoreScales.js';
import { levelToPoints } from '../lib/proficiencyScale.js';
import { getAlignedTopics, scoreScaleFor } from './assessmentContext.js';
import { getFeedbackRows, ROW_PREFIX } from './feedbackRows.js';
import { cardBaselineFor } from './unfinishedGrading.js';
import { listExtensions, undoExtension, undoReferral } from './triage.js';
import { listResubmissions, undoResubmission, settleResubmissions } from './resubmissions.js';
import { captureFeedbackSnapshots } from './feedbackSnapshots.js';
import { readPairLevels } from './masterySync.js';
import { gradeSummary, joinParts, scaleForAssignment } from './savedGrades.js';

const SCALE_KEY = '__scale__'; // the card's pending key for a score-scale overall
const num = (v) => (v == null || v === '' ? null : Number(v));
const sameScore = (x, y) => (x == null || y == null ? x == null && y == null : Math.abs(x - y) < 1e-9);
const flagName = (code) => (Number(code) ? FLAG_NAMES[Number(code)] ?? `code ${code}` : 'no flag');
const scoreText = (score) => String(Number(score));
// Comments compare as Prism compares them elsewhere (statusLinePublisher): CRLF as LF, and
// trailing whitespace ignored (Schoology can round-trip either), so an unchanged comment never refuses.
const normalise = (text) => String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
// "Fri 24/10/2026": the panel's dates for withdrawn records.
const fullDate = (iso) => new Date(`${iso}T00:00:00`)
  .toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).replace(',', '');

function validCode(code) {
  const n = typeof code === 'string' && code.trim() !== '' ? Number(code) : code;
  if (typeof n !== 'number' || !Number.isInteger(n) || !(n === 0 || FLAG_CODES.includes(n))) {
    throw new TriageError('BAD_VALUE', `code must be 0 (clear) or a flag code (${FLAG_CODES.join(', ')})`);
  }
  return n;
}

// What the page loaded: { exception, score, comment? }. A comment is compared only when sent.
function checkExpected(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || !('exception' in expected)) {
    throw new TriageError('BAD_VALUE', 'expected { exception, score } is required: the values the page loaded');
  }
  const exception = num(expected.exception) ?? 0;
  const score = num(expected.score);
  if (Number.isNaN(exception) || Number.isNaN(score)) throw new TriageError('BAD_VALUE', 'expected.exception and expected.score must be numbers');
  return { exception, score, comment: typeof expected.comment === 'string' ? expected.comment : undefined };
}

// A current course, a current enrolment and (for an individually assigned task) an assignee.
function assertEligible(db, t) {
  const a = db.prepare(`
    SELECT a.course_id, a.num_assignees, c.archived, c.excluded FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.id = ?
  `).get(t.assignmentId);
  if (a.archived || a.excluded) throw new TriageError('NOT_ELIGIBLE', 'That assignment is not in a current course');
  const st = db.prepare('SELECT schoology_uid FROM students WHERE id = ?').get(t.studentId);
  const enrolled = db.prepare('SELECT 1 FROM enrolments WHERE student_id = ? AND course_id = ? AND dropped_at IS NULL').get(t.studentId, a.course_id);
  const assigned = !(a.num_assignees > 0)
    || db.prepare('SELECT 1 FROM assignment_assignees WHERE assignment_id = ? AND schoology_uid = ?').get(t.assignmentId, st.schoology_uid);
  if (!enrolled || !assigned) throw new TriageError('NOT_ELIGIBLE', 'That assignment does not target that student');
}

const uidOf = (db, t) => db.prepare('SELECT schoology_uid FROM students WHERE id = ?').get(t.studentId).schoology_uid;
const assignmentOf = (db, t) => db.prepare('SELECT * FROM assignments WHERE id = ?').get(t.assignmentId);

// The pair's grade as it stands: the fresh record plus the topic levels (Prism's, or `freshTopics`
// read from Schoology), rubric row levels (Prism-only) and (on a score-scale task) the overall level.
function gradeNow(db, t, fresh, freshTopics = null) {
  const a = assignmentOf(db, t);
  const uid = uidOf(db, t);
  const topics = freshTopics ?? Object.fromEntries(db.prepare(`
    SELECT topic_id, grade FROM mastery_scores WHERE student_uid = ? AND assignment_schoology_id = ? AND grade IS NOT NULL ORDER BY topic_id
  `).all(uid, String(a.schoology_assignment_id)).map((r) => [r.topic_id, r.grade]));
  const rows = Object.fromEntries(db.prepare(`
    SELECT criterion_name, level FROM rubric_row_levels WHERE student_uid = ? AND assignment_schoology_id = ? ORDER BY criterion_name
  `).all(uid, String(a.schoology_assignment_id)).map((r) => [r.criterion_name, r.level]));
  const scale = scoreScaleFor(a, getAlignedTopics(db, a.course_id, a.schoology_assignment_id).length);
  const score = num(fresh?.grade);
  return {
    score, max_points: num(fresh?.max_points), comment: fresh?.comment ?? '', comment_status: fresh?.comment_status ?? null,
    topics, rows, scale_level: scale ? levelForScore(scale, score) : null,
  };
}
const isGraded = (g) => g.score != null || Object.keys(g.topics).length > 0 || Object.keys(g.rows).length > 0;

const copyOf = (db, t) => db.prepare('SELECT * FROM excused_grades WHERE student_id = ? AND assignment_id = ?').get(t.studentId, t.assignmentId) || null;
const waitingCopy = (db, t) => { const c = copyOf(db, t); return c && c.restored_at == null ? c : null; };

// Keep the copy for a new flag, BEFORE the write. A copy still waiting to be restored is kept only
// while it holds everything the pair has now: each current topic and row level equals the copy's,
// and the current score is none or the copy's (Missing's 0 is the flag's own, not a grade). Parts
// that are empty because a flag blanked them are fine. Anything else (a regrade since, then a flag
// set outside Prism that kept or did not yet blank the levels) means the copy is out of date: the
// current grade replaces it. An ungraded pair with no waiting copy stores nothing.
// → { saved, undo } where undo() puts the previous row back exactly (Schoology wrote nothing).
function holdsAll(saved, now) {
  if (now.score != null && !sameScore(num(saved.score), now.score)) return false;
  const within = (cur, kept) => Object.entries(cur || {}).every(([k, level]) => (kept || {})[k] === level);
  return within(now.topics, saved.topics) && within(now.rows, saved.rows);
}
function keepCopy(db, t, fresh, was, code, freshTopics = null) {
  const existing = copyOf(db, t);
  const waiting = existing && existing.restored_at == null;
  const now = gradeNow(db, t, fresh, freshTopics);
  if (was === 3 && now.score === 0) { now.score = null; now.scale_level = null; } // Missing's zero, not a grade
  const undo = () => {
    if (existing) {
      db.prepare(`INSERT INTO excused_grades (student_id, assignment_id, flag, saved_json, saved_at, restored_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (student_id, assignment_id) DO UPDATE SET flag = excluded.flag, saved_json = excluded.saved_json,
          saved_at = excluded.saved_at, restored_at = excluded.restored_at`)
        .run(existing.student_id, existing.assignment_id, existing.flag, existing.saved_json, existing.saved_at, existing.restored_at);
    } else {
      db.prepare('DELETE FROM excused_grades WHERE student_id = ? AND assignment_id = ?').run(t.studentId, t.assignmentId);
    }
  };
  try {
    if (waiting && holdsAll(JSON.parse(existing.saved_json), now)) {
      db.prepare('UPDATE excused_grades SET flag = ? WHERE student_id = ? AND assignment_id = ?').run(code, t.studentId, t.assignmentId);
      return { saved: true, undo };
    }
    if (!isGraded(now)) return { saved: false, undo };
    db.prepare(`INSERT INTO excused_grades (student_id, assignment_id, flag, saved_json, saved_at, restored_at) VALUES (?, ?, ?, ?, datetime('now'), NULL)
      ON CONFLICT (student_id, assignment_id) DO UPDATE SET flag = excluded.flag, saved_json = excluded.saved_json,
        saved_at = excluded.saved_at, restored_at = NULL`).run(t.studentId, t.assignmentId, code, JSON.stringify(now));
    return { saved: true, undo };
  } catch (err) {
    console.error('[grade flag] could not keep a copy of the grade:', err.message);
    throw new TriageError('SAVE_FAILED', 'Prism could not keep a copy of the grade, so nothing was written to Schoology. Try again.');
  }
}

// Clearing Missing (3 → 0): the write that also removes Missing's 0 (and blanks its levels).
const clearsMissing = (was, code) => was === 3 && code === 0;

async function putFlag(t, fresh, code, was) {
  const payload = {
    assignment_id: t.schoologyAssignmentId,
    enrollment_id: t.enrollmentId,
    comment: fresh?.comment ?? '',
    comment_status: fresh?.comment_status ?? null,
  };
  if (clearsMissing(was, code)) payload.grade = null; // the 0 was Missing's own, not a grade
  else if (fresh && fresh.grade != null) payload.grade = String(fresh.grade);
  payload.exception = code;
  let result;
  try {
    result = await pushGradeUpdates(t.sectionId, [payload]);
  } catch (err) {
    console.error(`[grade flag] PUT failed: ${err.message}`);
    throw new TriageError('SCHOOLOGY_WRITE_FAILED', `Schoology did not accept the flag: nothing was changed (${err.message}). Try again.`);
  }
  if (!putSucceeded(result)) {
    const status = Number(result?.status);
    console.error('[grade flag] PUT rejected:', status, JSON.stringify(result?.data)?.slice(0, 500));
    throw new TriageError('SCHOOLOGY_WRITE_FAILED', `Schoology did not accept the flag (HTTP ${status || '?'}): nothing was changed. Try again.`);
  }
}

async function readBack(t, code) {
  let back;
  try {
    const all = await getSectionGrades(t.sectionId);
    back = (all || []).find((g) => String(g.assignment_id) === t.schoologyAssignmentId && String(g.enrollment_id) === t.enrollmentId) || null;
  } catch (err) {
    console.error(`[grade flag] read-back failed: ${err.message}`);
    throw new TriageError('READBACK_MISMATCH', 'Schoology accepted the flag, but Prism could not read it back, so it has not recorded the change. Check the task in Schoology, then sync.');
  }
  const shown = Number(back?.exception) || 0;
  if (!back || shown !== code) {
    throw Object.assign(new TriageError('READBACK_MISMATCH', `Schoology answered, but its record shows ${back ? flagName(shown) : 'no grade record'}, not ${flagName(code)}: Prism has not recorded the change. Check the task in Schoology, then sync.`), { back });
  }
  return back;
}

// Prism's mirror of the read-back: the score and flag. The topic levels a flag (or clearing Missing)
// blanks go too (as the next mastery read would drop them); the copy holds them.
function mirror(db, t, back, code, was) {
  const a = assignmentOf(db, t);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO grades (student_id, assignment_id, enrolment_id, score, exception, grade_comment, comment_status, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, assignment_id) DO UPDATE SET score = excluded.score, exception = excluded.exception, synced_at = excluded.synced_at
    `).run(t.studentId, t.assignmentId, t.enrollmentId, num(back.grade), Number(back.exception) || 0,
      back.comment ?? '', back.comment_status ?? null, new Date().toISOString());
    if (clearsMissing(was, code)) {
      // grade: null blanked every level of the pair in Schoology (verified), and the copy holds the
      // levels read fresh just before the write: Prism's local ones go, stale ones included.
      db.prepare('DELETE FROM mastery_scores WHERE student_uid = ? AND assignment_schoology_id = ?').run(uidOf(db, t), String(a.schoology_assignment_id));
    } else if (removesLevels(code)) {
      // Only levels the stored copy holds: a level Prism has no other record of is never dropped here.
      const kept = waitingCopy(db, t);
      const held = kept ? JSON.parse(kept.saved_json).topics || {} : {};
      const drop = db.prepare('DELETE FROM mastery_scores WHERE student_uid = ? AND assignment_schoology_id = ? AND topic_id = ? AND grade = ?');
      for (const [topicId, level] of Object.entries(held)) drop.run(uidOf(db, t), String(a.schoology_assignment_id), topicId, level);
    }
  })();
}

// A flag write is a teacher save (#40): the save routes' capture order
// (absorb other writers' state unstamped, mirror, then a stamped save) and settle. Best-effort.
function capture(db, t, phase) {
  try {
    if (phase === 'before') {
      captureFeedbackSnapshots(db, { studentId: t.studentId, assignmentId: t.assignmentId, mode: 'save', stamp: false });
    } else {
      captureFeedbackSnapshots(db, { studentId: t.studentId, assignmentId: t.assignmentId, mode: 'save' });
      settleResubmissions(db, { assignmentId: t.assignmentId });
    }
  } catch (err) {
    console.error('[grade flag] snapshot failed:', err.message);
  }
}

// Prism's open records on the pair, as the panel lists them: an extension (a make-up on a test),
// an open resubmission request, a referral.
function openRecords(db, t) {
  const out = [];
  const isTest = Number(db.prepare('SELECT is_test FROM assignments WHERE id = ?').get(t.assignmentId)?.is_test) === 1;
  const ext = db.prepare('SELECT id FROM extensions WHERE student_id = ? AND assignment_id = ?').get(t.studentId, t.assignmentId);
  if (ext) {
    const until = listExtensions(db, { id: ext.id })[0]?.until;
    const when = until ? fullDate(until) : null;
    out.push({ type: 'extension', id: ext.id, label: isTest ? `Make-up${when ? ` by ${when}` : ''}` : `Extension${when ? ` to ${when}` : ''}` });
  }
  for (const r of db.prepare(`SELECT id FROM resubmissions WHERE student_id = ? AND assignment_id = ? AND kind = 'request' AND status = 'open' ORDER BY id`).all(t.studentId, t.assignmentId)) {
    const until = listResubmissions(db, { id: r.id })[0]?.until;
    out.push({ type: 'resubmission', id: r.id, label: until ? `Resubmission request, due ${fullDate(until)}` : 'Resubmission request' });
  }
  for (const r of db.prepare(`SELECT id FROM referrals WHERE student_id = ? AND assignment_id = ? AND action = 'referred' ORDER BY id`).all(t.studentId, t.assignmentId)) {
    out.push({ type: 'referral', id: r.id, label: 'Referral' });
  }
  return out;
}

const UNDO = { extension: undoExtension, resubmission: undoResubmission, referral: undoReferral };

// What the card can stage from a saved copy, and what it cannot (to re-enter in Schoology): a
// points-only score, or an overall that differs from what the saved levels compute to.
function planRestore(db, a, saved) {
  const topics = getAlignedTopics(db, a.course_id, a.schoology_assignment_id);
  const scale = scoreScaleFor(a, topics.length);
  const pending = {};
  const notRestored = [];
  const score = num(saved.score);
  if (topics.length > 0) {
    const ids = new Map(topics.map((tp) => [String(tp.id), tp]));
    const levels = Object.entries(saved.topics || {});
    for (const [id, level] of levels) {
      if (ids.has(id)) pending[id] = level;
      else notRestored.push(`${db.prepare('SELECT title FROM measurement_topics WHERE id = ?').get(id)?.title ?? id}: ${level}`);
    }
    if (score != null) {
      const points = levels.map(([, l]) => levelToPoints(l)).filter((p) => p != null);
      const computed = points.length ? points.reduce((x, y) => x + y, 0) / points.length : null;
      if (computed == null || Math.abs(computed - score) > 0.01) notRestored.push(scoreText(score));
    }
  } else if (scale) {
    const rowNames = new Set((getFeedbackRows(db, a.schoology_assignment_id, scale)?.rows ?? []).map((r) => r.criterion));
    // Row levels stay in Prism (Schoology never sees them): one no longer on the rubric is still kept.
    for (const [name, level] of Object.entries(saved.rows || {})) if (rowNames.has(name)) pending[`${ROW_PREFIX}${name}`] = level;
    if (score != null) {
      const level = scale.levels.find((l) => l.points === score);
      if (level) pending[SCALE_KEY] = level.code;
      else notRestored.push(scoreText(score));
    }
  } else if (score != null) {
    notRestored.push(scoreText(score));
  }
  return { pending, notRestored };
}

// The saved copy into the card's draft ({ pending, comment, display, displayTouched, base }), with
// the base the card computes now (after the clear and the line removal are mirrored), so the card
// does not discard it as stale. Replaces any draft. Marks the copy restored once a draft is written.
function restoreDraft(db, t, copy) {
  const a = assignmentOf(db, t);
  const { pending, notRestored } = planRestore(db, a, JSON.parse(copy.saved_json));
  try {
    let draft = false;
    db.transaction(() => {
      if (Object.keys(pending).length > 0) {
        const g = db.prepare('SELECT grade_comment, comment_status FROM grades WHERE student_id = ? AND assignment_id = ?').get(t.studentId, t.assignmentId);
        const base = cardBaselineFor(db, a)({ schoology_uid: uidOf(db, t) });
        const body = { pending, comment: g?.grade_comment || '', display: g?.comment_status === 1, displayTouched: false, base };
        db.prepare(`
          INSERT INTO assessment_drafts (assignment_id, student_id, enrolment_id, draft_json, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(assignment_id, student_id) DO UPDATE SET draft_json = excluded.draft_json, enrolment_id = excluded.enrolment_id, updated_at = datetime('now')
        `).run(t.assignmentId, t.studentId, t.enrollmentId, JSON.stringify(body));
        draft = true;
        db.prepare(`UPDATE excused_grades SET restored_at = datetime('now') WHERE student_id = ? AND assignment_id = ?`).run(t.studentId, t.assignmentId);
      }
      // Nothing the card can stage (e.g. a points-only score): the copy stays waiting, so
      // "Restore saved grade" is still offered beside the parts to re-enter in Schoology.
    })();
    return { draft, notRestored };
  } catch (err) {
    console.error('[grade flag] restore failed:', err.message);
    return { draft: false, notRestored, error: 'The flag is cleared, but Prism could not restore the saved grade: use Restore saved grade.' };
  }
}

// What a restore stages, in words ("Exhibiting (75) and 2 rubric row levels", "2 topic levels"),
// for the clear panel's box; null when nothing can be staged.
function stagedSummary(scale, pending) {
  const parts = [];
  const level = pending[SCALE_KEY] ? scale?.levels.find((l) => l.code === pending[SCALE_KEY]) : null;
  if (level) parts.push(`${level.label} (${level.points})`);
  const keys = Object.keys(pending).filter((k) => k !== SCALE_KEY);
  const rows = keys.filter((k) => k.startsWith(ROW_PREFIX)).length;
  const topics = keys.length - rows;
  if (topics) parts.push(`${topics} topic level${topics === 1 ? '' : 's'}`);
  if (rows) parts.push(`${rows} rubric row level${rows === 1 ? '' : 's'}`);
  return parts.length ? joinParts(parts) : null;
}

// A waiting copy (an excused_grades row) as the panels and the card show it: the saved grade, its
// flag and time, what it holds in words (summary), what a restore stages (restoreSummary) and what
// it cannot (notRestored). The card's saved_grade (GET /api/mastery/.../assignment) is this too.
export function savedGradeView(db, assignmentId, copy) {
  if (!copy) return null;
  const saved = JSON.parse(copy.saved_json);
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId);
  const scale = scaleForAssignment(db, a);
  const { pending, notRestored } = planRestore(db, a, saved);
  return {
    ...saved, flag: copy.flag, savedAt: copy.saved_at,
    summary: gradeSummary(scale, saved), restoreSummary: stagedSummary(scale, pending), notRestored,
  };
}
const savedGradeOf = (db, t, copy) => savedGradeView(db, t.assignmentId, copy);

// A new grade was published over a marker (write-comment / send-all, #40): the grade the marker
// removed is no longer the one to restore, so a waiting copy is retired (restored_at set) and
// "Restore saved grade" is no longer offered. → true when a waiting copy was retired.
export function retireCopy(db, { studentId, assignmentId } = {}) {
  return db.prepare(`UPDATE excused_grades SET restored_at = datetime('now') WHERE student_id = ? AND assignment_id = ? AND restored_at IS NULL`)
    .run(Number(studentId), Number(assignmentId)).changes > 0;
}

// The Flags panel's fresh read (no write).
export async function readFlagState(db, { studentId, assignmentId } = {}) {
  const t = pairTarget(db, studentId, assignmentId);
  const fresh = await freshGrade(db, t);
  const exception = Number(fresh?.exception) || 0;
  // The grade a new flag would keep a copy of: Missing's 0 is the flag's own, not a grade (keepCopy).
  const now = gradeNow(db, t, fresh);
  if (exception === 3 && now.score === 0) now.score = null;
  return {
    exception,
    score: num(fresh?.grade),
    comment: fresh?.comment ?? '',
    commentStatus: fresh?.comment_status ?? null,
    graded: isGraded(now),
    gradeText: isGraded(now) ? gradeSummary(scaleForAssignment(db, assignmentOf(db, t)), now) : null,
    savedGrade: savedGradeOf(db, t, waitingCopy(db, t)),
    openRecords: openRecords(db, t),
    hasDraft: Boolean(db.prepare('SELECT 1 FROM assessment_drafts WHERE student_id = ? AND assignment_id = ?').get(t.studentId, t.assignmentId)),
  };
}

// Set (code 1, 2, 3, 5, 6), change or clear (0) the pair's flag. `expected` is what the page
// loaded ({ exception, score }); `reason` the optional line for the student; `restore` (clearing)
// puts a saved copy back as the draft. Clearing with no flag set restores a kept copy, no write.
// → { exception, saved (a copy is waiting), withdrawn, line, restored }.
export async function setGradeFlag(db, { studentId, assignmentId, code, expected, reason = null, restore = true } = {}) {
  const target = validCode(code);
  const want = checkExpected(expected);
  const note = reason == null ? '' : String(reason).trim();
  const lineText = target !== 0 && note ? checkLine(flagLine({ code: target, on: todayLocal(), note })) : null;
  const release = lockPair(studentId, assignmentId);
  try {
    const t = pairTarget(db, studentId, assignmentId);
    assertEligible(db, t);
    const fresh = await freshGrade(db, t);
    const was = Number(fresh?.exception) || 0;
    const score = num(fresh?.grade);
    const changed = [];
    if (was !== want.exception) changed.push(`the flag (now ${flagName(was)})`);
    if (!sameScore(score, want.score)) changed.push(`the score (now ${score == null ? 'none' : scoreText(score)})`);
    if (want.comment !== undefined && normalise(fresh?.comment) !== normalise(want.comment)) changed.push('the comment');
    if (changed.length) {
      throw new TriageError('CHANGED', `Changed in Schoology since Prism last read this task: ${changed.join(', ')}. Nothing was written. Sync, then try again.`);
    }

    if (target === was) {
      const waiting = waitingCopy(db, t);
      if (target === 0 && restore && waiting) {
        return { exception: 0, saved: false, withdrawn: [], line: null, restored: restoreDraft(db, t, waiting) };
      }
      throw new TriageError('NOT_ELIGIBLE', target ? `This task is already flagged ${flagName(target)}` : 'There is no flag to clear on this task');
    }

    // A copy before any flag, and before clearing Missing (its grade: null blanks the levels it
    // kept); the copy stays Missing's (flag 3) when clearing.
    // Clearing Missing blanks Schoology's levels: read them fresh first, so the copy holds them.
    let freshTopics = null;
    if (clearsMissing(was, target)) {
      const a = assignmentOf(db, t);
      const topicIds = getAlignedTopics(db, a.course_id, a.schoology_assignment_id).map((tp) => String(tp.id));
      if (topicIds.length > 0) {
        try {
          freshTopics = await readPairLevels({ sectionId: t.sectionId, studentUid: uidOf(db, t), assignmentId: t.schoologyAssignmentId, topicIds });
        } catch (err) {
          console.error('[grade flag] fresh level read failed:', err.message);
          throw new TriageError('SCHOOLOGY_READ_FAILED', `Prism could not read the topic levels from Schoology, so nothing was written (${err.message}). Clearing Missing removes them, so Prism keeps a copy first. Try again.`);
        }
      }
    }
    let copy = { saved: false, undo: () => {} };
    if (target !== 0 || clearsMissing(was, target)) copy = keepCopy(db, t, fresh, was, target || was, freshTopics);
    try {
      await putFlag(t, fresh, target, was);
    } catch (err) {
      try { copy.undo(); } catch (e) { console.error('[grade flag] could not put the earlier copy back:', e.message); }
      throw err;
    }
    let back;
    try {
      back = await readBack(t, target);
    } catch (err) {
      // The record still reads as before the write (old flag, same score): Schoology wrote nothing,
      // so the copy goes back exactly as on a refused PUT. Any other read-back keeps the copy.
      const b = err.back;
      if (b && (Number(b.exception) || 0) === was && sameScore(num(b.grade), score)) {
        try { copy.undo(); } catch (e) { console.error('[grade flag] could not put the earlier copy back:', e.message); }
      }
      throw err;
    }
    // Clearing Missing must leave no 0 counting: the read-back shows no score, or Prism records nothing
    // (the copy is kept, the local levels stay) and says so.
    if (clearsMissing(was, target) && num(back.grade) != null) {
      throw new TriageError('READBACK_MISMATCH', `Schoology cleared Missing but still shows a score of ${scoreText(back.grade)}: Prism has not recorded the change. Check the task in Schoology, then sync.`);
    }
    // The flag is set: Schoology must not have removed a grade Prism did not keep (anti-goal).
    if (target !== 0 && was === 0 && score != null && !sameScore(num(back.grade), score)) {
      const kept = waitingCopy(db, t);
      if (!kept || !sameScore(num(JSON.parse(kept.saved_json).score), score)) {
        throw new TriageError('READBACK_MISMATCH', `The flag is set, but Schoology removed a grade (${scoreText(score)}) Prism did not keep. Re-enter it in Schoology after clearing the flag.`);
      }
    }

    capture(db, t, 'before');
    try {
      mirror(db, t, back, target, was);
    } catch (err) {
      console.error('[grade flag] mirror failed (the next sync will catch up):', err.message);
    }
    capture(db, t, 'after');

    // Exempt is a decision: the student is not doing the task, so Prism's open records on it close.
    // Absent is only a marker and withdraws nothing.
    let withdrawn = [];
    if (isExempt(target)) {
      const records = openRecords(db, t);
      try {
        db.transaction(() => { for (const r of records) UNDO[r.type](db, r.id); })();
        withdrawn = records;
      } catch (err) {
        console.error('[grade flag] withdrawing records failed:', err.message);
      }
    }

    // The status line: the reason replaces any stored line; without one, a line that belonged to a
    // withdrawn record, or an earlier flag's line, comes off. A failure here leaves the flag set.
    let line = null;
    const stored = db.prepare('SELECT kind, source_type, source_id FROM status_lines WHERE student_id = ? AND assignment_id = ?').get(t.studentId, t.assignmentId);
    try {
      if (lineText) {
        const out = await publishStatusLine(db, { studentId: t.studentId, assignmentId: t.assignmentId, line: lineText, kind: 'flag' });
        line = { published: true, line: out.line };
      } else if (stored && (stored.kind === 'flag' || withdrawn.some((w) => w.type === stored.source_type && w.id === Number(stored.source_id)))) {
        const out = await removeStatusLine(db, { studentId: t.studentId, assignmentId: t.assignmentId });
        line = { removed: out.removed };
      }
    } catch (err) {
      console.error('[grade flag] status line failed after the flag write:', err.message);
      line = { error: `The flag is set, but the line in the comment was not changed: ${err.message}`, code: err.code ?? null };
    }

    let restored = null;
    if (target === 0 && restore) {
      const waiting = waitingCopy(db, t);
      if (waiting) restored = restoreDraft(db, t, waiting);
    }
    return { exception: Number(back.exception) || 0, saved: Boolean(waitingCopy(db, t)), withdrawn, line, restored };
  } finally {
    release();
  }
}
