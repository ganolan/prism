// One section's submission reads for a given list of tasks: the full sync's
// submission step (syncSectionData) and the on-demand refresh (taskRefresh.js,
// #108) both read through here, so the two cannot disagree.
//   native: one bulk revisions read per native-dropbox task (#55)
//   lti:    the per-task submitted / in-progress document lists (#62)
//   tests:  one test-attempt read for the section's tests (make-up tests)
// A task read in full gets assignments.submissions_read_at = now. A submission is
// cleared only by a read that finished in full.
import { getAssignmentSubmissions } from './schoology.js';
import { groupRevisionsByUid, deriveNativeSubmission } from '../lib/submissionRevisions.js';
import { retryAsync } from '../lib/retryAsync.js';
import { recordSchoologyUnsubmit } from './resubmissions.js';

// Triage: grades.first_submitted_at is a running minimum of the non-zero
// submission times we observe (the bulk revisions API only returns the latest
// revision). Used in each submission upsert's ON CONFLICT clause.
export const KEEP_EARLIEST_FIRST_SUBMITTED = `
      first_submitted_at = CASE
        WHEN excluded.first_submitted_at > 0
         AND (COALESCE(grades.first_submitted_at, 0) = 0 OR excluded.first_submitted_at < grades.first_submitted_at)
        THEN excluded.first_submitted_at ELSE grades.first_submitted_at END`;

// `students`: [{ id: Schoology enrolment id, uid: Schoology uid }].
// `native`, `lti`, `tests`: Schoology assignment ids. `fetchDocuments` /
// `fetchTestAttempts`: a createSubmissionFetcher() reader's reads (absent = no
// session: those tasks are left as they are). `keepStatusOnFailure`: a failed
// lti/test read leaves lti_fetch_status / test_fetch_status as they were (a read
// a page started); the full sync records 'failed'.
// Non-transient native errors throw (the sync's contract), unless `failTaskOnError`: then
// that task alone fails (a page's read: a task deleted in Schoology answers 404).
export async function readTaskSubmissions(db, {
  sectionId, now, students, native = [], lti = [], tests = [],
  fetchDocuments, fetchTestAttempts, keepStatusOnFailure = false, failTaskOnError = false, backoffMs = 750, abandonAfter = 5,
}) {
  const selectStudentByUid = db.prepare('SELECT id FROM students WHERE schoology_uid = ?');
  const selectAssignmentByExt = db.prepare('SELECT id, max_points FROM assignments WHERE schoology_assignment_id = ?');
  const cells = students
    .map((e) => ({ e, studentRow: selectStudentByUid.get(String(e.uid)) }))
    .filter((c) => c.studentRow);

  // Upsert native submission state (insert the row if missing so a submitted-but-
  // ungraded cell still surfaces) — late/draft/timing + submission_type.
  const upsertSubmissionWithType = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, exception, late, draft, latest_revision_at, first_submitted_at, submission_type, synced_at)
    VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      late = excluded.late,
      draft = excluded.draft,
      latest_revision_at = excluded.latest_revision_at,
      submission_type = excluded.submission_type,
      synced_at = excluded.synced_at,${KEEP_EARLIEST_FIRST_SUBMITTED}
  `);
  // No revision → not submitted. UPDATE-only (never insert) so a never-touched
  // cell keeps "no engagement" (no grades row); clears status + type.
  const clearSubmissionWithType = db.prepare(`
    UPDATE grades SET late = 0, draft = 0, latest_revision_at = 0, submission_type = NULL, synced_at = ?
    WHERE student_id = ? AND assignment_id = ?
  `);

  // Submission status phase: one bulk fetch per native-dropbox assignment (#55);
  // per-assignment atomicity — a transient error discards that assignment's
  // results and continues.
  const acceptedResults = []; // committed at the end in one transaction
  const failedAssignmentIds = [];
  const taskErrors = new Map(); // Schoology id → the failed read's message
  let submissionAbandoned = false;
  let rateLimitHits = 0;
  let transientFailures = 0;
  // #55: counts bulk fetches (one per native-dropbox assignment), not the old
  // per-(student) call count — fed into sync_metrics.submission_calls.
  let submissionAttempts = 0;
  // Local ids of the assignments whose revisions were read in full this pass (native
  // bulk read, or an 'ok' lti document read). The end-of-sync snapshot capture may
  // clear these pairs' Prism save logs (feedbackSnapshots.js, residual review round 3).
  const revisionsRead = new Set();
  const readInFull = new Set();
  // Tests the attempt read answered for without covering them (#168): still unknown, but
  // stamped so a page does not read them again on every load.
  const answered = new Set();

  for (const ext of native) {
    if (failedAssignmentIds.length >= abandonAfter) {
      submissionAbandoned = true;
      break;
    }
    const assignRow = selectAssignmentByExt.get(String(ext));
    if (!assignRow) continue;

    // #55: ONE bulk fetch per assignment (was O(students) per-cell calls).
    // Per-assignment atomicity: a transient error discards this assignment and
    // continues; non-transient aborts the sync (unchanged contract).
    let revisions;
    try {
      revisions = await getAssignmentSubmissions(sectionId, String(ext));
      submissionAttempts++;
    } catch (err) {
      if (err && err.transient) {
        if (err.rateLimited) rateLimitHits++; else transientFailures++;
        failedAssignmentIds.push(String(ext));
        taskErrors.set(String(ext), String(err.message || err));
        continue;
      }
      if (failTaskOnError) {
        failedAssignmentIds.push(String(ext));
        taskErrors.set(String(ext), String(err?.message || err));
        continue;
      }
      throw err;
    }
    const byUid = groupRevisionsByUid(revisions);
    revisionsRead.add(assignRow.id);
    readInFull.add(assignRow.id);

    for (const { e, studentRow } of cells) {
      acceptedResults.push({
        studentId: studentRow.id,
        assignmentId: assignRow.id,
        enrolmentId: String(e.id),
        maxPoints: assignRow.max_points ?? null,
        summary: byUid.get(String(e.uid)) || null,
      });
    }
  }

  let submissionCount = 0;
  const writeSubmissions = db.transaction((rows) => {
    for (const r of rows) {
      // Bulk revisions are authoritative for native dropbox (#55): a non-draft
      // revision → submitted (submission_type "drop"); a draft-only revision →
      // in progress; no revision → cleared (no engagement).
      const d = deriveNativeSubmission(r.summary);
      if (d) {
        upsertSubmissionWithType.run(
          r.studentId, r.assignmentId, r.enrolmentId, r.maxPoints,
          d.late, d.draft, d.latestRevisionAt, d.latestRevisionAt, d.submissionType, now,
        );
        submissionCount++;
      } else {
        clearSubmissionWithType.run(now, r.studentId, r.assignmentId);
      }
    }
  });
  writeSubmissions(acceptedResults);

  // #62: lti_submission state pass. Two per-assignment reads (submitted +
  // in-progress documents) give every assigned student's true state. Writes
  // grades.lti_submission_state; inserts a row for un-graded cells so
  // not_started / in_progress reach the gradebook. No-op without a session.
  const upsertLtiState = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, lti_submission_state, synced_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      lti_submission_state = excluded.lti_submission_state,
      synced_at = excluded.synced_at
  `);
  // #125 + triage resubmissions: the grader submissionDate is the LATEST submission
  // → latest_revision_at (+ earliest kept in first_submitted_at). submitted_at stays
  // the REST grade time written by the grades step, so latest_revision_at >
  // submitted_at = resubmitted since graded (verified 2026-10-03,
  // .claude/schoology-api-reference.md).
  const upsertLtiStateWithTime = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, lti_submission_state, latest_revision_at, first_submitted_at, late, synced_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      lti_submission_state = excluded.lti_submission_state,
      latest_revision_at = excluded.latest_revision_at,
      late = excluded.late,
      synced_at = excluded.synced_at,${KEEP_EARLIEST_FIRST_SUBMITTED}
  `);
  // #76: record the per-assignment fetch outcome so the gradebook can flag a
  // genuine capture failure ('failed') vs a healthy read ('ok'). Assignments we
  // never reach this loop for (non-lti, windowed-out, or no session) keep their
  // prior value — so old work never false-flags and a good full sync self-clears.
  const setLtiFetchStatus = db.prepare(`UPDATE assignments SET lti_fetch_status = ? WHERE id = ?`);
  // The document fetch returns null on a transient session-read hiccup (not a
  // throw); a single retry recovers the common all-or-nothing per-assignment
  // failure before we record it as 'failed'.
  if (typeof fetchDocuments === 'function' && lti.length) {
    for (const ext of lti) {
      const assignRow = selectAssignmentByExt.get(String(ext));
      if (!assignRow) continue;
      const result = await retryAsync(
        () => fetchDocuments(String(ext)),
        { attempts: 2, backoffMs },
      );
      if (!result) { // fetch failed after retry → record so the teacher can re-sync
        if (!keepStatusOnFailure) setLtiFetchStatus.run('failed', assignRow.id);
        continue;
      }
      setLtiFetchStatus.run('ok', assignRow.id);
      revisionsRead.add(assignRow.id);
      readInFull.add(assignRow.id);
      const { states: stateMap, details: detailMap } = result;
      const writeStates = db.transaction(() => {
        for (const { e, studentRow } of cells) {
          const state = stateMap.get(String(e.uid));
          if (!state) continue; // student not in either list → leave as-is
          // #125: a submitted student also carries submittedAt/late — persist them
          // (consistent with the native dropbox path) via the timestamped upsert.
          const detail = detailMap?.get(String(e.uid));
          if (detail) {
            upsertLtiStateWithTime.run(
              studentRow.id, assignRow.id, String(e.id), assignRow.max_points ?? null, state,
              detail.submittedAt ?? 0, detail.submittedAt ?? 0, detail.late ?? 0, now,
            );
          } else {
            upsertLtiState.run(studentRow.id, assignRow.id, String(e.id), assignRow.max_points ?? null, state, now);
          }
        }
      });
      writeStates();

      // A graded student back in progress was unsubmitted in Schoology → chase the
      // resubmission. Same enrolled-students mapping writeStates iterates (not the
      // raw stateMap, which may carry uids outside this section's roster).
      for (const { e, studentRow } of cells) {
        if (stateMap.get(String(e.uid)) !== 'in_progress') continue;
        recordSchoologyUnsubmit(db, { studentId: studentRow.id, assignmentId: assignRow.id });
      }
    }
  }

  // Make-up tests: who has an attempt on each Schoology test. ONE session read
  // (plain HTTP, #141) per section (grader_grade_data) for the given tests. A
  // taker gets submission_type 'assessment'; on a good read a non-taker's stale
  // 'assessment' is cleared ('drop' is never touched). test_fetch_status records
  // the outcome per test, like lti_fetch_status: a failed read is 'failed'
  // (unknown, never "missed"), and a test never reached (no session, windowed
  // out, archived) keeps its previous value.
  if (typeof fetchTestAttempts === 'function' && tests.length) {
    await readTestAttempts(db, {
      sectionId, now, students, cells, tests, selectAssignmentByExt, fetchTestAttempts, backoffMs, keepStatusOnFailure, readInFull, answered,
    });
  }

  if (readInFull.size || answered.size) {
    const stamp = db.prepare('UPDATE assignments SET submissions_read_at = ? WHERE id = ?');
    db.transaction(() => { for (const id of [...readInFull, ...answered]) stamp.run(now, id); })();
  }

  return {
    submissionCount,
    failedAssignmentIds,
    taskErrors,
    submissionAbandoned,
    submissionAttempts,
    rateLimitHits,
    transientFailures,
    revisionsRead,
    readInFull,
  };
}

async function readTestAttempts(db, {
  sectionId, now, students, cells, tests: testExts, selectAssignmentByExt, fetchTestAttempts, backoffMs, keepStatusOnFailure, readInFull, answered,
}) {
  const setStatus = db.prepare(`UPDATE assignments SET test_fetch_status = ? WHERE id = ?`);
  // One upsert per (student, test) cell: test_attempt = 'took' | 'none' | 'not_assigned'.
  // 'took' sets submission_type 'assessment'; only an explicit 'none' clears a stale
  // 'assessment'; 'drop' is never touched.
  const writeAttempt = db.prepare(`
    INSERT INTO grades (student_id, assignment_id, enrolment_id, score, max_score, submission_type, test_attempt, synced_at)
    VALUES (@studentId, @assignmentId, @enrolmentId, NULL, @maxPoints, CASE WHEN @attempt = 'took' THEN 'assessment' END, @attempt, @now)
    ON CONFLICT(student_id, assignment_id) DO UPDATE SET
      test_attempt = excluded.test_attempt,
      submission_type = CASE
        WHEN grades.submission_type = 'drop' THEN 'drop'
        WHEN excluded.test_attempt = 'took' THEN 'assessment'
        WHEN excluded.test_attempt = 'none' AND grades.submission_type = 'assessment' THEN NULL
        ELSE grades.submission_type END,
      synced_at = excluded.synced_at
  `);
  const tests = testExts
    .map((ext) => ({ ext: String(ext), row: selectAssignmentByExt.get(String(ext)) }))
    .filter((t) => t.row);
  if (!tests.length) return;

  const result = await retryAsync(
    () => fetchTestAttempts(sectionId, students.map((e) => String(e.uid)), tests.map((t) => t.ext)),
    { attempts: 2, backoffMs },
  );
  db.transaction(() => {
    for (const t of tests) {
      // A test the response has no cells for at all is unknown, not "nobody took it".
      const covered = !!result && [...result.values()].some((byItem) => byItem.has(t.ext));
      if (!covered) {
        if (!keepStatusOnFailure) setStatus.run('failed', t.row.id);
        if (result) answered.add(t.row.id);
        continue;
      }
      setStatus.run('ok', t.row.id);
      readInFull.add(t.row.id);
      for (const { e, studentRow } of cells) {
        const cell = result.get(String(e.uid))?.get(t.ext);
        if (!cell) continue; // no cell for this student → unknown: leave the row as it is
        const attempt = cell.took ? 'took' : cell.notAssigned ? 'not_assigned' : 'none';
        writeAttempt.run({
          studentId: studentRow.id, assignmentId: t.row.id, enrolmentId: String(e.id),
          maxPoints: t.row.max_points ?? null, attempt, now,
        });
      }
    }
  })();
}
