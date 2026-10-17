// Read-only probe: submission comment threads on the public API.
//   GET /v1/sections/{sec}/submissions/{aid}/{uid}/comments
// For every student in the section it prints the thread's size, the key union of the
// comments and how each comment classifies (automatic line / student text / teacher /
// other). No comment text is printed. With PAGE=1 it also checks start/limit paging on
// the longest thread.
//
// Usage: node scripts/probe-submission-comments.js <sectionId> <assignmentId> [<assignmentId>...]
import 'dotenv/config';
import { apiGet, getSectionEnrollments } from '../server/services/schoology.js';

const AUTO = /^\s*Revision \d+ submitted\s*$/i;
const plain = (raw) => String(raw || '').replace(/<br\s*\/?>|<\/p\s*>|<\/div\s*>/gi, '\n').replace(/<[^>]+>/g, '').trim();
function classifyComment(c, studentUid, teachers) {
  const uid = String(c.uid);
  const rest = plain(c.comment).split('\n').filter((l) => !AUTO.test(l)).join('\n').trim();
  if (uid === String(studentUid)) return { kind: rest ? 'student_text' : 'automatic' };
  return { kind: teachers.has(uid) ? 'teacher' : 'other' };
}

const [sectionId, ...aids] = process.argv.slice(2);
if (!sectionId || !aids.length) {
  console.error('usage: node scripts/probe-submission-comments.js <sectionId> <assignmentId>...');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const enrolled = await getSectionEnrollments(sectionId);
const teachers = new Set(enrolled.filter((e) => String(e.admin) === '1').map((e) => String(e.uid)));
const students = enrolled.filter((e) => String(e.admin) !== '1' && String(e.status) === '1');
console.log(`section ${sectionId}: ${students.length} active students, ${teachers.size} admin(s)`);

for (const aid of aids) {
  const a = await apiGet(`/sections/${sectionId}/assignments/${aid}`);
  console.log(`\n=== ${aid} type=${a.type} assignment_type=${a.assignment_type} allow_dropbox=${a.allow_dropbox}`);
  const keys = new Set(); const envKeys = new Set();
  const tally = { automatic: 0, student_text: 0, teacher: 0, other: 0 };
  let longest = { uid: null, n: 0 }; let failed = 0; let n = 0;
  for (const s of students) {
    let data;
    try {
      data = await apiGet(`/sections/${sectionId}/submissions/${aid}/${s.uid}/comments`);
    } catch (e) { failed++; console.log(`  S${++n} ERR ${e.status}`); continue; }
    Object.keys(data || {}).forEach((k) => envKeys.add(k));
    const list = data?.comment || [];
    list.forEach((c) => Object.keys(c).forEach((k) => keys.add(k)));
    const kinds = list.map((c) => classifyComment(c, s.uid, teachers).kind);
    kinds.forEach((k) => tally[k]++);
    if (list.length > longest.n) longest = { uid: s.uid, n: list.length };
    console.log(`  S${String(++n).padStart(2, '0')} total=${data?.total} n=${list.length} kinds=[${kinds.join(',')}] html=${list.some((c) => /<[a-z]/i.test(c.comment || ''))}`);
    await sleep(300);
  }
  console.log(`  envelope keys: ${[...envKeys].join(',')}`);
  console.log(`  comment keys: ${[...keys].join(',')}`);
  console.log(`  tally: ${JSON.stringify(tally)} failed=${failed}`);
  if (process.env.PAGE && longest.n > 1) {
    const p0 = await apiGet(`/sections/${sectionId}/submissions/${aid}/${longest.uid}/comments?start=0&limit=1`);
    const p1 = await apiGet(`/sections/${sectionId}/submissions/${aid}/${longest.uid}/comments?start=1&limit=1`);
    console.log(`  paging on a ${longest.n}-comment thread: limit=1 start=0 -> n=${p0.comment?.length} total=${p0.total} links=${JSON.stringify(Object.keys(p0.links || {}))}; start=1 -> n=${p1.comment?.length} sameFirst=${p0.comment?.[0]?.id === p1.comment?.[0]?.id}`);
    const all = await apiGet(`/sections/${sectionId}/submissions/${aid}/${longest.uid}/comments`);
    const order = (all.comment || []).map((c) => Number(c.created));
    console.log(`  default order ascending by created: ${order.every((t, i) => !i || t >= order[i - 1])}`);
  }
}
