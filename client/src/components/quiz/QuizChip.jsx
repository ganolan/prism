import { useState } from 'react';

// "2 linked tests" chip for a quiz group. Test titles are often long and nearly identical
// (a test and its extra-time copy), so the chip shows only the count; the titles are in
// the hover title and in a `.help-pop` list that a click opens.
export default function QuizChip({ group }) {
  const [pos, setPos] = useState(null);
  if (!group) return null;
  const n = group.members.length;
  const label = `${n} ${group.result ? 'linked' : 'combined'} test${n === 1 ? '' : 's'}`;
  const heading = group.result ? `Result task: ${group.result.title}` : 'Combined tests, not linked to a result task';
  const toggle = (e) => {
    if (pos) { setPos(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ left: r.left + r.width / 2, top: r.bottom + 6 });
  };
  return (
    <>
      <button type="button" className="badge quiz-chip" aria-expanded={!!pos} onClick={toggle} onBlur={() => setPos(null)}
        title={[heading, ...group.members.map(m => m.title)].join('\n')}>
        {label} <span aria-hidden="true">▾</span>
      </button>
      {pos && (
        <ul className="help-pop quiz-chip-pop" style={{ left: pos.left, top: pos.top }}>
          {group.members.map(m => <li key={m.id}>{m.title}</li>)}
        </ul>
      )}
    </>
  );
}
