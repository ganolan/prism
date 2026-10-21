import { useState, useEffect } from 'react';
import { FLAGS, flagGuide } from '../lib/flags.js';

// Half the popover's widest (.help-pop max-width 260px) plus an 8px margin, as in HelpDot.
const EDGE = 138;

// One drawing per flag, in a 16 x 16 box, drawn in the disc's glyph color (white on a solid disc,
// red on Missing's white one). The shapes follow Schoology's gradebook flags (#40 design).
const GLYPHS = {
  // Exempt: a circle with a diagonal stroke.
  exempt: (<><circle cx="8" cy="8" r="5.5" /><path d="M4.1 11.9 11.9 4.1" /></>),
  // Late: a clock.
  late: (<><circle cx="8" cy="8" r="6" /><path d="M8 4.6V8l2.4 1.6" /></>),
  // Absent: a person beside a small circle with a diagonal stroke at its bottom left.
  absent: (<>
    <circle cx="10.4" cy="4.4" r="2.1" /><path d="M7.2 13c0-2.5 1.3-4 3.2-4s3.2 1.5 3.2 4" />
    <circle cx="4" cy="11.6" r="2.2" /><path d="M2.5 13.1 5.5 10.1" />
  </>),
  // Incomplete: a half-filled circle.
  incomplete: (<><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 0 0 0 11z" fill="currentColor" /></>),
  // Missing: an exclamation mark.
  missing: (<><path d="M8 3.6v5.4" /><circle cx="8" cy="12" r="0.6" fill="currentColor" /></>),
};

function Disc({ flag }) {
  return (
    <span className="flag-symbol__disc" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {GLYPHS[flag.key]}
      </svg>
    </span>
  );
}

// A Schoology flag as a symbol (#40): a round color-coded disc with the flag's name in tiny
// capitals under it (showName), standing where a grade would. The popover (hover, focus or a
// tap) holds the symbol and name, what the flag does (flagGuide), the reason line Prism wrote and, when it
// kept a copy of the grade the flag removed, where that copy is.
//   size        'cell' (the gradebook cell and the pop-up) or 'inline' (a little smaller, in text)
//   firstName   the student's first name, for the guide line
//   savedLevel  the grade Prism saved before the flag, e.g. "Exhibiting (3.5)"
//   reasonLine  the status line Prism wrote with the flag
//   passive     hover only: the symbol sits inside a control (the gradebook cell is a button) that
//               owns click and focus, so the symbol takes neither
export default function FlagSymbol({ code, size = 'cell', showName = false, firstName = null, savedLevel = null, reasonLine = null, passive = false }) {
  const [pos, setPos] = useState(null);
  const [pinned, setPinned] = useState(false);
  const hide = () => { setPos(null); setPinned(false); };
  useEffect(() => {
    if (!pos) return undefined;
    window.addEventListener('scroll', hide, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', hide, { capture: true });
  }, [pos]);

  const flag = FLAGS[Number(code)];
  if (!flag || code === '' || code == null) return null;

  const show = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const centre = r.left + r.width / 2;
    const vw = window.innerWidth || 0;
    const left = vw > 2 * EDGE ? Math.min(Math.max(centre, EDGE), vw - EDGE) : centre;
    setPos({ left, top: r.bottom + 8 });
  };
  const handlers = passive
    ? { onMouseEnter: show, onMouseLeave: hide }
    : {
      tabIndex: 0,
      onMouseEnter: show,
      onMouseLeave: () => { if (!pinned) setPos(null); },
      onFocus: show,
      onBlur: hide,
      onClick: (e) => { if (pos && pinned) hide(); else { show(e); setPinned(true); } },
      onKeyDown: (e) => { if (e.key === 'Escape') hide(); },
    };

  return (
    <>
      <span className={`flag-symbol flag-symbol--${flag.key} flag-symbol--${size}`} role="img" aria-label={flag.name} {...handlers}>
        <Disc flag={flag} />
        {showName && <span className="flag-symbol__name">{flag.name.toUpperCase()}</span>}
      </span>
      {pos && (
        <span className="help-pop flag-pop" role="tooltip" style={{ left: pos.left, top: pos.top }}>
          <span className="flag-pop__line flag-pop__head">
            <span className={`flag-symbol flag-symbol--${flag.key} flag-symbol--inline`} aria-hidden="true"><Disc flag={flag} /></span>
            <span className="flag-pop__name">{flag.name}</span>
          </span>
          <span className="flag-pop__line">{flagGuide(code, firstName)}</span>
          {reasonLine && <span className="flag-pop__line">{reasonLine}</span>}
          {savedLevel && <span className="flag-pop__line">Grade saved in Prism: {savedLevel}. Clear the flag to restore it.</span>}
        </span>
      )}
    </>
  );
}
