// Refer with IE and Missing in Schoology (#175). Missing alone gives the topics no evidence when
// the work never arrived (it writes no levels), so a referral of missing work can also write
// Insufficient Evidence on every aligned topic, then set Missing, which keeps those levels: the
// referral then counts in the topic averages (probes in .claude/schoology-api-reference.md
// "Grade exceptions (flags)", 21-22 Oct 2026).
//
// Only for work still missing (late-work kind 'outstanding'): handed-in work is evidence to grade.
// The order follows the quizWriteback safety pattern, under the pair's lock:
//   checks -> fresh record (no score but Missing's 0) -> fresh levels (none) -> (already Missing)
//   clear it -> IE on every topic -> read the levels back (all IE) -> record the referral with its
//   mark -> Missing -> mark it set.
// Writing levels clears Late, Incomplete and Absent (verified); Missing then replaces them. Levels
// are never written over Missing (not probed), so an existing Missing is cleared first (grade:
// null, on a pair with no levels). The referral is recorded once IE is in Schoology, so a failed
// Missing still leaves a record of what was written (mark.missing false) and a warning.
//
// Undo, with the Schoology part: only when Schoology still holds exactly what the referral wrote
// (Missing, its 0, IE on the marked topics and nothing else). Clearing Missing with grade: null
// blanks the levels too (verified), so one flag write removes both. A Missing the teacher had set
// before the referral (mark.wasMissing) is then set again.
import { lockPair, pairTarget, freshGrade } from './statusLinePublisher.js';
import { TriageError } from './triageCommon.js';
import { checkReferral, recordReferral, listReferrals, undoReferral } from './triage.js';
import { setGradeFlagHeld } from './gradeFlags.js';
import { getAlignedTopics } from './assessmentContext.js';
import { writeMasteryScores, readPairLevels } from './masterySync.js';
import { assertSectionWritable } from './courseSections.js';
import { captureFeedbackSnapshots } from './feedbackSnapshots.js';
import { levelToPoints, schoologyScaleId } from '../lib/proficiencyScale.js';
import { todayLocal } from '../lib/schoolDays.js';

const num = (v) => (v == null || v === '' ? null : Number(v));
const topicList = (n) => `${n} topic${n === 1 ? '' : 's'}`;

function readLevels(t, topicIds, uid, step) {
  return readPairLevels({ sectionId: t.sectionId, studentUid: uid, assignmentId: t.schoologyAssignmentId, topicIds })
    .catch((err) => {
      console.error(`[referral] level read failed (${step}): ${err.message}`);
      throw new TriageError('SCHOOLOGY_READ_FAILED', `Prism could not read the topic levels from Schoology (${err.message}). ${step}`);
    });
}

// Prism's mirror of the IE write, as the rubric save mirrors its own (routes/mastery.js).
function mirrorIE(db, t, uid, topicIds) {
  try {
    captureFeedbackSnapshots(db, { studentId: t.studentId, assignmentId: t.assignmentId, mode: 'save', stamp: false });
    const upsert = db.prepare(`
      INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade, synced_at)
      VALUES (?, ?, ?, ?, 'IE', ?)
      ON CONFLICT(student_uid, assignment_schoology_id, topic_id) DO UPDATE SET points = excluded.points, grade = excluded.grade, synced_at = excluded.synced_at
    `);
    const now = new Date().toISOString();
    db.transaction(() => { for (const id of topicIds) upsert.run(uid, t.schoologyAssignmentId, id, levelToPoints('IE'), now); })();
  } catch (err) {
    console.error('[referral] IE mirror failed (the next sync will catch up):', err.message);
  }
}

// Refer a pair, optionally (`schoology`) writing IE and Missing first. Without it, or for work that
// was handed in, this is recordReferral. → the referral (listReferrals shape) plus, when written,
// `schoology` { topics, missing, warning? }.
export async function referPair(db, { studentId, assignmentId, action = 'referred', note = null, source = 'app', schoology = false, today = todayLocal() } = {}) {
  if (!schoology || action !== 'referred') return recordReferral(db, { studentId, assignmentId, action, note, source, today });
  const { row } = checkReferral(db, { studentId, assignmentId, action, today });
  if (row.kind !== 'outstanding') {
    throw new TriageError('NOT_MISSING', 'This work was handed in, so IE and Missing are not written for it: refer it without the Schoology step, then grade the work');
  }
  const release = lockPair(studentId, assignmentId);
  try {
    const t = pairTarget(db, studentId, assignmentId);
    assertSectionWritable(db, t.sectionId);
    const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(t.assignmentId);
    const uid = db.prepare('SELECT schoology_uid FROM students WHERE id = ?').get(t.studentId).schoology_uid;
    const topicIds = getAlignedTopics(db, a.course_id, a.schoology_assignment_id).map((tp) => String(tp.id));
    if (topicIds.length === 0) {
      throw new TriageError('NO_TOPICS', 'Prism has no measurement topics for this task, so it cannot write IE: sync the task, or refer without the Schoology step');
    }

    // Schoology must hold no grade for the work: no score (Missing's own 0 aside) and no levels.
    const fresh = await freshGrade(db, t);
    const was = Number(fresh?.exception) || 0;
    const score = num(fresh?.grade);
    if (was === 1) throw new TriageError('NOT_ELIGIBLE', 'This task is flagged Exempt in Schoology, so it is not referred');
    if (score != null && !(was === 3 && score === 0)) {
      throw new TriageError('CHANGED', `Schoology holds a score for this work (${score}): nothing was written. Sync, then grade it or refer without the Schoology step.`);
    }
    const before = await readLevels(t, topicIds, uid, 'Nothing was written. Try again.');
    if (Object.keys(before).length > 0) {
      throw new TriageError('CHANGED', 'Schoology holds topic levels for this work: nothing was written. Sync, then grade it or refer without the Schoology step.');
    }

    // Already Missing: clear it first (grade: null; there are no levels to lose), so the levels are
    // never written under Missing.
    if (was === 3) {
      await setGradeFlagHeld(db, { studentId: t.studentId, assignmentId: t.assignmentId, code: 0, expected: { exception: 3, score }, restore: false });
    }
    const missingNote = was === 3 ? ' Missing was cleared first, so set it again from the Flags menu.' : '';

    // The grading period and category as the card's rubric save sends them (often none stored:
    // Prism reads them only from tasks that hold levels); the read-back below checks the result.
    const gradeInfo = Object.fromEntries(topicIds.map((id) => [id, { grade: String(levelToPoints('IE')), gradingScaleId: schoologyScaleId() }]));
    try {
      await writeMasteryScores({
        sectionId: t.sectionId, enrollmentId: t.enrollmentId, assignmentId: t.schoologyAssignmentId, gradeInfo,
        gradingPeriodId: a.mastery_grading_period_id, gradingCategoryId: a.mastery_grading_category_id,
      });
    } catch (err) {
      console.error(`[referral] IE write failed: ${err.message}`);
      throw new TriageError('SCHOOLOGY_WRITE_FAILED', `Schoology did not accept the IE levels (${err.message}): the referral is not recorded.${missingNote} Try again.`);
    }
    const after = await readLevels(t, topicIds, uid, `IE may be in Schoology, but the referral is not recorded.${missingNote} Check the task in Schoology, then sync.`);
    const missed = topicIds.filter((id) => after[id] !== 'IE');
    if (missed.length) {
      throw new TriageError('READBACK_MISMATCH', `Schoology shows IE on ${topicList(topicIds.length - missed.length)} of ${topicIds.length}: the referral is not recorded.${missingNote} Check the task in Schoology, then sync.`);
    }

    // The referral, with its mark, before the mirror (Prism's IE levels would take the pair off the
    // late-work list the record checks) and before Missing (a flag's saved copy leaves marked IE out).
    const mark = { at: new Date().toISOString(), topics: topicIds, missing: false, ...(was === 3 ? { wasMissing: true } : {}) };
    let referral;
    try {
      referral = recordReferral(db, { studentId: t.studentId, assignmentId: t.assignmentId, action, note, source, today, mark });
    } catch (err) {
      console.error(`[referral] record failed after the IE write: ${err.message}`);
      throw Object.assign(new TriageError('RECORD_FAILED_AFTER_PUBLISH', `IE is in Schoology on every topic, but Prism could not record the referral (${err.message}).${missingNote} Refer again without the Schoology step.`), { published: true });
    }
    mirrorIE(db, t, uid, topicIds);

    let warning = null;
    try {
      const now = await freshGrade(db, t);
      await setGradeFlagHeld(db, {
        studentId: t.studentId, assignmentId: t.assignmentId, code: 3,
        expected: { exception: Number(now?.exception) || 0, score: num(now?.grade) },
      });
      mark.missing = true;
      db.prepare('UPDATE referrals SET schoology_mark = ? WHERE id = ?').run(JSON.stringify(mark), referral.id);
    } catch (err) {
      console.error(`[referral] Missing failed after IE: ${err.message}`);
      warning = `IE is recorded on every topic and the referral is recorded, but Missing was not set (${err.message}). Set it from the Flags menu.`;
    }
    return { ...listReferrals(db, { id: referral.id })[0], schoology: { topics: topicIds.length, missing: mark.missing, ...(warning ? { warning } : {}) } };
  } finally {
    release();
  }
}

// Undo a referral, optionally (`schoology`) clearing the Missing and IE it wrote. Refuses the
// Schoology part, and so the whole undo, when Schoology has changed since: the teacher can then
// undo in Prism only. → { deleted, schoology?: { cleared } }.
export async function undoReferralPair(db, { id, schoology = false } = {}) {
  const r = db.prepare('SELECT * FROM referrals WHERE id = ?').get(Number(id));
  const mark = r?.schoology_mark ? JSON.parse(r.schoology_mark) : null;
  if (!r || !schoology || !mark) return undoReferral(db, id);
  if (!mark.missing) {
    throw new TriageError('NOT_ELIGIBLE', 'This referral wrote IE but not Missing, so Prism cannot clear it in one step: undo in Prism only, then change the levels in Schoology');
  }
  const release = lockPair(r.student_id, r.assignment_id);
  try {
    const t = pairTarget(db, r.student_id, r.assignment_id);
    assertSectionWritable(db, t.sectionId);
    const uid = db.prepare('SELECT schoology_uid FROM students WHERE id = ?').get(t.studentId).schoology_uid;
    const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(t.assignmentId);
    const topicIds = getAlignedTopics(db, a.course_id, a.schoology_assignment_id).map((tp) => String(tp.id));
    const fresh = await freshGrade(db, t);
    const levels = await readLevels(t, [...new Set([...topicIds, ...mark.topics])], uid, 'Nothing was changed. Try again.');
    const marked = new Set(mark.topics);
    const same = (Number(fresh?.exception) || 0) === 3 && num(fresh?.grade) === 0
      && Object.keys(levels).length === marked.size && Object.entries(levels).every(([tid, l]) => marked.has(tid) && l === 'IE');
    if (!same) {
      throw new TriageError('CHANGED', 'Schoology has changed since the referral wrote IE and Missing, so Prism leaves it as it is: nothing was changed. Undo in Prism only, and change the grade in Schoology if needed.');
    }
    await setGradeFlagHeld(db, { studentId: t.studentId, assignmentId: t.assignmentId, code: 0, expected: { exception: 3, score: 0 }, restore: false });
    const left = await readLevels(t, mark.topics, uid, 'Missing is cleared, but Prism could not check the IE levels: the referral is kept. Check the task in Schoology.');
    if (Object.keys(left).length > 0) {
      throw new TriageError('READBACK_MISMATCH', `Missing is cleared, but Schoology still shows ${topicList(Object.keys(left).length)} with a level: the referral is kept. Check the task in Schoology.`);
    }
    // Missing the teacher had set before the referral goes back (on a pair with no levels again).
    if (mark.wasMissing) {
      try {
        await setGradeFlagHeld(db, { studentId: t.studentId, assignmentId: t.assignmentId, code: 3, expected: { exception: 0, score: null } });
      } catch (err) {
        console.error(`[referral] could not set Missing back: ${err.message}`);
        return { ...undoReferral(db, r.id), schoology: { cleared: true, warning: `The referral is undone, but the Missing flag set before it was not put back (${err.message}). Set it from the Flags menu.` } };
      }
    }
    return { ...undoReferral(db, r.id), schoology: { cleared: true } };
  } finally {
    release();
  }
}
