// Spike (#142), read only: where does Schoology keep the Google Drive file
// reference for a Google Drive (lti_submission) task? Plain HTTP with the saved
// session cookies (schoologyWeb.js), GETs only. Prints key shapes, and string
// values with names, ids and hashes masked; never full student data.
//
// Usage: node scripts/probe-gdrive-submission-ref.js <assignmentId> [path ...]
//   default paths: the grader's submitted-documents and in-progress-documents.
//   Extra paths (e.g. /iapi2/assignments/{aid}/...) are fetched the same way.
import 'dotenv/config';
import { cookieJar } from '../server/services/schoologyWeb.js';
import { SCHOOLOGY_BASE } from '../server/lib/browserSession.js';

const aid = process.argv[2];
if (!aid) { console.error('Usage: <assignmentId> [path ...]'); process.exit(1); }
const jar = cookieJar();
if (!jar) { console.error('No saved session'); process.exit(1); }
const paths = process.argv.slice(3);
if (!paths.length) paths.push(`/iapi2/assignments/${aid}/submitted-documents/`, `/iapi2/assignments/${aid}/in-progress-documents/`);

const NAMEISH = /^(firstName|middleName|lastName|name|title|avatarUrl|picture|email|comment)$/i;
function mask(v) {
  return String(v)
    .replace(/[A-Za-z0-9_-]{25,}/g, (m) => `<${m.length}ch>`)       // Drive file ids, hashes
    .replace(/\b\d{6,}\b/g, (m) => `<${m.length}d>`);               // Schoology ids
}
function shape(v, key = '', depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(v)) return v.length ? [shape(v[0], key, depth + 1), `(${v.length})`] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, k, depth + 1)]));
  if (typeof v === 'string') return NAMEISH.test(key) ? `<str ${v.length}>` : mask(v).slice(0, 200);
  if (typeof v === 'number' && String(v).length >= 6) return `<${String(v).length}d>`;
  return v;
}

for (const p of paths) {
  const res = await fetch(`${SCHOOLOGY_BASE}${p}`, {
    headers: { cookie: jar.header(), Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    redirect: 'manual',
  });
  jar.take(res);
  const text = await res.text();
  console.log(`\n=== ${p.replace(/\d{6,}/g, (m) => `<${m.length}d>`)} → ${res.status} (${text.length} bytes)`);
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!json) { console.log(mask(text.slice(0, 400))); continue; }
  const body = json.data ?? json.body ?? json;
  const list = Array.isArray(body) ? body : null;
  console.log(String(JSON.stringify(shape(list ? list[0] : body), null, 1)).slice(0, 4000));
  if (list) {
    // Every key whose value looks like a document reference, across entries.
    const keys = new Map();
    for (const e of list) for (const [k, v] of Object.entries(e || {})) {
      if (v && typeof v === 'object') continue;
      if (/doc|file|url|link|drive|google|revision|id$/i.test(k)) keys.set(k, (keys.get(k) || 0) + (v !== null && v !== '' ? 1 : 0));
    }
    console.log('entries:', list.length, 'non-empty ref-ish keys:', JSON.stringify(Object.fromEntries(keys)));
  }
  await new Promise((r) => setTimeout(r, 600));
}
