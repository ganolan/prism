// Follow-up spike (#62): is the public `draft=1` revision a real "student opened
// it" signal, or auto-provisioned at assignment-distribution time?
// Dumps the full revision object(s) per non-submitted student for one assignment:
// all keys + the `created` timestamp. If every draft shares ~one created time =
// auto-provisioned (useless as an "opened" signal). If spread out = real engagement.
// PII: mask uids; show revision key NAMES + created epoch (not a PII value).
//
// Usage: node scripts/probe-revision-detail.js <sectionId> <assignmentId>
import 'dotenv/config';
import { getDb } from '../server/db/index.js';
import { apiGet } from '../server/services/schoology.js';

const sectionId = process.argv[2] || '7899907720';
const assignmentId = process.argv[3] || '8348763574';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = getDb();
const course = db.prepare('SELECT id FROM courses WHERE schoology_section_id = ?').get(sectionId);
const uids = db.prepare(`
  SELECT DISTINCT s.schoology_uid FROM enrolments e
  JOIN students s ON s.id = e.student_id
  WHERE e.course_id = ?
`).all(course.id).map((r) => r.schoology_uid).filter(Boolean);

const iso = (sec) => { try { return new Date(Number(sec) * 1000).toISOString(); } catch { return String(sec); } };
let n = 0;
const created = [];
console.log(`assignment ${assignmentId}, ${uids.length} enrolled — full revision detail:`);
for (const uid of uids) {
  const mask = 'S' + String(++n).padStart(2, '0');
  try {
    const d = await apiGet(`/sections/${sectionId}/submissions/${assignmentId}/${uid}`);
    const revs = d?.revision || [];
    if (!revs.length) { console.log(`  ${mask}: NO revisions (never opened / not started)`); continue; }
    for (const r of revs) {
      console.log(`  ${mask}: keys=[${Object.keys(r).join(',')}] revision_id=${r.revision_id} draft=${r.draft} created=${r.created} (${iso(r.created)}) num_attachments=${Array.isArray(r.attachments?.file?.attachment) ? r.attachments.file.attachment.length : (r.attachments ? 'obj' : 0)}`);
      if (Number(r.draft) === 1) created.push(Number(r.created));
    }
  } catch (e) {
    console.log(`  ${mask}: err=${e.message}`);
  }
  await sleep(250);
}
if (created.length) {
  const min = Math.min(...created), max = Math.max(...created);
  const uniq = new Set(created).size;
  console.log(`\nDRAFT created-time spread: n=${created.length} distinct=${uniq} min=${iso(min)} max=${iso(max)} range=${Math.round((max - min) / 60)}min`);
  console.log(uniq <= 2 || (max - min) < 120
    ? '⇒ CLUSTERED → looks AUTO-PROVISIONED (draft is NOT a reliable "opened" signal)'
    : '⇒ SPREAD OUT → looks like REAL student engagement (draft ≈ "opened")');
}
