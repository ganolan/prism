// WRITE probe (run only with Graham's approval): post one submission comment with
// a file through Prism's own form path (postCommentWithFile), and record every
// same-origin request the page makes while doing it: method, path, status,
// content type, request header NAMES and form field NAMES. No values are printed,
// so no token, file content or student data reaches the log.
//
// Usage: DB_PATH=<db> node scripts/probe-submission-comment-file.js <assignmentId> <studentId> <file> "<text>"
import 'dotenv/config';
import { getDb } from '../server/db/index.js';
import { commentDeps, postCommentWithFile } from '../server/services/submissionComments.js';
import { openSessionPage } from '../server/services/schoologySession.js';

const [assignmentId, studentId, filePath, text = ''] = process.argv.slice(2);
if (!assignmentId || !studentId || !filePath) { console.error('usage: <assignmentId> <studentId> <file> [text]'); process.exit(2); }
const TRACKER = /aptrinsic|nr-data|bam\.nr|doubleclick|googletag|esp-us2|\/rte\/v1\/|hotjar|segment|onetrust|cookielaw|fullstory/;
const mask = (u) => u.replace(/\d{6,}/g, '#');

function fieldNames(req) {
  const ct = req.headers()['content-type'] || '';
  const buf = req.postDataBuffer();
  if (!buf) return [];
  const body = buf.toString('latin1');
  if (ct.includes('multipart/form-data')) {
    return [...body.matchAll(/name="([^"]+)"(?:; filename="[^"]*")?/g)].map((m) => m[0].includes('filename=') ? `${m[1]} (file)` : m[1]);
  }
  if (ct.includes('application/x-www-form-urlencoded')) return body.split('&').map((kv) => decodeURIComponent(kv.split('=')[0]));
  if (ct.includes('json')) { try { return Object.keys(JSON.parse(body)); } catch { return ['(json)']; } }
  return [`(${ct || 'no content type'}, ${buf.length} bytes)`];
}

const log = [];
commentDeps.openPage = async () => {
  const s = await openSessionPage();
  if (!s) return s;
  s.page.on('requestfinished', async (req) => {
    const url = req.url();
    if (!url.includes('hkis.edu.hk') || TRACKER.test(url)) return;
    if (req.method() === 'GET' && !['xhr', 'fetch', 'document'].includes(req.resourceType())) return;
    const resp = await req.response();
    log.push({
      method: req.method(), type: req.resourceType(), path: mask(new URL(url).pathname + (new URL(url).search ? '?…' : '')),
      status: resp?.status(), respType: (resp?.headers()['content-type'] || '').split(';')[0],
      reqType: (req.headers()['content-type'] || '').split(';')[0],
      headers: Object.keys(req.headers()).filter((h) => /csrf|requested|token|key/i.test(h)),
      fields: req.method() === 'GET' ? [] : fieldNames(req),
    });
  });
  return s;
};

try {
  const r = await postCommentWithFile(getDb(), { assignmentId, studentId, text, filePath });
  console.log(`POSTED comment ${r.posted_id}; file name on the reloaded page: ${r.file_shown}`);
} catch (err) {
  console.log(`FAILED ${err.code || ''}: ${err.message}`);
} finally {
  console.log('\n-- requests --');
  for (const e of log) {
    console.log(`${e.method} ${e.type} ${e.path} -> ${e.status} ${e.respType}${e.reqType ? ` | sent ${e.reqType}` : ''}${e.headers.length ? ` | headers: ${e.headers.join(', ')}` : ''}${e.fields.length ? ` | fields: ${e.fields.join(', ')}` : ''}`);
  }
}
