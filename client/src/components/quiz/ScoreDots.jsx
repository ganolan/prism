// Distribution of students' scores on a fixed 0 to 100% axis. Two views, chosen with a
// Dots / Box toggle that each viewer's browser remembers:
//   dots (default): one dot per student, stacked where scores fall in the same column,
//                   with the median as a dashed line;
//   box:            box and whiskers (quartiles, min to max) with every student's dot over it.
// Hovering a dot shows the student's name and score in a `.help-pop`.
// students: [{ student_id, name, correct, total, percent }].
import { useMemo, useState } from 'react';

export const STORAGE_KEY = 'prism.quiz.scoreChart';
const W = 380, PAD = 16, R = 3.8, STEP = 9, COLUMN = 2 * R + 0.5;
const x = (p) => PAD + (p / 100) * (W - 2 * PAD);

const median = (a) => (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2);

function readMode() {
  try { return localStorage.getItem(STORAGE_KEY) === 'box' ? 'box' : 'dots'; } catch { return 'dots'; }
}

// Quartiles as the medians of the lower and upper halves (Tukey's hinges).
export function boxStats(percents) {
  const s = [...percents].sort((a, b) => a - b);
  const n = s.length;
  return {
    min: s[0], max: s[n - 1], median: median(s),
    q1: median(s.slice(0, Math.max(1, Math.floor(n / 2)))), q3: median(s.slice(Math.ceil(n / 2) - (n === 1 ? 1 : 0))),
  };
}

export default function ScoreDots({ students }) {
  const [mode, setMode] = useState(readMode);
  const [hover, setHover] = useState(null);
  const sorted = useMemo(() => [...(students || [])].sort((a, b) => a.percent - b.percent), [students]);
  // Dots closer than one dot's width share a column and stack upwards.
  const placed = useMemo(() => {
    let colX = null, level = 0;
    return sorted.map(s => {
      const px = x(s.percent);
      if (colX != null && px - colX < COLUMN) level++; else { colX = px; level = 0; }
      return { ...s, cx: colX, level };
    });
  }, [sorted]);
  if (!sorted.length) return null;

  const st = boxStats(sorted.map(s => s.percent));
  const fmt = (p) => `${Math.round(p * 10) / 10}`;
  const tallest = Math.max(...placed.map(d => d.level)) + 1;
  const plotH = mode === 'dots' ? 10 + tallest * STEP : 28;
  const axisY = plotH + 4;
  const mid = 14;
  const cyFor = (d) => (mode === 'dots' ? plotH - 4 - d.level * STEP : mid + ((d.level % 3) - 1) * 5);
  const pick = (m) => {
    setMode(m);
    try { localStorage.setItem(STORAGE_KEY, m); } catch { /* the choice still applies for this visit */ }
  };
  const show = (e, d) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover({ d, left: r.left + r.width / 2, top: r.top - 8 });
  };
  const n = sorted.length;

  return (
    <div className="score-dots">
      <div className="score-dots__toggle" role="group" aria-label="Score chart">
        <button type="button" className={`filter-btn${mode === 'dots' ? ' active' : ''}`} aria-pressed={mode === 'dots'} onClick={() => pick('dots')}>Dots</button>
        <button type="button" className={`filter-btn${mode === 'box' ? ' active' : ''}`} aria-pressed={mode === 'box'} onClick={() => pick('box')}>Box</button>
      </div>
      <svg viewBox={`0 0 ${W} ${axisY + 16}`} width={W} style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
        role="img" aria-label={`MCQ scores of ${n} student${n === 1 ? '' : 's'}: median ${fmt(st.median)}%, range ${st.min} to ${st.max}%`}>
        <line x1={x(0)} x2={x(100)} y1={axisY} y2={axisY} stroke="var(--border)" />
        {[0, 25, 50, 75, 100].map(t => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={axisY} y2={axisY + 3} stroke="var(--text-muted)" />
            <text x={x(t)} y={axisY + 14} fontSize="9" textAnchor="middle" fill="var(--text-muted)">{t}%</text>
          </g>
        ))}
        {mode === 'box' && (
          <g>
            <line x1={x(st.min)} x2={x(st.q1)} y1={mid} y2={mid} stroke="var(--text-muted)" strokeWidth="1.5" />
            <line x1={x(st.q3)} x2={x(st.max)} y1={mid} y2={mid} stroke="var(--text-muted)" strokeWidth="1.5" />
            <line x1={x(st.min)} x2={x(st.min)} y1={mid - 5} y2={mid + 5} stroke="var(--text-muted)" strokeWidth="1.5" />
            <line x1={x(st.max)} x2={x(st.max)} y1={mid - 5} y2={mid + 5} stroke="var(--text-muted)" strokeWidth="1.5" />
            <rect className="score-box" x={x(st.q1)} y={mid - 9} width={Math.max(2, x(st.q3) - x(st.q1))} height="18" rx="3"
              fill="var(--accent-subtle)" stroke="var(--accent)" strokeWidth="1.5" />
            <line x1={x(st.median)} x2={x(st.median)} y1={mid - 9} y2={mid + 9} stroke="var(--accent)" strokeWidth="2.5" />
          </g>
        )}
        {mode === 'dots' && (
          <line x1={x(st.median)} x2={x(st.median)} y1="2" y2={plotH} stroke="var(--text)" strokeWidth="1.5" strokeDasharray="3 2" />
        )}
        {placed.map(d => (
          <circle key={d.student_id} className="score-dot" cx={d.cx} cy={cyFor(d)} r={R}
            fill="var(--accent)" stroke="var(--card-bg)" strokeWidth="1.5"
            aria-label={`${d.name}: ${d.correct}/${d.total} (${d.percent}%)`}
            onMouseEnter={(e) => show(e, d)} onMouseLeave={() => setHover(null)} />
        ))}
      </svg>
      {hover && (
        <span className="help-pop score-dots__pop" style={{ left: hover.left, top: hover.top }} aria-hidden="true">
          <strong>{hover.d.name}</strong> <span>{`${hover.d.correct}/${hover.d.total} (${hover.d.percent}%)`}</span>
        </span>
      )}
    </div>
  );
}
