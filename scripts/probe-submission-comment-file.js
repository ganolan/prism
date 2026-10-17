// WRITE probe (run only with Graham's approval): post one submission comment with
// a file through Prism's own path (postCommentWithFile: plain HTTP with the saved
// session, no browser), logging each request: method, path, status, timing and
// form field NAMES. No values are printed, so no token, file content or student
// data reaches the log.
//
// Usage: DB_PATH=<db> node scripts/probe-submission-comment-file.js <assignmentId> <studentId> <file> "<text>"
import 'dotenv/config';
import { getDb } from '../server/db/index.js';
import { commentDeps, postCommentWithFile } from '../server/services/submissionComments.js';

const [assignmentId, studentId, filePath, text = ''] = process.argv.slice(2);
if (!assignmentId || !studentId || !filePath) { console.error('usage: <assignmentId> <studentId> <file> [text]'); process.exit(2); }
const mask = (u) => u.replace(/\d{6,}/g, '#');
const names = (body) => {
  if (!body) return [];
  if (body instanceof FormData) return [...body.keys()];
  return [...new URLSearchParams(String(body)).keys()];
};
const log = [];
const realFetch = commentDeps.fetch;
commentDeps.fetch = async (url, opts = {}) => {
  const t0 = Date.now();
  const res = await realFetch(url, opts);
  log.push(`${opts.method || 'GET'} ${mask(new URL(url).pathname)} -> ${res.status} ${(res.headers.get('content-type') || '').split(';')[0]} ${Date.now() - t0} ms${opts.body ? ` | fields: ${names(opts.body).join(', ')}` : ''}`);
  return res;
};

const t0 = Date.now();
try {
  const r = await postCommentWithFile(getDb(), { assignmentId, studentId, text, filePath });
  console.log(`POSTED comment ${r.posted_id} (checksum matched) in ${Date.now() - t0} ms`);
} catch (err) {
  console.log(`FAILED ${err.code || ''}: ${err.message}`);
} finally {
  console.log('\n-- requests --');
  log.forEach((l) => console.log(l));
}
