// Parity (triage resubmissions): after the LTI timestamp fix, check stored data
// against the 2026-10-03 probe. READ-ONLY. Usage: DB_PATH=/tmp/prism-dev.db node scripts/parity-lti-resubmission.js
import Database from 'better-sqlite3';
import { isResubmitted } from '../server/lib/resubmission.js';
import { getTriage } from '../server/services/triage.js';

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
