import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => { process.env.DB_PATH = ':memory:'; });

import { getDb } from '../db/index.js';
import { fingerprint } from '../lib/feedbackFingerprint.js';
import { currentFingerprints, captureFeedbackSnapshots, snapshotMap, EMPTY_FINGERPRINT, seedFeedbackSnapshotsIfEmpty } from './feedbackSnapshots.js';
import { resubmissionStateFromSnapshot, PART_LEVELS } from '../lib/resubmission.js';

let db, courseId, course2;
function student(uid) {
  return db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'F', 'L')`).run(uid).lastInsertRowid;
}
function assignment(sid, cId = courseId) {
  return db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, published) VALUES (?, ?, 'T', 1)`).run(cId, sid).lastInsertRowid;
}
function grade(studentId, assignmentId, cols) {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO grades (student_id, assignment_id, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(studentId, assignmentId, ...keys.map((k) => cols[k]));
}
const setGrade = (studentId, assignmentId, cols) => {
  const keys = Object.keys(cols);
  db.prepare(`UPDATE grades SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE student_id = ? AND assignment_id = ?`)
    .run(...keys.map((k) => cols[k]), studentId, assignmentId);
};
const snap = (s, a) => db.prepare('SELECT * FROM feedback_snapshots WHERE student_id = ? AND assignment_id = ?').get(s, a);

beforeEach(() => {
  db = getDb();
  db.exec('DELETE FROM feedback_snapshots; DELETE FROM status_lines; DELETE FROM resubmissions; DELETE FROM mastery_scores; DELETE FROM measurement_topics; DELETE FROM reporting_categories; DELETE FROM grades; DELETE FROM enrolments; DELETE FROM assignments; DELETE FROM students; DELETE FROM courses;');
  courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-1', 'AIML')`).run().lastInsertRowid;
  course2 = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('sec-2', 'CSP')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO reporting_categories (id, course_id, external_id, title) VALUES ('cat-1', ?, 'X', 'Cat')`).run(courseId);
  db.prepare(`INSERT INTO measurement_topics (id, category_id, course_id, external_id, title) VALUES ('t1', 'cat-1', ?, 'X.1', 'T1'), ('t2', 'cat-1', ?, 'X.2', 'T2')`).run(courseId, courseId);
});

describe('currentFingerprints', () => {
  test('score, exception, sorted rubric levels, visible comment minus the stored status line', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, exception: 0, grade_comment: 'Resubmission requested - due Thu 15/10.\n\nGood work', comment_status: 1, submitted_at: 100, latest_revision_at: 50 });
    db.prepare(`INSERT INTO status_lines (student_id, assignment_id, line, kind) VALUES (?, ?, 'Resubmission requested - due Thu 15/10.', 'ask')`).run(s, a);
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'a1', 't2', 75, 'EX'), ('u1', 'a1', 't1', 50, 'D')`).run();
    const cur = currentFingerprints(db, { assignmentId: a }).get(`${s}:${a}`);
    expect(cur.fingerprint).toBe(fingerprint({ score: 80, comment: 'Good work', commentStatus: 1, levels: [{ topic_id: 't1', grade: 'D' }, { topic_id: 't2', grade: 'EX' }] }));
    expect(cur.latestRevisionAt).toBe(50);
    expect(cur.grade).toMatchObject({ score: 80, submitted_at: 100 });
  });

  test('a hidden comment is not part of the fingerprint', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: null, grade_comment: 'note to self', comment_status: null });
    expect(currentFingerprints(db, {}).get(`${s}:${a}`).fingerprint).toBe(EMPTY_FINGERPRINT);
  });

  test('scoped by assignmentId / courseId / studentId', () => {
    const s = student('u1'); const s2 = student('u2'); const a = assignment('a1'); const b = assignment('b1', course2);
    grade(s, a, { score: 1 }); grade(s2, a, { score: 2 }); grade(s, b, { score: 3 });
    expect([...currentFingerprints(db, { assignmentId: a }).keys()].sort()).toEqual([`${s}:${a}`, `${s2}:${a}`].sort());
    expect([...currentFingerprints(db, { courseId: course2 }).keys()]).toEqual([`${s}:${b}`]);
    expect([...currentFingerprints(db, { studentId: s2 }).keys()]).toEqual([`${s2}:${a}`]);
  });
});

describe('captureFeedbackSnapshots', () => {
  test('first capture: a plain snapshot for a pair not resubmitted', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, comment_status: 1, grade_comment: 'ok', submitted_at: 200, latest_revision_at: 100 });
    expect(captureFeedbackSnapshots(db)).toEqual({ arrivals: 0 });
    expect(snap(s, a)).toMatchObject({ revision_at: 100, arrival_revision_at: 0, arrival_baseline: null });
    expect(snap(s, a).fingerprint).toBe(currentFingerprints(db, {}).get(`${s}:${a}`).fingerprint);
  });

  test('Review Focus 5 (first deploy): resubmitted + visible feedback → an arrival with baseline = the current fingerprint', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, comment_status: 1, grade_comment: 'ok', submitted_at: 100, latest_revision_at: 200 });
    expect(captureFeedbackSnapshots(db)).toEqual({ arrivals: 1 });
    const row = snap(s, a);
    expect(row).toMatchObject({ revision_at: 200, arrival_revision_at: 200 });
    expect(row.arrival_baseline).toBe(row.fingerprint);
  });

  test('Review Focus 5: newer revision but only a hidden comment (no visible feedback) → no arrival', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: null, comment_status: null, grade_comment: 'hidden note', submitted_at: 100, latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    expect(snap(s, a)).toMatchObject({ arrival_revision_at: 0, arrival_baseline: null });
  });

  test('a newer revision records an arrival whose baseline is the previous snapshot fingerprint', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, comment_status: 1, grade_comment: 'v1', submitted_at: 200, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    const before = snap(s, a).fingerprint;
    // Between syncs: the student resubmits AND the teacher changes the visible comment.
    setGrade(s, a, { latest_revision_at: 300, grade_comment: 'v2', submitted_at: 400 });
    expect(captureFeedbackSnapshots(db)).toEqual({ arrivals: 1 });
    const row = snap(s, a);
    expect(row).toMatchObject({ revision_at: 300, arrival_revision_at: 300, arrival_baseline: before });
    expect(row.fingerprint).not.toBe(before);
  });

  test('feedback changes without a new revision keep the arrival; an unchanged pair is not rewritten', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, comment_status: 1, grade_comment: 'v1', submitted_at: 100, latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    const baseline = snap(s, a).arrival_baseline;
    db.prepare(`UPDATE feedback_snapshots SET updated_at = '2000-01-01 00:00:00'`).run();
    expect(captureFeedbackSnapshots(db)).toEqual({ arrivals: 0 });
    expect(snap(s, a).updated_at).toBe('2000-01-01 00:00:00');
    setGrade(s, a, { score: 90 });
    captureFeedbackSnapshots(db);
    expect(snap(s, a)).toMatchObject({ arrival_revision_at: 200, arrival_baseline: baseline });
    expect(snap(s, a).fingerprint).not.toBe(baseline);
    expect(snap(s, a).updated_at).not.toBe('2000-01-01 00:00:00');
  });

  test('first capture of a pair whose first revision came after an open ask → an arrival with an empty baseline', () => {
    const s = student('u1'); const a = assignment('a1');
    db.prepare(`INSERT INTO resubmissions (student_id, assignment_id, course_id, kind, status, requested_at, lessons) VALUES (?, ?, ?, 'request', 'open', '1970-01-01 00:01:40', 3)`).run(s, a, courseId); // epoch 100
    grade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    expect(snap(s, a)).toMatchObject({ arrival_revision_at: 200, arrival_baseline: EMPTY_FINGERPRINT });
  });

  test('scoped capture only touches that assignment; snapshotMap reads them back', () => {
    const s = student('u1'); const a = assignment('a1'); const b = assignment('b1', course2);
    grade(s, a, { score: 1 }); grade(s, b, { score: 2 });
    captureFeedbackSnapshots(db, { assignmentId: a });
    expect(snap(s, b)).toBeUndefined();
    expect([...snapshotMap(db, {}).keys()]).toEqual([`${s}:${a}`]);
    captureFeedbackSnapshots(db, { courseId: course2 });
    expect([...snapshotMap(db, { courseId: course2 }).keys()]).toEqual([`${s}:${b}`]);
    expect(snapshotMap(db, { studentId: s }).size).toBe(2);
  });
});

// Fix round 1. Prism saves capture with mode 'save' (stamping fingerprint_at); syncs and
// mastery pulls with mode 'sync' (also storing synced_fingerprint). A new revision R takes
// as baseline the feedback that predates it.
describe('captureFeedbackSnapshots — baseline predates the resubmission (I1)', () => {
  const stateOf = (s, a) => {
    const cur = currentFingerprints(db, {}).get(`${s}:${a}`);
    return resubmissionStateFromSnapshot({ snapshot: snap(s, a), currentFingerprint: cur.fingerprint, gradedAt: Number(cur.grade.submitted_at) || 0, lti: Number(cur.grade.is_lti_submission) === 1 });
  };

  test('save mode stamps fingerprint_at only when the fingerprint changed; sync mode stores synced_fingerprint', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    const fp0 = snap(s, a).fingerprint;
    expect(snap(s, a)).toMatchObject({ synced_fingerprint: fp0, fingerprint_at: 0 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 500 });
    expect(snap(s, a).fingerprint_at).toBe(0);                     // nothing changed
    setGrade(s, a, { score: 90 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 500 });
    expect(snap(s, a)).toMatchObject({ synced_fingerprint: fp0, fingerprint_at: 500 });
    expect(snap(s, a).fingerprint).not.toBe(fp0);
    captureFeedbackSnapshots(db);                                   // no new revision: the stamp stays (round 2)
    expect(snap(s, a)).toMatchObject({ synced_fingerprint: fp0, fingerprint_at: 500 });
    setGrade(s, a, { latest_revision_at: 600 });                    // a capture that judges a revision resets it
    captureFeedbackSnapshots(db);
    expect(snap(s, a)).toMatchObject({ synced_fingerprint: snap(s, a).fingerprint, fingerprint_at: 0 });
  });

  test('(a) sync fp0 → resubmit R → Prism regrade after R → sync: acknowledged (baseline = fp0)', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    const fp0 = snap(s, a).fingerprint;
    // R = 200 happens in Schoology (Prism has not synced it yet); the teacher regrades in Prism at 300.
    setGrade(s, a, { score: 90, submitted_at: 300 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 300 });
    setGrade(s, a, { latest_revision_at: 200 });                    // the sync pulls R
    expect(captureFeedbackSnapshots(db)).toEqual({ arrivals: 1 });
    expect(snap(s, a)).toMatchObject({ arrival_revision_at: 200, arrival_baseline: fp0 });
    expect(stateOf(s, a)).toBe(null);
  });

  test('(b) sync fp0 → Prism save fp1 before R → resubmit R → sync: arrived with baseline fp1', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { score: 90, submitted_at: 150 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 150 });
    const fp1 = snap(s, a).fingerprint;
    setGrade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    expect(snap(s, a)).toMatchObject({ arrival_revision_at: 200, arrival_baseline: fp1 });
    expect(stateOf(s, a)).toBe('arrived');
  });

  test('round 2: a mastery pull with no new revision keeps the save stamp — sync fp0 → R → Prism regrade → pull → sync sees R → acknowledged', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    const fp0 = snap(s, a).fingerprint;
    setGrade(s, a, { score: 90, submitted_at: 300 });                // Prism regrade at 300 (R = 200 not synced yet)
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 300 });
    captureFeedbackSnapshots(db, { courseId });                      // assessment-page refresh / mastery pull
    expect(snap(s, a)).toMatchObject({ fingerprint_at: 300, synced_fingerprint: fp0 });
    setGrade(s, a, { latest_revision_at: 200 });                     // the Schoology sync sees R
    captureFeedbackSnapshots(db);
    expect(snap(s, a)).toMatchObject({ arrival_revision_at: 200, arrival_baseline: fp0 });
    expect(snap(s, a).synced_fingerprint).toBe(snap(s, a).fingerprint); // what this sync saw
    expect(stateOf(s, a)).toBe(null);
    captureFeedbackSnapshots(db);                                     // later syncs: still acknowledged
    expect(stateOf(s, a)).toBe(null);
    setGrade(s, a, { latest_revision_at: 400 });                     // a newer resubmission after the save
    captureFeedbackSnapshots(db);
    expect(snap(s, a).arrival_baseline).toBe(snap(s, a).fingerprint);  // judged against the regrade
    expect(stateOf(s, a)).toBe('arrived');
  });

  test('R2: R (unsynced) → Prism rubric-only save after R → sync: acknowledged (the save stamp is the write after R)', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    // R = 200 in Schoology (unsynced). The teacher sets rubric levels in Prism at 300 (/write):
    // the levels change, grades.submitted_at does not.
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'a1', 't1', 75, 'EX')`).run();
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 300 });
    setGrade(s, a, { latest_revision_at: 200 });                     // the sync sees R; grade time still 50
    expect(captureFeedbackSnapshots(db)).toEqual({ arrivals: 1 });
    // The save after R is kept on the arrival; the save stamp itself is cleared as before.
    expect(snap(s, a)).toMatchObject({ arrival_parts: PART_LEVELS, fingerprint_at: 0 });
    expect(snap(s, a).synced_fingerprint).toBe(snap(s, a).fingerprint);
    expect(stateOf(s, a)).toBe(null);
  });

  test('R2 (review chain): a Schoology regrade synced after an R2-acknowledged arrival is the next baseline — a later hide-only save does not answer R′', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, grade_comment: 'Note', comment_status: 1, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);                                    // sync: 60 + visible "Note"
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'a1', 't1', 75, 'EX')`).run();
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 300 });   // R = 200 unsynced; rubric-only save at 300
    setGrade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);                                    // sync judges R
    expect(stateOf(s, a)).toBe(null);
    setGrade(s, a, { score: 80, submitted_at: 500 });                // Schoology regrade to 80 at 500 …
    captureFeedbackSnapshots(db);                                    // … synced
    // R′ = 600 unsynced; at 650 the teacher hides the comment in Prism (a stamped save).
    setGrade(s, a, { comment_status: null, submitted_at: 650 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 650 });
    setGrade(s, a, { latest_revision_at: 600 });
    captureFeedbackSnapshots(db);                                    // sync judges R′
    expect(stateOf(s, a)).toBe('arrived');
  });

  test('R2: a stamped Prism save while an arrival is pending records the parts it changed', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 40 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { latest_revision_at: 300 });
    captureFeedbackSnapshots(db);
    expect(snap(s, a)).toMatchObject({ arrival_revision_at: 300, arrival_parts: 0 });
    expect(stateOf(s, a)).toBe('arrived');
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'a1', 't1', 75, 'EX')`).run();
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 400 });   // rubric-only regrade
    expect(snap(s, a)).toMatchObject({ arrival_parts: PART_LEVELS });
    captureFeedbackSnapshots(db);                                    // a later sync keeps it
    expect(snap(s, a)).toMatchObject({ arrival_parts: PART_LEVELS });
    expect(stateOf(s, a)).toBe(null);
  });

  test('R2: a save stamp from before R is still cleared when R is judged (no false answer)', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'a1', 't1', 75, 'EX')`).run();
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 150 });   // rubric save before R
    setGrade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    expect(snap(s, a)).toMatchObject({ fingerprint_at: 0, arrival_parts: 0 });
    expect(stateOf(s, a)).toBe('arrived');
  });

  test('round 2: with no pending save stamp, a sync still refreshes synced_fingerprint', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { score: 85 });                                    // changed in Schoology
    captureFeedbackSnapshots(db);
    expect(snap(s, a)).toMatchObject({ fingerprint_at: 0, synced_fingerprint: snap(s, a).fingerprint });
  });

  test('round 2: a save-mode first capture also sets synced_fingerprint', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 400 });
    expect(snap(s, a)).toMatchObject({ fingerprint_at: 400, synced_fingerprint: snap(s, a).fingerprint });
  });

  test('R1: an unstamped save (status-line publish) updates fingerprint + synced_fingerprint but never stamps', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 100, latest_revision_at: 50 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { score: 70 });                                   // the publish mirrored a fresh Schoology regrade
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', stamp: false, now: 400 });
    const fp70 = currentFingerprints(db, {}).get(`${s}:${a}`).fingerprint;
    expect(snap(s, a)).toMatchObject({ fingerprint: fp70, synced_fingerprint: fp70, fingerprint_at: 0 });
  });

  test('R1: an unstamped save keeps a pending save stamp and its synced_fingerprint', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 100, latest_revision_at: 50 });
    captureFeedbackSnapshots(db);
    const fp0 = snap(s, a).fingerprint;
    setGrade(s, a, { score: 65 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 150 });   // a real Prism save
    setGrade(s, a, { score: 70 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', stamp: false, now: 400 });
    expect(snap(s, a)).toMatchObject({ fingerprint_at: 150, synced_fingerprint: fp0 });
    expect(snap(s, a).fingerprint).toBe(currentFingerprints(db, {}).get(`${s}:${a}`).fingerprint);
  });

  // Round 3 (save log): a single save stamp can't tell Prism saves before R from those
  // after it, and a pending stamp kept synced_fingerprint stale. Each changing Prism save
  // is logged with the fingerprint it replaced; R is judged against the state just
  // before the first logged save after R.
  const levelD = () => db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'a1', 't1', 50, 'D')`).run();
  const setLevel = (g) => db.prepare(`UPDATE mastery_scores SET grade = ? WHERE student_uid = 'u1' AND topic_id = 't1'`).run(g);

  for (const revisionsRead of [undefined, true]) {
    test(`X1: R answered by a Prism rubric save → further syncs → R′ unsynced → Prism hides the comment → sync: arrived (${revisionsRead ? 'revision-read' : 'plain'} syncs)`, () => {
      const s = student('u1'); const a = assignment('a1');
      grade(s, a, { score: 60, grade_comment: 'Note', comment_status: 1, submitted_at: 50, latest_revision_at: 100 });
      levelD();
      captureFeedbackSnapshots(db, { revisionsRead });
      setGrade(s, a, { latest_revision_at: 200 });
      captureFeedbackSnapshots(db, { revisionsRead });                 // R = 200 arrives
      expect(stateOf(s, a)).toBe('arrived');
      setLevel('EX');
      captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 300 });   // rubric save answers it
      expect(stateOf(s, a)).toBe(null);
      captureFeedbackSnapshots(db, { revisionsRead });
      captureFeedbackSnapshots(db, { courseId });                      // a mastery pull
      captureFeedbackSnapshots(db, { revisionsRead });
      setGrade(s, a, { comment_status: null, submitted_at: 650 });     // R′ = 600 unsynced; hide at 650
      captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 650 });
      setGrade(s, a, { latest_revision_at: 600 });
      captureFeedbackSnapshots(db, { revisionsRead });
      expect(stateOf(s, a)).toBe('arrived');
    });
  }

  test('X2: same with a score save at 300 → arrived', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, grade_comment: 'Note', comment_status: 1, submitted_at: 50, latest_revision_at: 100 });
    levelD();
    captureFeedbackSnapshots(db);
    setGrade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { score: 70, submitted_at: 300 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 300 });
    expect(stateOf(s, a)).toBe(null);
    captureFeedbackSnapshots(db);
    captureFeedbackSnapshots(db);
    setGrade(s, a, { comment_status: null, submitted_at: 650 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 650 });
    setGrade(s, a, { latest_revision_at: 600 });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe('arrived');
  });

  test('X6: Prism save before R → R → hide-only Prism save after R → sync: arrived', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, grade_comment: 'Note', comment_status: 1, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { score: 70, submitted_at: 150 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 150 });   // before R
    setGrade(s, a, { comment_status: null, submitted_at: 300 });               // R = 200 unsynced; hide at 300
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 300 });
    setGrade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe('arrived');
  });

  // Round 4: a changed part of the feedback answers R only with evidence after R for THAT
  // part — rubric levels: a Prism save after R that changed levels (a mastery pull never
  // answers on its own); score/exception and the visible comment: a Prism save after R
  // that changed them, or a Schoology grade write after R (submitted_at > R).
  test('S1: Schoology rubric regrade before R (unpulled) → sync judges R → pull → Prism hide-only save → arrived', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, grade_comment: 'Note', comment_status: 1, submitted_at: 50, latest_revision_at: 100 });
    levelD();
    captureFeedbackSnapshots(db);
    setGrade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);                                    // C1: baseline = current (stale level D)
    setLevel('EX');
    captureFeedbackSnapshots(db, { courseId });                      // the pull brings the pre-R level
    expect(stateOf(s, a)).toBe('arrived');
    setGrade(s, a, { comment_status: null, submitted_at: 300 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 300 });   // hide-only
    expect(stateOf(s, a)).toBe('arrived');
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe('arrived');
  });

  test('S2: Schoology rubric regrade before R → R (unsynced) → Prism hide-only save → pull → sync: arrived', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, grade_comment: 'Note', comment_status: 1, submitted_at: 50, latest_revision_at: 100 });
    levelD();
    captureFeedbackSnapshots(db);
    setGrade(s, a, { comment_status: null, submitted_at: 300 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 300 });
    setLevel('EX');
    captureFeedbackSnapshots(db, { courseId });
    setGrade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe('arrived');
  });

  test('round 4: a Prism rubric-only save after a synced R answers it', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 100 });
    levelD();
    captureFeedbackSnapshots(db);
    setGrade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe('arrived');
    setLevel('EX');
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 300 });
    expect(stateOf(s, a)).toBe(null);
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe(null);
  });

  test('round 4: a Schoology score regrade after R answers it; a Schoology rubric-only regrade after R stays arrived (safe direction)', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 100 });
    levelD();
    captureFeedbackSnapshots(db);
    setGrade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    setLevel('EX'); setGrade(s, a, { submitted_at: 300 });           // rubric regrade in Schoology after R
    captureFeedbackSnapshots(db, { courseId });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe('arrived');
    setGrade(s, a, { score: 70, submitted_at: 400 });                // score regrade in Schoology after R
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe(null);
  });

  // An lti revision time has no seconds: a Prism save within the minute after R may
  // predate the real submission, so it is not "after R".
  for (const [at, expected] of [[230, 'arrived'], [259, 'arrived'], [260, null]]) {
    test(`lti minute precision: R = 200, a Prism rubric save at ${at} (unsynced R) → sync: ${expected ?? 'answered'}`, () => {
      const s = student('u1'); const a = assignment('a1');
      db.prepare('UPDATE assignments SET is_lti_submission = 1 WHERE id = ?').run(a);
      grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 100 });
      levelD();
      captureFeedbackSnapshots(db);
      setLevel('EX');
      captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: at });
      setGrade(s, a, { latest_revision_at: 200 });
      captureFeedbackSnapshots(db);
      expect(stateOf(s, a)).toBe(expected);
    });
  }

  test('lti minute precision: a save while the arrival is pending counts only from R + 60; native work from R + 1', () => {
    for (const [lti, at, expected] of [[1, 250, 'arrived'], [1, 260, null], [0, 201, null]]) {
      db.exec('DELETE FROM feedback_snapshots; DELETE FROM mastery_scores; DELETE FROM grades; DELETE FROM assignments; DELETE FROM students;');
      const s = student('u1'); const a = assignment('a1');
      db.prepare('UPDATE assignments SET is_lti_submission = ? WHERE id = ?').run(lti, a);
      grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 100 });
      levelD();
      captureFeedbackSnapshots(db);
      setGrade(s, a, { latest_revision_at: 200 });
      captureFeedbackSnapshots(db);
      setLevel('EX');
      captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: at });
      expect([lti, at, stateOf(s, a)]).toEqual([lti, at, expected]);
    }
  });

  // The same minute rule for a Schoology grade write (grades.submitted_at) on lti work:
  // within R's minute it may precede the real submission — not after R, and (C1) at or
  // before R + 59 counts as before it.
  for (const [at, expected] of [[230, 'arrived'], [260, null]]) {
    test(`lti minute precision: synced R = 200, a Schoology score regrade at ${at} → ${expected ?? 'answered'}`, () => {
      const s = student('u1'); const a = assignment('a1');
      db.prepare('UPDATE assignments SET is_lti_submission = 1 WHERE id = ?').run(a);
      grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 100 });
      captureFeedbackSnapshots(db);
      setGrade(s, a, { latest_revision_at: 200 });
      captureFeedbackSnapshots(db);
      setGrade(s, a, { score: 70, submitted_at: at });
      captureFeedbackSnapshots(db);
      expect(stateOf(s, a)).toBe(expected);
    });

    test(`lti minute precision (C1): Schoology score regrade at ${at}, R = 200 unsynced → sync: ${expected ?? 'answered'}`, () => {
      const s = student('u1'); const a = assignment('a1');
      db.prepare('UPDATE assignments SET is_lti_submission = 1 WHERE id = ?').run(a);
      grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 100 });
      captureFeedbackSnapshots(db);
      const fp60 = snap(s, a).fingerprint;
      setGrade(s, a, { score: 70, submitted_at: at, latest_revision_at: 200 });
      captureFeedbackSnapshots(db);
      expect(snap(s, a).arrival_baseline).toBe(expected === 'arrived' ? snap(s, a).fingerprint : fp60);
      expect(stateOf(s, a)).toBe(expected);
    });
  }

  test('native work keeps the exact comparison: a grade write at R + 1 is after R', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { score: 70, submitted_at: 201, latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe(null);
  });

  test('save log: each changing Prism save is logged with the fingerprint it replaced; unchanged saves and publishes are not', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    const fp0 = snap(s, a).fingerprint;
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 150 });   // unchanged
    expect(JSON.parse(snap(s, a).save_log || '[]')).toEqual([]);
    setGrade(s, a, { score: 70 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 200 });
    const fp70 = snap(s, a).fingerprint;
    setGrade(s, a, { score: 75 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', stamp: false, now: 250 });   // a publish
    expect(JSON.parse(snap(s, a).save_log)).toEqual([[200, fp0, fp70]]);
    expect(snap(s, a)).toMatchObject({ fingerprint_at: 200, synced_fingerprint: fp0 });
  });

  test('save log: malformed entries are dropped, never thrown on', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    const fp = snap(s, a).fingerprint;
    for (const bad of ['[null]', '[[300]]', 'not json', '{"a":1}', JSON.stringify([[300, fp, fp], null, [Number.NaN, 'x', 'y'], ['300', fp, fp], [310, 1, fp], [320, fp, fp, 'extra']])]) {
      db.prepare('UPDATE feedback_snapshots SET save_log = ?').run(bad);
      setGrade(s, a, { score: 61 + Math.random() });                // a changing save rewrites the log
      expect(() => captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 400 })).not.toThrow();
      const log = JSON.parse(snap(s, a).save_log);
      expect(log.every((e) => Array.isArray(e) && Number.isFinite(e[0]) && typeof e[1] === 'string' && typeof e[2] === 'string')).toBe(true);
      expect(log.at(-1)[0]).toBe(400);
    }
    // The valid entries of the mixed log survive: [300, fp, fp] and [320, …] (extra items ignored).
    expect(JSON.parse(snap(s, a).save_log).map((e) => e[0])).toEqual([300, 320, 400]);
  });

  test('save log: capped at the newest 20 entries', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 0, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    for (let i = 1; i <= 25; i += 1) {
      setGrade(s, a, { score: i });
      captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 1000 + i });
    }
    const log = JSON.parse(snap(s, a).save_log);
    expect(log).toHaveLength(20);
    expect(log[0][0]).toBe(1006);
    expect(log.at(-1)[0]).toBe(1025);
  });

  test('save log: a revision-read sync with no new revision clears it (entries from before the read); a mastery pull keeps it', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { score: 70 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 300 });
    captureFeedbackSnapshots(db, { courseId });                      // mastery pull: no revisions read
    expect(JSON.parse(snap(s, a).save_log)).toHaveLength(1);
    expect(snap(s, a).fingerprint_at).toBe(300);
    captureFeedbackSnapshots(db, { revisionsRead: new Set([999]) }); // another assignment's revisions read
    expect(JSON.parse(snap(s, a).save_log)).toHaveLength(1);
    setGrade(s, a, { score: 72 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 500 });
    // A sync that started at 400 read this assignment's revisions: entries before 400 go.
    captureFeedbackSnapshots(db, { revisionsRead: new Set([a]), readSince: 400 });
    expect(JSON.parse(snap(s, a).save_log).map((e) => e[0])).toEqual([500]);
    expect(snap(s, a).fingerprint_at).toBe(500);
    captureFeedbackSnapshots(db, { revisionsRead: true });
    expect(snap(s, a)).toMatchObject({ save_log: '[]', fingerprint_at: 0, synced_fingerprint: snap(s, a).fingerprint });
  });

  test('M2: revision_at never moves backwards', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, latest_revision_at: 300 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    expect(snap(s, a).revision_at).toBe(300);
    setGrade(s, a, { latest_revision_at: 300 });
    expect(captureFeedbackSnapshots(db)).toEqual({ arrivals: 0 });
  });

  test('C1: levels pulled between syncs are in the snapshot, so a later revision compares against them', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, submitted_at: 50, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'a1', 't1', 75, 'EX')`).run();
    captureFeedbackSnapshots(db, { courseId });                     // after the mastery pull
    setGrade(s, a, { latest_revision_at: 200 });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe('arrived');
  });
});

// Round 5 (review N1–N3): a save route captures the pair unstamped BEFORE its own mirror,
// echoes Schoology's fresh score/exception (+ grade time) unstamped unless the teacher wrote
// it, then mirrors the teacher's own change and captures stamped (server/routes/mastery.js).
// The reviewer's repros, driven through that protocol; plus the common workflows.
describe('captureFeedbackSnapshots — the save-route protocol (round 5)', () => {
  const stateOf = (s, a, requestedAt = 0) => {
    const cur = currentFingerprints(db, {}).get(`${s}:${a}`);
    return resubmissionStateFromSnapshot({ snapshot: snap(s, a), currentFingerprint: cur.fingerprint, requestedAt, gradedAt: Number(cur.grade.submitted_at) || 0, lti: Number(cur.grade.is_lti_submission) === 1 });
  };
  const lvl = (topic, g) => db.prepare(`INSERT INTO mastery_scores (student_uid, assignment_schoology_id, topic_id, points, grade) VALUES ('u1', 'a1', ?, 50, ?)
    ON CONFLICT(student_uid, assignment_schoology_id, topic_id) DO UPDATE SET grade = excluded.grade`).run(topic, g);
  const sync = () => captureFeedbackSnapshots(db);
  const pull = () => captureFeedbackSnapshots(db, { courseId });
  // A save route: pre-capture, optional Schoology-side echo, then the teacher's change.
  const routeSave = (s, a, now, { echo = null, teacher = () => {} } = {}) => {
    const pre = (echoAt) => captureFeedbackSnapshots(db, { assignmentId: a, studentId: s, mode: 'save', stamp: false, echoAt });
    pre();
    if (echo) { setGrade(s, a, echo); pre(echo.submitted_at); }
    teacher();
    captureFeedbackSnapshots(db, { assignmentId: a, studentId: s, mode: 'save', now });
  };
  const base = () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, grade_comment: 'Note', comment_status: 1, submitted_at: 50, latest_revision_at: 100 });
    lvl('t1', 'D');
    sync();
    return [s, a];
  };
  const hide = (s, a) => () => setGrade(s, a, { comment_status: null, submitted_at: 300 });

  test('N1: Schoology rubric regrade moving the score before R → R unsynced → hide-only save echoing the score → pull → sync: arrived', () => {
    const [s, a] = base();
    routeSave(s, a, 300, { echo: { score: 80, submitted_at: 150 }, teacher: hide(s, a) });
    lvl('t1', 'EX'); pull();
    setGrade(s, a, { latest_revision_at: 200 }); sync();
    expect(stateOf(s, a)).toBe('arrived');
    expect(stateOf(s, a, 120)).toBe('arrived');                     // requested: not fulfilled
  });

  test('N2: a running sync upserted a pre-R score + R → hide-only save before its capture → arrived', () => {
    const [s, a] = base();
    setGrade(s, a, { score: 70, submitted_at: 150, latest_revision_at: 200 });
    routeSave(s, a, 300, { teacher: hide(s, a) });
    sync();
    expect(stateOf(s, a)).toBe('arrived');
  });

  test('N2b: same with a save that changes nothing visible → arrived', () => {
    const [s, a] = base();
    setGrade(s, a, { score: 70, submitted_at: 150, latest_revision_at: 200 });
    routeSave(s, a, 300, { teacher: () => setGrade(s, a, { submitted_at: 300 }) });
    sync();
    expect(stateOf(s, a)).toBe('arrived');
  });

  test('N3: R → sync (C1) → a pull wrote a pre-R level → hide-only save before the pull capture → arrived', () => {
    const [s, a] = base();
    setGrade(s, a, { latest_revision_at: 200 }); sync();
    lvl('t1', 'EX');
    routeSave(s, a, 300, { teacher: hide(s, a) });
    pull(); sync();
    expect(stateOf(s, a)).toBe('arrived');
  });

  for (const synced of [true, false]) {
    const R = (s, a) => { setGrade(s, a, { latest_revision_at: 200 }); if (synced) sync(); };
    const tag = synced ? 'synced R' : 'unsynced R';
    test(`W1: Prism rubric regrade (/write, then write-comment with rubricSaved) → answered (${tag})`, () => {
      const [s, a] = base(); R(s, a);
      routeSave(s, a, 300, { teacher: () => lvl('t1', 'EX') });
      routeSave(s, a, 301, { teacher: () => setGrade(s, a, { score: 80, submitted_at: 301 }) });
      sync();
      expect(stateOf(s, a)).toBe(null);
    });
    test(`W2: Schoology score regrade after R → answered (${tag})`, () => {
      const [s, a] = base(); R(s, a);
      setGrade(s, a, { score: 70, submitted_at: 300 }); sync();
      expect(stateOf(s, a)).toBe(null);
    });
    test(`W2b: a Schoology score regrade after R echoed by a hide-only save before any sync → answered (${tag})`, () => {
      const [s, a] = base(); R(s, a);
      routeSave(s, a, 400, { echo: { score: 70, submitted_at: 300 }, teacher: () => setGrade(s, a, { comment_status: null, submitted_at: 400 }) });
      sync();
      expect(stateOf(s, a)).toBe(null);
    });
    test(`W3/W4: a visible comment after R, in Schoology or Prism → answered (${tag})`, () => {
      const [s, a] = base(); R(s, a);
      routeSave(s, a, 300, { teacher: () => setGrade(s, a, { grade_comment: 'Better now', submitted_at: 300 }) });
      sync();
      expect(stateOf(s, a)).toBe(null);
    });
    test(`W6 (documented safe direction): a Schoology rubric-only regrade after R stays arrived (${tag})`, () => {
      const [s, a] = base(); R(s, a);
      setGrade(s, a, { submitted_at: 300 }); sync(); lvl('t1', 'EX'); pull();
      expect(stateOf(s, a)).toBe('arrived');
    });
  }

  test('W2c: R not yet in the DB → a Schoology score regrade after R echoed by a hide-only save → sync sees R → answered', () => {
    const [s, a] = base();
    routeSave(s, a, 400, { echo: { score: 70, submitted_at: 300 }, teacher: () => setGrade(s, a, { comment_status: null, submitted_at: 400 }) });
    setGrade(s, a, { latest_revision_at: 200 }); sync();
    expect(stateOf(s, a)).toBe(null);
    // The echo is logged with Schoology's grade time and marked as Schoology's — never Prism evidence.
  });

  test('an echoed Schoology change is logged with its own grade time and never counts as a Prism save', () => {
    const [s, a] = base();
    routeSave(s, a, 400, { echo: { score: 70, submitted_at: 300 } });
    const log = JSON.parse(snap(s, a).save_log);
    expect(log).toHaveLength(1);
    expect(log[0][0]).toBe(300);
    expect(log[0][3]).toBe('schoology');
    // Judged with R = 250: the echo is after R but only the Schoology grade time can answer it.
    setGrade(s, a, { latest_revision_at: 250 }); sync();
    expect(snap(s, a).arrival_parts).toBe(0);
    expect(stateOf(s, a)).toBe(null);                                // score changed + grade time 300 > R
  });

  test('documented residual N4: the levels bit is per arrival, not per topic — a Prism change then revert, then a pull bringing a pre-R level on another topic, reads as answered', () => {
    const [s, a] = base(); lvl('t2', 'D'); sync();
    setGrade(s, a, { latest_revision_at: 200 }); sync();
    routeSave(s, a, 300, { teacher: () => lvl('t1', 'EX') });
    routeSave(s, a, 310, { teacher: () => lvl('t1', 'D') });
    lvl('t2', 'EX'); pull();
    expect(stateOf(s, a)).toBe(null);
  });

  test('documented residual (cap): 25 changing saves after R, the first changing levels → the entry is dropped → a false Arrived', () => {
    const [s, a] = base();
    routeSave(s, a, 210, { teacher: () => lvl('t1', 'EX') });
    for (let i = 0; i < 24; i += 1) routeSave(s, a, 220 + i, { teacher: () => setGrade(s, a, { comment_status: i % 2 ? 1 : null, submitted_at: 220 + i }) });
    setGrade(s, a, { latest_revision_at: 200 }); sync();
    expect(stateOf(s, a)).toBe('arrived');
  });
});

// Final review C1: feedback given in Schoology between syncs but BEFORE the resubmission R
// must not count as answering R. grades.submitted_at (the REST grade time — any teacher
// write, never a submission) at or before R means all the current feedback predates R.
describe('captureFeedbackSnapshots — feedback given in Schoology before R (final review C1)', () => {
  const stateOf = (s, a, requestedAt = 0) => {
    const cur = currentFingerprints(db, {}).get(`${s}:${a}`);
    return resubmissionStateFromSnapshot({ snapshot: snap(s, a), currentFingerprint: cur.fingerprint, requestedAt, gradedAt: Number(cur.grade.submitted_at) || 0, lti: Number(cur.grade.is_lti_submission) === 1 });
  };

  test('(a) submitted + ungraded at sync 1; scored/commented in Schoology at 200; resubmitted at 300; sync 2 → arrived', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: null, submitted_at: 0, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { score: 60, grade_comment: 'Fix the loop', comment_status: 1, submitted_at: 200 });
    setGrade(s, a, { latest_revision_at: 300 });
    expect(captureFeedbackSnapshots(db)).toEqual({ arrivals: 1 });
    const row = snap(s, a);
    expect(row).toMatchObject({ arrival_revision_at: 300 });
    expect(row.arrival_baseline).toBe(row.fingerprint);              // all current feedback predates R
    expect(stateOf(s, a)).toBe('arrived');
  });

  test('(b) graded 60 at sync 1; regraded 70 in Schoology at 200; resubmitted at 300; sync 2 → arrived', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 40 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { score: 70, submitted_at: 200 });
    setGrade(s, a, { latest_revision_at: 300 });
    captureFeedbackSnapshots(db);
    expect(snap(s, a).arrival_baseline).toBe(snap(s, a).fingerprint);
    expect(stateOf(s, a)).toBe('arrived');
  });

  test('(a) with an open ask before R: still arrived, not fulfilled', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: null, submitted_at: 0, latest_revision_at: 100 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { score: 60, submitted_at: 200, latest_revision_at: 300 });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a, 150)).toBe('arrived');
  });

  test('a teacher write after R in Schoology still acknowledges it (baseline = the previous snapshot)', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 40 });
    captureFeedbackSnapshots(db);
    const fp0 = snap(s, a).fingerprint;
    setGrade(s, a, { score: 70, submitted_at: 400, latest_revision_at: 300 });
    captureFeedbackSnapshots(db);
    expect(snap(s, a).arrival_baseline).toBe(fp0);
    expect(stateOf(s, a)).toBe(null);
  });

  test('then a regrade after R acknowledges the arrival', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 40 });
    captureFeedbackSnapshots(db);
    setGrade(s, a, { score: 70, submitted_at: 200, latest_revision_at: 300 });
    captureFeedbackSnapshots(db);
    expect(stateOf(s, a)).toBe('arrived');
    setGrade(s, a, { score: 80, submitted_at: 500 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 500 });
    expect(stateOf(s, a)).toBe(null);
  });

  test('a save-mode capture keeps the old baseline rule (only sync captures apply C1)', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 60, submitted_at: 50, latest_revision_at: 40 });
    captureFeedbackSnapshots(db);
    const fp0 = snap(s, a).fingerprint;
    setGrade(s, a, { score: 70, submitted_at: 200, latest_revision_at: 300 });
    captureFeedbackSnapshots(db, { assignmentId: a, mode: 'save', now: 600 });
    expect(snap(s, a).arrival_baseline).toBe(fp0);
  });
});

// Final review M4: server boot seeds the snapshots once when there are none yet (first
// start after the deploy), so arrivals show before the first sync — best-effort.
describe('seedFeedbackSnapshotsIfEmpty', () => {
  test('an empty table is captured (first-deploy rule applies)', () => {
    const s = student('u1'); const a = assignment('a1');
    grade(s, a, { score: 80, comment_status: 1, grade_comment: 'ok', submitted_at: 100, latest_revision_at: 200 });
    expect(seedFeedbackSnapshotsIfEmpty(db)).toEqual({ seeded: true, arrivals: 1 });
    expect(snap(s, a)).toMatchObject({ arrival_revision_at: 200 });
  });

  test('a table that already has snapshots is left alone', () => {
    const s = student('u1'); const a = assignment('a1'); const b = assignment('b1');
    grade(s, a, { score: 80 });
    captureFeedbackSnapshots(db);
    grade(s, b, { score: 70 });
    expect(seedFeedbackSnapshotsIfEmpty(db)).toEqual({ seeded: false });
    expect(snap(s, b)).toBeUndefined();
  });

  test('a failure is logged and swallowed, never thrown', () => {
    const log = { error: vi.fn() };
    const broken = { prepare: () => { throw new Error('disk I/O error'); } };
    expect(seedFeedbackSnapshotsIfEmpty(broken, { log })).toEqual({ seeded: false, error: 'disk I/O error' });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('snapshot'), 'disk I/O error');
  });
});
