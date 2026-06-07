// Deep spike (#62) — THE decisive probe. The grader's two tabs are fed by:
//   /iapi2/assignments/{aid}/in-progress-documents/   → "In Progress"
//   /iapi2/assignments/{aid}/submitted-documents/     → "Submitted"
// A student in NEITHER list = "Not Started" (never opened). This is the
// teacher-visible 3-way split. We dump both lists for an assignment, mask
// identities, and locate the two ground-truth students.
//
// Usage: node scripts/probe-submission-documents.js <sectionId> <assignmentId>
import 'dotenv/config';
import { chromium } from 'playwright';
import { join } from 'path';
import { existsSync } from 'fs';
import { SCHOOLOGY_BASE, isLoggedInUrl } from '../server/lib/browserSession.js';

const sectionId = process.argv[2] || '7899907720';
const assignmentId = process.argv[3] || '8348763574';
const TARGETS = { '132465441': 'MARIA(never-opened)', '11862763': 'BRIGID(GHD=drop)' };
const STATE_FILE = join(process.cwd(), '.playwright-session', 'storage-state.json');
if (!existsSync(STATE_FILE)) { console.error('No session'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: STATE_FILE });
const page = await context.newPage();

async function getJson(path) {
  await page.goto(`${SCHOOLOGY_BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!isLoggedInUrl(page.url())) throw new Error('SESSION DEAD');
  return page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, len: text.length, json, head: text.slice(0, 300) };
  }, `${SCHOOLOGY_BASE}${path}`);
}

// pull an array of student-ish records out of whatever envelope comes back
function extractList(json) {
  if (!json) return null;
  const b = json.body ?? json;
  if (Array.isArray(b)) return b;
  for (const k of Object.keys(b || {})) if (Array.isArray(b[k]) && b[k].length && typeof b[k][0] === 'object') return b[k];
  // maybe keyed by uid
  if (b && typeof b === 'object') { const vals = Object.values(b); if (vals.length && typeof vals[0] === 'object') return vals; }
  return null;
}

let n = 0; const mask = new Map();
const m = (uid) => { if (!mask.has(uid)) mask.set(uid, 'S' + String(++n).padStart(2, '0')); return mask.get(uid); };

async function probe(label, path) {
  console.log(`\n===== ${label}: ${path} =====`);
  let r;
  try { r = await getJson(path); } catch (e) { console.log('  ERR', e.message); return new Set(); }
  console.log(`  status=${r.status} len=${r.len}`);
  if (!r.json) { console.log('  not JSON. head:', r.head); return new Set(); }
  const list = extractList(r.json);
  if (!list) { console.log('  top keys:', Object.keys(r.json.body ?? r.json).join(',')); console.log('  head:', r.head); return new Set(); }
  console.log(`  list length=${list.length}; entry[0] keys:`, Object.keys(list[0]).slice(0, 20).join(','));
  const uids = new Set();
  // find which field holds the student uid by checking against our targets / common names
  const idFields = ['uid', 'user_id', 'userId', 'id', 'enrollment_id', 'student_id'];
  for (const rec of list) {
    let uid = null;
    for (const f of idFields) if (rec[f] != null && TARGETS[String(rec[f])]) { uid = String(rec[f]); break; }
    if (!uid) for (const f of idFields) if (rec[f] != null) { uid = String(rec[f]); break; }
    uids.add(uid);
    const status = rec.submissionStatus ?? rec.status ?? rec.submission_status ?? '';
    const tag = TARGETS[uid] ? ` <<< ${TARGETS[uid]}` : '';
    console.log(`    ${m(uid)} uid=${uid} status=${JSON.stringify(status)} timing=${rec.submissionTiming ?? '-'} revisionCreated=${JSON.stringify(rec.revisionCreated)}(${typeof rec.revisionCreated}) submissionDate=${JSON.stringify(rec.submissionDate)} grade=${rec.grade ?? '-'} exc=${rec.exception ?? '-'}${tag}`);
  }
  return uids;
}

try {
  const inprog = await probe('IN-PROGRESS', `/iapi2/assignments/${assignmentId}/in-progress-documents/`);
  const submitted = await probe('SUBMITTED', `/iapi2/assignments/${assignmentId}/submitted-documents/`);

  console.log('\n===== VERDICT for ground-truth students =====');
  for (const [uid, name] of Object.entries(TARGETS)) {
    const where = inprog.has(uid) ? 'IN-PROGRESS' : submitted.has(uid) ? 'SUBMITTED' : 'NEITHER (=Not Started)';
    console.log(`  ${name}: ${where}`);
  }
} catch (e) {
  console.error('PROBE ERROR:', e.message);
} finally {
  await browser.close();
}
