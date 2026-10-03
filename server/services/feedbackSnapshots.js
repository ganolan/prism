// Visible-feedback snapshots (triage resubmissions spec, Amendment B).
// A pair's fingerprint is what the *student* can see (score, exception, rubric
// levels, visible comment minus Prism's status line — server/lib/feedbackFingerprint.js).
// feedback_snapshots remembers the last one seen plus the resubmission currently
// being answered: when grades.latest_revision_at moves past the snapshot's
// revision_at, the arrival is recorded with baseline = the feedback before the
// resubmission — from the pair's log of Prism saves when the teacher saved after it,
// else the current fingerprint for a sync whose grade time (grades.submitted_at) is at
// or before the revision (final review C1), else the previous snapshot's fingerprint
// (captureFeedbackSnapshots has the full rule). The pair is
// answered once the current fingerprint differs from that baseline AND the teacher
// wrote after the arrival (resubmissionStateFromSnapshot).
// Captured at the end of each sync and after every Prism grade/comment save.
import { fingerprint, hasPriorFeedback } from '../lib/feedbackFingerprint.js';
import { isResubmitted, sqliteUtcToEpoch, feedbackAnswered, changedParts, absorbParts, wroteAfter, PART_SCORE } from '../lib/resubmission.js';

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
           a.is_lti_submission, sl.line AS stored_line
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

const SAVE_LOG_MAX = 20;
// The pair's save log; malformed entries are dropped (never thrown on). An entry is
// [finite epoch s, fingerprint before (string), fingerprint after (string)], plus
// 'schoology' as a 4th item for a Schoology-side change a save route echoed (round 5).
const SCHOOLOGY = 'schoology';
const validEntry = (e) => Array.isArray(e) && typeof e[0] === 'number' && Number.isFinite(e[0])
  && typeof e[1] === 'string' && typeof e[2] === 'string';
const isPrismEntry = (e) => e[3] !== SCHOOLOGY;
function parseLog(text) {
  let v;
  try {
    v = JSON.parse(text || '[]');
  } catch {
    return [];
  }
  return Array.isArray(v) ? v.filter(validEntry).map((e) => (e[3] === SCHOOLOGY ? e.slice(0, 4) : e.slice(0, 3))) : [];
}

// Snapshot every pair in scope. One transaction; unchanged pairs are not rewritten.
//
// The save log (residual review round 3). Every Prism save that changes the
// fingerprint (mode 'save', stamped) appends [now, fingerprint before, fingerprint
// after] to the pair's save_log (newest SAVE_LOG_MAX kept). A new revision R is judged
// against the feedback that predates it:
//   - Prism saves after R are logged → baseline = the fingerprint the FIRST of them
//     replaced (the state just before the teacher's first post-R save, including any
//     sync-observed changes before it); the parts those saves changed become the
//     arrival's arrival_parts (round 4: the per-part evidence "answered" needs — a
//     rubric-only save doesn't move grades.submitted_at).
//   - none, and a capture that isn't a stamped Prism save, with grades.submitted_at > 0
//     and not after R → every bit of current feedback predates R, so baseline = the
//     current fingerprint (final review C1). "After R" uses wroteAfter: on lti work only
//     from R + 60.
//   Entries marked 'schoology' (round 5: a Schoology-side change a save route echoed,
//   timed at Schoology's own grade time) count for the baseline's ordering only, never as
//   Prism evidence.
//   - otherwise baseline = the previous snapshot's fingerprint.
// Judging R empties the log. A Schoology sync capture that re-read the pair's revisions
// (revisionsRead: a Set of assignment ids, or true) and saw no new revision drops the
// entries from before the read began (readSince, epoch s; default: all) — any revision
// before then would have been seen. Mastery pulls and other sync-mode captures (no
// revisions read) never clear it. fingerprint_at = the newest logged save's time (0 =
// none) and synced_fingerprint = the fingerprint before the oldest logged save (or the
// current one when the log is empty): informational (parity probe / debugging) — the
// answered rule never reads them — except that a row with a stamp but no log (a
// first-sight save, or a row from before the log) keeps the old rule: fingerprint_at > R
// → baseline = synced_fingerprint. arrival_write_at (round 2) is no longer written:
// arrival_parts replaced it.
//
// stamp: false (save mode only): the status-line publisher (R1), and the captures every
// save route runs BEFORE its own mirror and after echoing Schoology's fresh score
// (round 5, server/routes/mastery.js). It records state other writers produced, not a
// teacher save — never stamped, never Prism evidence (an echo with echoAt is logged as
// 'schoology'), so publishing a status line never counts as a Prism save after a
// resubmission. It also never answers a pending arrival: a publish that makes a hidden
// teacher comment visible (or mirrors an unsynced Schoology change) is absorbed into
// arrival_baseline. An arrival already answered is left alone, so a publish never
// re-surfaces it.
export function captureFeedbackSnapshots(db, {
  mode = 'sync', stamp = true, revisionsRead = null, readSince = null, echoAt = 0, now = Math.floor(Date.now() / 1000), ...scope
} = {}) {
  const isSave = mode === 'save';
  const stamps = isSave && stamp !== false;
  const readRevisions = (assignmentId) => !isSave && (revisionsRead === true || Boolean(revisionsRead?.has?.(assignmentId)));
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
                                  synced_fingerprint = ?, fingerprint_at = ?, arrival_parts = ?, save_log = ?,
                                  updated_at = datetime('now')
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
          cur.fingerprint, stamps ? now : 0);
        if (arrivalAt) arrivals += 1;
        continue;
      }
      const priorLog = snap.save_log ?? '[]';
      let log = parseLog(snap.save_log);
      let arrivalAt = snap.arrival_revision_at;
      let baseline = snap.arrival_baseline;
      let arrivalParts = Number(snap.arrival_parts) || 0;
      let fingerprintAt = Number(snap.fingerprint_at) || 0;
      const newRevision = latest > snap.revision_at;
      const gradedAt = Number(cur.grade.submitted_at) || 0;
      // Is a write at t (a Prism save, or the Schoology grade time) after revision r? On lti
      // work only from r + 60 — the revision time has no seconds (wroteAfter).
      const lti = Number(cur.grade.is_lti_submission) === 1;
      const savedAfter = (t, r) => wroteAfter(t, r, lti);
      if (newRevision) {
        // A new resubmission R: judge it against the feedback that predates it.
        const after = log.filter(([t]) => savedAfter(t, latest));
        const legacyStamp = log.length === 0 && fingerprintAt > latest && snap.synced_fingerprint != null;
        // C1 applies to every capture that isn't the teacher's own stamped save (round 5:
        // the unstamped capture a save route runs before its mirror is often the first
        // to see R, upserted by a running sync).
        const allBeforeR = !stamps && after.length === 0 && !legacyStamp && gradedAt > 0 && !savedAfter(gradedAt, latest);
        arrivalAt = latest; arrivals += 1;
        if (after.length) baseline = after[0][1];
        else if (legacyStamp) baseline = snap.synced_fingerprint;
        else if (allBeforeR) baseline = cur.fingerprint;
        else baseline = snap.fingerprint;
        // Round 4: the parts of visible feedback those post-R Prism saves changed (an
        // echoed Schoology change is ordering only — never Prism evidence).
        arrivalParts = after.filter(isPrismEntry).reduce((p, [, before, afterFp]) => p | changedParts(before, afterFp), 0);
        log = []; fingerprintAt = 0;
      } else if (readRevisions(cur.assignmentId)) {
        const since = readSince ?? Infinity;
        log = log.filter(([t]) => t >= since);
        if (!log.length) fingerprintAt = 0;
      }
      if (isSave && !stamps && arrivalAt > 0) {
        // Unstamped capture with an arrival (a status-line publish, or a save route's
        // pre-save capture): absorb what it sees into the baseline unless the arrival was
        // already answered — or a score/exception change now carries a Schoology grade
        // time after the arrival (a save route echoes Schoology's own grade time with the
        // fresh score, so a Schoology regrade after R still answers; round 5).
        const gradedAfter = savedAfter(gradedAt, arrivalAt);
        const answered = feedbackAnswered(baseline, snap.fingerprint, { parts: arrivalParts, gradedAfter })
          || (gradedAfter && Boolean(changedParts(baseline, cur.fingerprint) & PART_SCORE));
        // Part-wise (round 6): only the parts that changed since the last capture — what
        // this capture's writer (another sync/pull, the echo, the publish) brought — never
        // the teacher's own earlier saves, which the last snapshot already holds.
        // Round 7: also any part that differs from the baseline which no Prism save has
        // touched since the arrival (not in arrival_parts) — e.g. a pre-R change a sync saw
        // after R was judged (sync captures never absorb). Principle: absorb anything the
        // teacher has not touched through Prism since the arrival; never absorb a hide
        // (absorbParts keeps a non-empty baseline comment).
        const parts = changedParts(snap.fingerprint, cur.fingerprint) | (changedParts(baseline, cur.fingerprint) & ~arrivalParts);
        if (!answered) baseline = absorbParts(baseline, cur.fingerprint, parts);
      }
      const changed = cur.fingerprint !== snap.fingerprint;
      // Round 5: a save route's echo of a Schoology-side change (unstamped, echoAt = Schoology's
      // own grade time) is logged too, marked 'schoology', so a later revision is judged
      // against the state before it when it came after R (a Schoology answer) and after it
      // when it came before R (pre-R feedback) — it never adds Prism evidence.
      if (isSave && !stamps && changed && Number(echoAt) > 0) {
        log = [...log, [Number(echoAt), snap.fingerprint, cur.fingerprint, SCHOOLOGY]].slice(-SAVE_LOG_MAX);
      }
      if (stamps && changed) {
        log = [...log, [now, snap.fingerprint, cur.fingerprint]].slice(-SAVE_LOG_MAX);
        // A Prism save after a pending arrival is a teacher write after it — for the
        // parts of visible feedback it changed (round 4).
        if (arrivalAt > 0 && savedAfter(now, arrivalAt)) arrivalParts |= changedParts(snap.fingerprint, cur.fingerprint);
      }
      const prismLog = log.filter(isPrismEntry);
      if (prismLog.length) fingerprintAt = prismLog[prismLog.length - 1][0];
      else if (log.length) fingerprintAt = 0;                       // only echoed Schoology changes
      // A stamp with no log (a first-sight save, or a row from before the log) stays
      // pending — with its synced_fingerprint — until a revision is judged.
      const legacyPending = !log.length && fingerprintAt > 0;
      let synced;
      if (log.length) synced = log[0][1];
      else if (legacyPending) synced = snap.synced_fingerprint ?? cur.fingerprint;
      else synced = cur.fingerprint;
      const revisionAt = Math.max(latest, snap.revision_at);
      const logText = JSON.stringify(log);
      if (!changed && revisionAt === snap.revision_at && arrivalAt === snap.arrival_revision_at
        && baseline === snap.arrival_baseline && synced === snap.synced_fingerprint && fingerprintAt === snap.fingerprint_at
        && arrivalParts === (Number(snap.arrival_parts) || 0)
        && logText === priorLog) continue;
      update.run(cur.fingerprint, revisionAt, arrivalAt, baseline, synced, fingerprintAt, arrivalParts, logText,
        cur.studentId, cur.assignmentId);
    }
  })();
  return { arrivals };
}

// Server boot (final review M4): a database with no snapshots yet — the first start
// after the Amendment B deploy — is captured once now (sync mode, so the first-deploy
// rule applies), so arrivals show before the first sync. Best-effort: a failure is
// logged and swallowed, never blocking the server from starting.
export function seedFeedbackSnapshotsIfEmpty(db, { log = console } = {}) {
  try {
    if (db.prepare('SELECT 1 FROM feedback_snapshots LIMIT 1').get()) return { seeded: false };
    const { arrivals } = captureFeedbackSnapshots(db, {});
    return { seeded: true, arrivals };
  } catch (err) {
    log.error('[feedback snapshots] boot seed failed:', err.message);
    return { seeded: false, error: err.message };
  }
}
