// Pure parsers for a test's results pages (browser session, read-only):
//   GET /assignment/{id}/assessment_results              → who attempted
//   GET /assignment/{id}/assessment_results/student_stats/{uid} → their attempts
// Shapes: .claude/schoology-api-reference.md, "Did the student take the test?".
// The stats page also links /unsubmit and /delete (GET-href write actions): only
// the bare view link `student_stats/{uid}/{attemptId}` is read here.
import { parse } from 'node-html-parser';
import { parseUsDateTime } from './quizText.js';

export function parseQuizResults(html) {
  const root = parse(String(html ?? ''));
  const out = [];
  for (const tr of root.querySelectorAll('tr')) {
    const m = (tr.getAttribute('class') || '').match(/\bstudent-row-(\d+)\b/);
    if (!m) continue;
    const cell = tr.querySelector('td.cell-submissions')?.text.trim() || '';
    const count = cell.match(/^(\d+)\s*\//);
    // Only "-" (observed) and a count are known; any other text is unknown (null), with the text, so a
    // stored attempt is never removed on a cell Prism cannot read.
    if (count) out.push({ uid: m[1], attempted: Number(count[1]) >= 1 });
    else if (cell === '-') out.push({ uid: m[1], attempted: false });
    else out.push({ uid: m[1], attempted: null, text: cell });
  }
  return out.length ? out : null;
}

export function parseStudentStats(html, { uid }) {
  const root = parse(String(html ?? ''));
  const viewLink = new RegExp(`/student_stats/${uid}/(\\d+)$`);
  const out = [];
  for (const tr of root.querySelectorAll('tr')) {
    if (!tr.querySelector('td.sub-count')) continue;
    const href = tr.querySelectorAll('a').map(a => a.getAttribute('href') || '').find(h => viewLink.test(h));
    if (!href) continue;
    const scoreText = tr.querySelector('td.sub-score')?.text.replace(/\s+/g, '') || '';
    const score = scoreText.match(/^([\d.]+)\/([\d.]+)/);
    out.push({
      attemptId: href.match(viewLink)[1],
      startedAt: parseUsDateTime(tr.querySelector('td.sub-started')?.text),
      completedAt: parseUsDateTime(tr.querySelector('td.sub-completed')?.text),
      score: score ? Number(score[1]) : null,
      maxScore: score ? Number(score[2]) : null,
    });
  }
  return out;
}
