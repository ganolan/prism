// Visible-feedback snapshots (triage resubmissions spec, Amendment B).
// A pair's fingerprint is what the *student* can see (score, exception, rubric
// levels, visible comment minus Prism's status line — server/lib/feedbackFingerprint.js).
// feedback_snapshots remembers the last one seen plus the resubmission currently
// being answered: when grades.latest_revision_at moves past the snapshot's
// revision_at, the arrival is recorded with baseline = the previous snapshot's
// fingerprint (the feedback before the resubmission). The pair is answered once
// the current fingerprint differs from that baseline (resubmissionStateFromSnapshot).
// Captured at the end of each sync and after every Prism grade/comment save.
import { fingerprint, hasPriorFeedback } from '../lib/feedbackFingerprint.js';
import { isResubmitted, sqliteUtcToEpoch } from '../lib/resubmission.js';

export const EMPTY_FINGERPRINT = fingerprint({});

const SCOPE = '(? IS NULL OR a.id = ?) AND (? IS NULL OR a.course_id = ?) AND (? IS NULL OR s.id = ?)';
const scopeArgs = ({ assignmentId = null, courseId = null, studentId = null } = {}) => {
  const n = (v) => (v == null ? null : Number(v));
  return [n(assignmentId), n(assignmentId), n(courseId), n(courseId), n(studentId), n(studentId)];
};

// 'sid:aid' → { studentId, assignmentId, fingerprint, latestRevisionAt, grade } for every
// grades row in scope (any of assignmentId / courseId / studentId; none = all).
export function currentFingerprints(db, scope = {}) {
  const args = scopeArgs(scope);
  const levels = new Map();
  for (const m of db.prepare(`
    SELECT s.id AS student_id, a.id AS assignment_id, ms.topic_id, ms.grade
    FROM mastery_scores ms
    JOIN assignments a ON a.schoology_assignment_id = ms.assignment_schoology_id
    JOIN students s ON s.schoology_uid = ms.student_uid
    WHERE ms.grade IS NOT NULL AND ${SCOPE}
  `).all(...args)) {
    const k = `${m.student_id}:${m.assignment_id}`;
    if (!levels.has(k)) levels.set(k, []);
    levels.get(k).push({ topic_id: m.topic_id, grade: m.grade });
  }
  const out = new Map();
  for (const g of db.prepare(`
    SELECT g.student_id, g.assignment_id, g.score, g.exception, g.grade_comment, g.comment_status,
           g.submitted_at, g.latest_revision_at, g.first_submitted_at, g.lti_submission_state,
           sl.line AS stored_line
    FROM grades g
    JOIN assignments a ON a.id = g.assignment_id
    JOIN students s ON s.id = g.student_id
    LEFT JOIN status_lines sl ON sl.student_id = g.student_id AND sl.assignment_id = g.assignment_id
    WHERE ${SCOPE}
  `).all(...args)) {
    const k = `${g.student_id}:${g.assignment_id}`;
    out.set(k, {
      studentId: g.student_id,
      assignmentId: g.assignment_id,
      fingerprint: fingerprint({
        score: g.score, exception: g.exception, comment: g.grade_comment, commentStatus: g.comment_status,
        levels: levels.get(k) || [], storedLine: g.stored_line,
      }),
      latestRevisionAt: Number(g.latest_revision_at) || 0,
      grade: g,
    });
  }
  return out;
}

// 'sid:aid' → feedback_snapshots row, same scope options.
export function snapshotMap(db, scope = {}) {
  return new Map(db.prepare(`
    SELECT fs.* FROM feedback_snapshots fs
    JOIN assignments a ON a.id = fs.assignment_id
    JOIN students s ON s.id = fs.student_id
    WHERE ${SCOPE}
  `).all(...scopeArgs(scope)).map((r) => [`${r.student_id}:${r.assignment_id}`, r]));
}

// Snapshot every pair in scope. One transaction; unchanged pairs are not rewritten.
// mode 'sync' (end of a Schoology sync, after a mastery pull): fingerprint and
// synced_fingerprint = current, fingerprint_at = 0. mode 'save' (after a Prism
// grade/comment/rubric save): fingerprint = current, stamped fingerprint_at = now
// when it changed. A new revision R is judged against the feedback that predates it:
// fingerprint_at > R means `fingerprint` came from a Prism save after R (the teacher
// already answered), so the baseline is synced_fingerprint instead.
export function captureFeedbackSnapshots(db, { mode = 'sync', now = Math.floor(Date.now() / 1000), ...scope } = {}) {
  const isSave = mode === 'save';
  const current = currentFingerprints(db, scope);
  const snapshots = snapshotMap(db, scope);
  const askedAt = new Map(db.prepare(`
    SELECT r.student_id, r.assignment_id, r.requested_at FROM resubmissions r
    JOIN assignments a ON a.id = r.assignment_id
    JOIN students s ON s.id = r.student_id
    WHERE r.kind = 'request' AND r.status = 'open' AND ${SCOPE}
  `).all(...scopeArgs(scope)).map((r) => [`${r.student_id}:${r.assignment_id}`, sqliteUtcToEpoch(r.requested_at)]));
  const insert = db.prepare(`
    INSERT INTO feedback_snapshots (student_id, assignment_id, fingerprint, revision_at, arrival_revision_at, arrival_baseline,
                                    synced_fingerprint, fingerprint_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const update = db.prepare(`
    UPDATE feedback_snapshots SET fingerprint = ?, revision_at = ?, arrival_revision_at = ?, arrival_baseline = ?,
                                  synced_fingerprint = ?, fingerprint_at = ?, updated_at = datetime('now')
    WHERE student_id = ? AND assignment_id = ?
  `);
  let arrivals = 0;
  db.transaction(() => {
    for (const [k, cur] of current) {
      const latest = cur.latestRevisionAt;
      const snap = snapshots.get(k);
      if (!snap) {
        // First sight of the pair. First-deploy rule: a pair the old timestamp rule
        // calls resubmitted, with feedback the student can see, is an arrival whose
        // baseline is that feedback (Arrived until it changes). A pair whose first
        // revision came after an open ask is an arrival on top of no prior feedback.
        // Anything else is a plain snapshot.
        let arrivalAt = 0;
        let baseline = null;
        if (latest > 0 && isResubmitted(cur.grade) && hasPriorFeedback(cur.fingerprint)) {
          arrivalAt = latest; baseline = cur.fingerprint;
        } else if (latest > 0 && askedAt.has(k) && latest > askedAt.get(k)) {
          arrivalAt = latest; baseline = EMPTY_FINGERPRINT;
        }
        insert.run(cur.studentId, cur.assignmentId, cur.fingerprint, latest, arrivalAt, baseline,
          isSave ? null : cur.fingerprint, isSave ? now : 0);
        if (arrivalAt) arrivals += 1;
        continue;
      }
      let arrivalAt = snap.arrival_revision_at;
      let baseline = snap.arrival_baseline;
      if (latest > snap.revision_at) {
        // A new resubmission R: the feedback before it. If the last fingerprint came
        // from a Prism save after R, fall back to what the last sync saw.
        const savedAfter = snap.fingerprint_at > latest && snap.synced_fingerprint != null;
        arrivalAt = latest; baseline = savedAfter ? snap.synced_fingerprint : snap.fingerprint; arrivals += 1;
      }
      const revisionAt = Math.max(latest, snap.revision_at);
      const changed = cur.fingerprint !== snap.fingerprint;
      const synced = isSave ? snap.synced_fingerprint : cur.fingerprint;
      const fingerprintAt = isSave ? (changed ? now : snap.fingerprint_at) : 0;
      if (!changed && revisionAt === snap.revision_at && arrivalAt === snap.arrival_revision_at
        && baseline === snap.arrival_baseline && synced === snap.synced_fingerprint && fingerprintAt === snap.fingerprint_at) continue;
      update.run(cur.fingerprint, revisionAt, arrivalAt, baseline, synced, fingerprintAt, cur.studentId, cur.assignmentId);
    }
  })();
  return { arrivals };
}
