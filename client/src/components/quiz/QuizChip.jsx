import { useState } from 'react';

// "2 linked tests" chip for a quiz group. Test titles are often long and nearly identical
// (a test and its extra-time copy), so the chip shows only the count; the result task and the
// titles are in a `.help-pop` list that opens immediately on hover or focus (#199: never a native
// title), and a click (a tap on a phone) keeps it open until a second click or the chip loses focus.
export default function QuizChip({ group }) {
  const [pos, setPos] = useState(null);
  if (!group) return null;
  const n = group.members.length;
  const label = `${n} ${group.result ? 'linked' : 'combined'} test${n === 1 ? '' : 's'}`;
  const heading = group.result ? `Result task: ${group.result.title}` : 'Combined tests, not linked to a result task';
  const place = (e, pinned) => {
    const r = e.currentTarget.getBoundingClientRect();
    // Left-aligned, not centred like a help dot's popover: the chip often sits at the content's left edge.
    setPos({ left: r.left, top: r.bottom + 6, pinned });
  };
  const hover = (e) => { if (!pos) place(e, false); };
  const leave = () => setPos((p) => (p?.pinned ? p : null));
  // A tap fires the hover first, so a click on a hover-opened list keeps it open rather than closing it.
  const click = (e) => {
    if (pos?.pinned) setPos(null);
    else place(e, true);
  };
  return (
    <>
      <button type="button" className="badge quiz-chip" aria-expanded={!!pos} onClick={click}
        onMouseEnter={hover} onMouseLeave={leave} onFocus={hover} onBlur={() => setPos(null)}>
        {label} <span aria-hidden="true">▾</span>
      </button>
      {pos && (
        <div className="help-pop quiz-chip-pop" style={{ left: pos.left, top: pos.top, transform: 'none' }}>
          <div className="quiz-chip-pop__heading">{heading}</div>
          <ul className="help-pop__list">
            {group.members.map(m => <li key={m.id}>{m.title}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}
