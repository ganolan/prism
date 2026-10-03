// Parity (triage resubmissions): after the LTI timestamp fix, check stored data
// against the 2026-10-03 probe. READ-ONLY. Usage: DB_PATH=/tmp/prism-dev.db node scripts/parity-lti-resubmission.js
//
// Amendment B (Task 8): also runs captureFeedbackSnapshots on an IN-MEMORY COPY
// of the database (db.serialize() -> new Database(buffer)) and reports the
// resulting snapshot/arrival counts, so the probe can show the snapshot model
// working on real data without writing a single byte to the source DB_PATH.
import Database from 'better-sqlite3';
import { isResubmitted } from '../server/lib/resubmission.js';
import { getTriage } from '../server/services/triage.js';
import { captureFeedbackSnapshots } from '../server/services/feedbackSnapshots.js';
import { arrivedKeys } from '../server/services/resubmissions.js';

const db = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
const rows = (archived) => db.prepare(`
  SELECT g.*, a.title FROM grades g JOIN assignments a ON a.id = g.assignment_id JOIN courses c ON c.id = a.course_id
  WHERE a.is_lti_submission = 1 AND c.archived = ?`).all(archived);
const archived = rows(1).filter(isResubmitted);
console.log(`archived LTI resubmitted-since-feedback: ${archived.length} (probe: 9)`);
for (const r of archived) console.log(`  ${r.title}`);
const current = rows(0).filter((r) => r.lti_submission_state === 'submitted');
console.log(`current LTI submitted: ${current.length}; submitted_at == latest_revision_at: ${current.filter((r) => r.submitted_at === r.latest_revision_at).length}`);
const t = getTriage(db, {});
console.log('triage resubmissions by state:', t.resubmissions.reduce((m, r) => ({ ...m, [r.state]: (m[r.state] || 0) + 1 }), {}));

// --- Amendment B: snapshot model on an in-memory copy (never touches DB_PATH) ---
const before = db.prepare('SELECT COUNT(*) AS n FROM feedback_snapshots').get().n;
// db.serialize() preserves the source file's header "file format write/read
// version" bytes (offsets 18/19). A WAL-mode source (prod/dev always is)
// serializes with those bytes set to 2, which the in-memory "memdb" VFS used by
// `new Database(buffer)` rejects (SQLITE_CANTOPEN on first prepare() — WAL needs
// a real file + shared memory, not memdb) even though the page images SQLite
// folded into the buffer are already WAL-reconciled and fully valid as a plain
// rollback-journal-format file. Patching those two bytes to 1 (legacy format) on
// the in-memory COPY only — never the source buffer's origin, the on-disk file —
// makes the in-memory open succeed; verified against a written-out copy of the
// same buffer (reopens cleanly either way) and against toy DBs of various sizes.
const buffer = db.serialize();
buffer[18] = 1;
buffer[19] = 1;
const mem = new Database(buffer);
const { arrivals } = captureFeedbackSnapshots(mem);
const after = mem.prepare('SELECT COUNT(*) AS n FROM feedback_snapshots').get().n;
const arrivedNow = arrivedKeys(mem, {}).size;
console.log(`\nfeedback_snapshots (in-memory copy): ${before} before capture -> ${after} after (new arrivals this capture: ${arrivals})`);
console.log(`Arrived count after capture (in-memory): ${arrivedNow}`);
mem.close();

// Sanity: the source DB is untouched by the in-memory capture.
const stillBefore = db.prepare('SELECT COUNT(*) AS n FROM feedback_snapshots').get().n;
if (stillBefore !== before) {
  throw new Error(`BUG: source DB_PATH changed (feedback_snapshots ${before} -> ${stillBefore}) — the probe must stay read-only`);
}
console.log(`Source DB_PATH unchanged: feedback_snapshots still ${stillBefore} (probe stayed read-only)`);
