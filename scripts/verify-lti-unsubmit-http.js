// Live check of the LTI unsubmit over plain HTTP (#141): Prism's own unsubmitLti
// (server/services/ltiUnsubmit.js), no browser, on one student and one assignment.
//
// DEFAULT IS READ-ONLY: prints where the student sits in the grader lists, and whether
// the assignment page answers over HTTP with the CSRF pair.
// The WRITE runs only with CONFIRM=unsubmit:<assignmentId>:<uid> matching the arguments,
// after the teacher's explicit go-ahead on that target. It runs unsubmitLti against an
// in-memory database holding just that pair, times it, then reads the lists back.
//
// Usage: [PRISM_SESSION_DIR=…] node scripts/verify-lti-unsubmit-http.js <assignmentId> <uid>
//        CONFIRM=unsubmit:<assignmentId>:<uid> node scripts/verify-lti-unsubmit-http.js <assignmentId> <uid>
import 'dotenv/config';

process.env.DB_PATH = ':memory:';
const [aid, uid] = process.argv.slice(2);
if (!aid || !uid) { console.error('usage: <assignmentId> <uid>'); process.exit(1); }
const confirmed = process.env.CONFIRM === `unsubmit:${aid}:${uid}`;

const { cookieJar, getJson, getPage, drupalSettings } = await import('../server/services/schoologyWeb.js');
const { getDb } = await import('../server/db/index.js');
const { unsubmitLti } = await import('../server/services/ltiUnsubmit.js');

const jar = cookieJar();
if (!jar) { console.error('No saved session (set PRISM_SESSION_DIR)'); process.exit(1); }

async function where(label) {
  const [sub, inp] = await Promise.all(['submitted-documents', 'in-progress-documents']
    .map((list) => getJson(jar, `/iapi2/assignments/${aid}/${list}/`)));
  const find = (r) => (r.json?.data || []).find((d) => String(d.id) === uid);
  const s = find(sub); const i = find(inp);
  console.log(`${label}: submitted-documents ${sub.status} ${s ? `HAS uid (date "${s.submissionDate}", timing ${s.submissionTiming}, grade ${s.grade ?? '-'})` : 'no uid'}; `
    + `in-progress-documents ${inp.status} ${i ? `HAS uid (revisionCreated ${i.revisionCreated}, grade ${i.grade ?? '-'})` : 'no uid'}`);
  return { submitted: Boolean(s), inProgress: Boolean(i) };
}

const before = await where('before');
const t0 = Date.now();
const { html } = await getPage(jar, `/assignments/${aid}/info`);
const csrf = drupalSettings(html)?.s_common;
console.log(`assignment page over HTTP: ${Date.now() - t0} ms, CSRF pair ${csrf?.csrf_token && csrf?.csrf_key ? 'present' : 'MISSING'}`);

if (!confirmed) {
  console.log(`read-only. To unsubmit: CONFIRM=unsubmit:${aid}:${uid}`);
  process.exit(0);
}
if (!before.submitted) { console.error('The student is not in submitted-documents: nothing to unsubmit. Stopping.'); process.exit(1); }

const db = getDb();
const courseId = db.prepare(`INSERT INTO courses (schoology_section_id, course_name) VALUES ('verify', 'verify')`).run().lastInsertRowid;
const studentId = db.prepare(`INSERT INTO students (schoology_uid, first_name, last_name) VALUES (?, 'Verify', 'Student')`).run(uid).lastInsertRowid;
const assignmentId = db.prepare(`INSERT INTO assignments (course_id, schoology_assignment_id, title, is_lti_submission) VALUES (?, ?, 'verify', 1)`).run(courseId, aid).lastInsertRowid;
db.prepare(`INSERT INTO grades (student_id, assignment_id, lti_submission_state) VALUES (?, ?, 'submitted')`).run(studentId, assignmentId);

const t1 = Date.now();
try {
  const r = await unsubmitLti(db, { studentId, assignmentId }, { jar });
  console.log(`unsubmitLti → ${JSON.stringify(r)} in ${Date.now() - t1} ms`);
} catch (err) {
  console.log(`unsubmitLti threw ${err.code}: ${err.message} (after ${Date.now() - t1} ms)`);
}
const after = await where('after');
console.log(`read-back: ${!after.submitted && after.inProgress ? 'OK, moved from submitted to in progress' : 'NOT as expected'}`);
