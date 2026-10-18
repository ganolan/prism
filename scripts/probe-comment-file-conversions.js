// Read-only probe (#162): do files attached to submission comments carry a
// converted copy, as native dropbox files do (converted_download_path etc.)?
// For every (assignment, student) pair whose cached thread holds a file, it
// re-reads the thread from Schoology (`…/comments?with_attachments=1`) and
// reports the key union of the comment file objects, the converted_* values
// seen, and counts by filemime. No names, file names or contents are printed.
//
// Usage: DB_PATH=<a copy of the database> node scripts/probe-comment-file-conversions.js
import 'dotenv/config';
import { getDb } from '../server/db/index.js';
import { getSubmissionComments } from '../server/services/schoology.js';

const db = getDb();
const pairs = db.prepare(`
  SELECT DISTINCT c.schoology_section_id AS section, a.schoology_assignment_id AS aid, s.schoology_uid AS uid
  FROM submission_comments sc
  JOIN assignments a ON a.id = sc.assignment_id
  JOIN courses c ON c.id = a.course_id
  JOIN students s ON s.id = sc.student_id
  WHERE sc.attachments IS NOT NULL
`).all();

const keys = new Map();
const converted = new Map();
const mimes = new Map();
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
let files = 0;
for (const p of pairs) {
  const comments = await getSubmissionComments(p.section, p.aid, p.uid);
  for (const c of comments) {
    for (const f of c?.attachments?.files?.file || []) {
      files++;
      for (const k of Object.keys(f)) bump(keys, k);
      bump(mimes, f.filemime);
      bump(converted, `status=${f.converted_status} type=${f.converted_type} path=${f.converted_download_path ? 'yes' : 'no'} mime=${f.converted_filemime ?? '-'}`);
    }
  }
}
console.log(JSON.stringify({ pairs: pairs.length, files, keys: Object.fromEntries(keys), converted: Object.fromEntries(converted), mimes: Object.fromEntries(mimes) }, null, 2));
