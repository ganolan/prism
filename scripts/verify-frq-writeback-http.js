// Live check of the FRQ write-back over plain HTTP (#141): Prism's own openClient
// (server/services/quizWriteback.js), no browser, on one student's essay on a grade-by-question page.
//
// DEFAULT IS READ-ONLY: prints the student's fields on the question page and their rubric grade.
// The WRITES run only with CONFIRM=frq:<attemptId> matching the arguments, after the teacher's explicit
// go-ahead on that attempt. As Prism's writer does (the rubric PUT, then the form save, each read back):
//   1. sets the level LEVEL (points, e.g. 3) with the comment plus " (test)";
//   2. restores the original level and comment.
// Then every form field is compared with the first load. Prints no student work beyond the one comment's
// length.
//
// Usage: [PRISM_SESSION_DIR=…] node scripts/verify-frq-writeback-http.js <testId> <questionNumber> <attemptId>
//        LEVEL=3 CONFIRM=frq:<attemptId> node scripts/verify-frq-writeback-http.js <testId> <questionNumber> <attemptId>
import 'dotenv/config';
import { openClient } from '../server/services/quizWriteback.js';
import { serializeForm, BYQ_FORM, fieldsAt, withMarkAt, byQuestionRubrics, changedNames, toBody } from '../server/lib/attemptForm.js';
import { parseRubricGradeInfo } from '../server/lib/parseQuizRubric.js';

const [testId, number, attemptId] = process.argv.slice(2);
if (!testId || !number || !attemptId) { console.error('usage: <testId> <questionNumber> <attemptId>'); process.exit(1); }
const confirmed = process.env.CONFIRM === `frq:${attemptId}`;

const client = await openClient({ pauseMs: 400 });
const index = await client.get(`/assignment/${testId}/assessment_results/question_stats`);
const qPath = String(index.text ?? '').match(new RegExp(`href="(/assignment/${testId}/assessment_results/question_stats/\\d+/${number})"`))?.[1];
if (!qPath) { console.error(`No grade-by-question page for question ${number} (index HTTP ${index.status})`); process.exit(1); }

async function load() {
  const r = await client.get(qPath);
  const form = r.status === 200 ? serializeForm(r.text, BYQ_FORM) : null;
  if (!form) throw new Error(`The question page did not load (HTTP ${r.status})`);
  return { form, rubrics: byQuestionRubrics(r.text) };
}
const first = await load();
const entry = first.rubrics[attemptId];
const prefix = first.form.pairs.map(([k]) => k.match(new RegExp(`^(students\\[\\d+\\]\\[submissions\\]\\[${attemptId}\\])\\[points\\]$`))?.[1]).find(Boolean);
if (!entry || !prefix) { console.error('That attempt is not on the question page.'); process.exit(1); }
const giPath = `/iapi/grades/assessment_component_submission_rubric_grade_info/${entry.rubricId}/${entry.qid}/${entry.enrollmentId}/${attemptId}`;
const grade = async () => {
  const r = await client.get(giPath, { json: true });
  return r.status === 200 ? parseRubricGradeInfo(r.json) : null;
};
const describe = (f, cells) => `rubric_score ${f.rubricScore}, points ${f.points}/${f.maxPoints}, override ${f.override}, comment ${f.comment.length} chars; rubric grade ${JSON.stringify(Object.fromEntries(Object.entries(cells ?? {}).map(([k, v]) => [k, v.points])))}`;

const original = fieldsAt(first.form.pairs, prefix);
const cells0 = await grade();
if (!cells0 || Object.keys(cells0).length !== 1) { console.error('Expected a one-row rubric grade.'); process.exit(1); }
const rowId = Object.keys(cells0)[0];
console.log(`page ${qPath}, ${first.form.pairs.length} fields`);
console.log(`before: ${describe(original, cells0)}`);

if (!confirmed) {
  console.log(`read-only. To write: LEVEL=<points> CONFIRM=frq:${attemptId}`);
  process.exit(0);
}
const level = Number(process.env.LEVEL);
if (!Number.isFinite(level) || level === original.rubricScore) { console.error('Set LEVEL to a level other than the current one.'); process.exit(1); }

async function step(label, points, comment) {
  const t = Date.now();
  const put = await client.putRubric(giPath, { gradeInfo: { [rowId]: { grade: points, comment: '' } }, overrideGrade: null, comment });
  if (put.status !== 200) throw new Error(`${label}: the rubric save answered ${put.error || `HTTP ${put.status}`}`);
  const { form } = await load();
  const post = await client.post(qPath, toBody(withMarkAt(form.pairs, prefix, { points, comment })));
  const after = await load();
  const f = fieldsAt(after.form.pairs, prefix);
  const cells = await grade();
  const others = changedNames(form.pairs, after.form.pairs).filter((n) => !n.startsWith(prefix));
  const ok = f.points === points && f.rubricScore === points && f.override === 1
    && f.comment.replace(/\r\n/g, '\n') === comment && cells?.[rowId]?.points === points && !others.length;
  console.log(`${label}: rubric PUT ${put.status}, form POST ${post.status}, ${Date.now() - t} ms → ${describe(f, cells)}${others.length ? `; OTHER FIELDS CHANGED: ${others.join(', ')}` : ''} → ${ok ? 'OK' : 'NOT as expected'}`);
  return ok;
}

const comment = original.comment.replace(/\r\n/g, '\n');
const changed = await step(`set level ${level}`, level, `${comment} (test)`);
const restored = await step(`restore level ${original.rubricScore}`, original.rubricScore, comment);
const final = await load();
const drift = changedNames(first.form.pairs, final.form.pairs);
console.log(`read-back: ${changed && restored && !drift.length ? 'OK, every field as it started' : `fields differ from the first load: ${drift.join(', ') || 'none'}`}`);
await client.close();
