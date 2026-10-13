// Pure helpers for scripts/probe-attempt-write.js (linked quizzes phase 4a, spec §14).
import path from 'path';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function pickFrq(attempt, rubricsById) {
  const frq = (attempt?.questions || []).find(x => x.kind === 'frq' && x.rubric);
  if (!frq) return { reason: 'no FRQ with a Schoology rubric' };
  const rubric = rubricsById[frq.rubric.rubricId];
  if (!rubric) return { reason: `rubric ${frq.rubric.rubricId} not read` };
  if (rubric.rows.length !== 1) return { reason: `rubric has ${rubric.rows.length} rows` };
  if (frq.rubricScore == null) return { reason: 'FRQ not marked' };
  const level = rubric.rows[0].levels.find(l => l.points === Number(frq.rubricScore));
  if (!level) return { reason: `stored score ${frq.rubricScore} is not a rubric level` };
  return { qid: frq.qid, rubricId: frq.rubric.rubricId, enrollmentId: frq.rubric.enrollmentId, levelName: level.name, points: level.points, comment: frq.comment };
}

export function compareAttempts(before, after) {
  if (!after) return ['attempt page did not parse'];
  const out = [];
  const byQid = new Map(after.questions.map(x => [x.qid, x]));
  for (const b of before.questions) {
    const a = byQid.get(b.qid);
    if (!a) { out.push(`question ${b.qid}: missing after the save`); continue; }
    if (b.points !== a.points) out.push(`question ${b.qid}: points ${b.points} -> ${a.points}`);
    if (b.rubricScore !== a.rubricScore) out.push(`question ${b.qid}: rubric score ${b.rubricScore} -> ${a.rubricScore}`);
    if (norm(b.comment) !== norm(a.comment)) out.push(`question ${b.qid}: comment changed`);
  }
  return out;
}

export function captureRecord(request) {
  const headers = request.headers();
  return {
    method: request.method(), url: request.url(), contentType: headers['content-type'] ?? null,
    headerNames: Object.keys(headers).sort(), body: request.postData() ?? null,
  };
}

export function assertOutsideRepo(dir, repoRoot) {
  if (!dir) throw new Error('Set OUT_DIR to a folder outside the repo (captures hold student work)');
  const rel = path.relative(path.resolve(repoRoot), path.resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error(`OUT_DIR must be outside the repo: ${dir}`);
}
