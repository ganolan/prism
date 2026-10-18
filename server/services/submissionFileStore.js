// Cached native dropbox submission files (#107): database reads and the
// replace-on-refresh write. No Schoology calls here (submissionFiles.js does
// those), mirroring submissionCommentStore.js.

const isoOf = (secs) => (Number(secs) > 0 ? new Date(Number(secs) * 1000).toISOString() : null);

function parseFiles(json) {
  try { return JSON.parse(json || '[]') || []; } catch { return []; }
}

// A stored revision → the shape the UI reads.
export function describeRevision(r) {
  return {
    revision_id: r.revision_id,
    created: isoOf(r.created),
    late: !!r.late,
    draft: !!r.draft,
    files: parseFiles(r.files).map((f) => ({
      id: f.id, filename: f.filename, title: f.title, filesize: f.filesize, filemime: f.filemime, extension: f.extension,
      converted: f.converted ? { filesize: f.converted.filesize, filemime: f.converted.filemime, extension: f.converted.extension } : null,
    })),
  };
}

export function revisionSummary(revisions) {
  return { revisions: revisions.length, files: revisions.reduce((n, r) => n + r.files.length, 0) };
}

// One pair's cached revisions, newest first. read_at is null when never read.
export function readRevisions(db, { assignmentId, studentId }) {
  const rows = db.prepare(`
    SELECT * FROM submission_revisions WHERE assignment_id = ? AND student_id = ?
    ORDER BY created DESC, CAST(revision_id AS INTEGER) DESC
  `).all(assignmentId, studentId);
  const read = db.prepare('SELECT read_at, error FROM submission_revision_reads WHERE assignment_id = ? AND student_id = ?')
    .get(assignmentId, studentId);
  const revisions = rows.map(describeRevision);
  return { revisions, summary: revisionSummary(revisions), read_at: isoOf(read?.read_at), read_at_epoch: read?.read_at ?? 0, error: read?.error ?? null };
}

// One cached file with its download path, or null.
export function storedFile(db, { assignmentId, studentId, revisionId, fileId }) {
  const row = db.prepare('SELECT files FROM submission_revisions WHERE assignment_id = ? AND student_id = ? AND revision_id = ?')
    .get(assignmentId, studentId, String(revisionId));
  return parseFiles(row?.files).find((f) => String(f.id) === String(fileId)) || null;
}

// Replace a pair's revisions with what Schoology returned (already shaped rows).
export function storeRevisions(db, { assignmentId, studentId, rows, readAt = Math.floor(Date.now() / 1000) }) {
  db.transaction(() => {
    db.prepare('DELETE FROM submission_revisions WHERE assignment_id = ? AND student_id = ?').run(assignmentId, studentId);
    const ins = db.prepare(`
      INSERT INTO submission_revisions (assignment_id, student_id, revision_id, created, late, draft, num_items, files)
      VALUES (@assignment_id, @student_id, @revision_id, @created, @late, @draft, @num_items, @files)
    `);
    for (const r of rows) ins.run({ num_items: null, files: null, ...r, assignment_id: assignmentId, student_id: studentId });
    db.prepare(`
      INSERT INTO submission_revision_reads (assignment_id, student_id, read_at, error) VALUES (?, ?, ?, NULL)
      ON CONFLICT(assignment_id, student_id) DO UPDATE SET read_at = excluded.read_at, error = NULL
    `).run(assignmentId, studentId, readAt);
  })();
}

// A failed read keeps the cached revisions and the last good read_at.
export function storeReadError(db, { assignmentId, studentId, error }) {
  db.prepare(`
    INSERT INTO submission_revision_reads (assignment_id, student_id, read_at, error) VALUES (?, ?, 0, ?)
    ON CONFLICT(assignment_id, student_id) DO UPDATE SET error = excluded.error
  `).run(assignmentId, studentId, String(error).slice(0, 300));
}

// Summaries ({revisions, files, read_at}) of every pair read for one assignment
// (local id), keyed by local student id. Cache only, for the card chips.
export function fileSummariesForAssignment(db, assignmentId) {
  const out = {};
  const pairs = db.prepare('SELECT student_id FROM submission_revision_reads WHERE assignment_id = ?').all(assignmentId);
  for (const { student_id } of pairs) {
    const t = readRevisions(db, { assignmentId, studentId: student_id });
    out[student_id] = { ...t.summary, read_at: t.read_at };
  }
  return out;
}

// Every read pair's cached revisions for one assignment (local id), keyed by local
// student id: what get_assignment_context lists. Cache only.
export function revisionsForAssignment(db, assignmentId) {
  const out = {};
  const pairs = db.prepare('SELECT student_id FROM submission_revision_reads WHERE assignment_id = ?').all(assignmentId);
  for (const { student_id } of pairs) out[student_id] = readRevisions(db, { assignmentId, studentId: student_id });
  return out;
}

// Summaries of one student's read pairs, keyed by Schoology assignment id (the
// student page, #162). Cache only; nothing about another student.
export function fileSummariesForStudent(db, studentId) {
  const rows = db.prepare(`
    SELECT r.assignment_id, a.schoology_assignment_id FROM submission_revision_reads r
    JOIN assignments a ON a.id = r.assignment_id WHERE r.student_id = ?
  `).all(studentId);
  const out = {};
  for (const r of rows) {
    const t = readRevisions(db, { assignmentId: r.assignment_id, studentId });
    out[r.schoology_assignment_id] = { ...t.summary, read_at: t.read_at };
  }
  return out;
}
