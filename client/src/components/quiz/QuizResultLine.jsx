// The quiz line on a result task's Grading card (spec §8, §13): the student's MCQ score and FRQ
// levels, live from Prism's copy. When the overall suggestion's comment no longer matches the
// numbers or the template, "Numbers changed" with Update numbers rebuilds it.
import { useState } from 'react';

const frqText = (f) => {
  if (!f.confirmed) return f.reason;
  if (!f.has_rubric) return `${f.points}/${f.max_points}`;
  return f.levels.map(l => l.level).join(' / ');
};

export function quizLineText(r) {
  const parts = [];
  if (r.mcq) parts.push(`MCQ ${r.mcq.correct}/${r.mcq.total} (${r.mcq.percent}%)`);
  if (r.frq?.length) parts.push(`FRQ ${r.frq.map(f => `Q${f.question}: ${frqText(f)}`).join(', ')}`);
  return parts.join(', ');
}

export default function QuizResultLine({ result, onRebuild }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!result) return null;
  async function rebuild() {
    setBusy(true); setError(null);
    try { await onRebuild(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <span className="quiz-result-line">
      <span>{quizLineText(result)}</span>
      {result.overall?.stale && (result.overall.edited ? (
        // The teacher reworded the comment on the Feedback page: flag it, never overwrite it.
        <span className="badge badge-amber" title="The numbers changed after the comment was edited on the Feedback page. Update the numbers there.">Numbers changed</span>
      ) : (
        <>
          <span className="badge badge-amber" title="The suggested comment shows older numbers, or an older template">Numbers changed</span>
          <button className="ghost accent" disabled={busy} onClick={rebuild}>Update numbers</button>
        </>
      ))}
      {error && <span className="badge badge-red">{error}</span>}
    </span>
  );
}
