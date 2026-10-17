// Read-only parity probe for native dropbox submission files (#107).
//   GET /v1/sections/{sec}/submissions/{aid}/{uid}?with_attachments=1
// For every active student in the section it prints the revision count and the
// key union of revisions, attachment envelopes and files (keys and value types
// only: no names, file names or contents). Then it downloads up to MAX files
// (default 2) through downloadFile(), the signed path Prism serves, and compares
// each body's MD5 with the file's md5_checksum. Ids are masked to their last 3
// digits. Nothing is written to Schoology or to disk.
//
// Usage: node scripts/parity-submission-files.js <sectionId> <assignmentId> [MAX]
import 'dotenv/config';
import { createHash } from 'crypto';
import { apiGet, getSectionEnrollments, downloadFile } from '../server/services/schoology.js';

const [sectionId, aid, maxArg] = process.argv.slice(2);
if (!sectionId || !aid) {
  console.error('usage: node scripts/parity-submission-files.js <sectionId> <assignmentId> [MAX]');
  process.exit(2);
}
const MAX = Number(maxArg || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (id) => `…${String(id ?? '').slice(-3)}`;
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const addKeys = (set, obj) => Object.entries(obj || {}).forEach(([k, v]) => set.add(`${k}:${typeOf(v)}`));
const pathShape = (p) => String(p || '').replace(/^https:\/\/[^/]+/, '').replace(/\d+/g, 'N').replace(/[^/]+(\.[a-z0-9]+)$/i, '{name}$1');

const enrolled = await getSectionEnrollments(sectionId);
const students = enrolled.filter((e) => String(e.admin) !== '1' && String(e.status) === '1');
console.log(`section ${mask(sectionId)} assignment ${mask(aid)}: ${students.length} active students`);

const envKeys = new Set(); const revKeys = new Set(); const attKeys = new Set(); const fileKeys = new Set();
const pathShapes = new Set();
const files = [];
let n = 0;
for (const s of students) {
  let data;
  try { data = await apiGet(`/sections/${sectionId}/submissions/${aid}/${s.uid}?with_attachments=1`); }
  catch (e) { console.log(`  S${String(++n).padStart(2, '0')} ERR ${e.status}`); continue; }
  addKeys(envKeys, data);
  const revs = data?.revision || [];
  const perRev = revs.map((r) => {
    addKeys(revKeys, r);
    addKeys(attKeys, r.attachments);
    if (r.attachments?.files) addKeys(attKeys, Object.fromEntries(Object.entries(r.attachments.files).map(([k, v]) => [`files.${k}`, v])));
    const list = r.attachments?.files?.file || [];
    for (const f of list) {
      addKeys(fileKeys, f);
      pathShapes.add(pathShape(f.download_path));
      files.push({ student: n + 1, rev: r.revision_id, f });
    }
    return `${mask(r.revision_id)}:draft=${r.draft},late=${r.late},items=${r.num_items},files=${list.length}`;
  });
  console.log(`  S${String(++n).padStart(2, '0')} revisions=${revs.length} [${perRev.join(' ')}]`);
  await sleep(300);
}
console.log(`\nenvelope keys: ${[...envKeys].join(', ')}`);
console.log(`revision keys: ${[...revKeys].join(', ')}`);
console.log(`attachments keys: ${[...attKeys].join(', ')}`);
console.log(`file keys: ${[...fileKeys].join(', ')}`);
console.log(`download_path shapes: ${[...pathShapes].join(' | ')}`);
console.log(`files seen: ${files.length}`);

// A spread: the first file of each extension, then the first from a later
// revision, then the rest in order.
const sample = [];
const pick = (x) => { if (x && !sample.includes(x)) sample.push(x); };
for (const ext of new Set(files.map((x) => x.f.extension))) pick(files.find((x) => x.f.extension === ext));
pick(files.find((x) => Number(x.rev) > 1));
files.forEach(pick);

let match = 0; let tried = 0;
for (const { student, rev, f } of sample.slice(0, MAX)) {
  tried++;
  const t0 = Date.now();
  const res = await downloadFile(f.download_path);
  const md5 = createHash('md5').update(res.body).digest('hex');
  const ok = res.status === 200 && md5 === f.md5_checksum;
  if (ok) match++;
  console.log(`  download S${String(student).padStart(2, '0')} rev ${mask(rev)} .${f.extension}: status=${res.status} type=${res.contentType} bytes=${res.body.length} filesize=${f.filesize} md5Match=${ok} ${Date.now() - t0}ms`);
}
console.log(`\nMD5 parity: ${match}/${tried} downloads equal md5_checksum`);
