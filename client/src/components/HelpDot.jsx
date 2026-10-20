import { useState, useEffect } from 'react';

// Half the popover's widest (.help-pop max-width 260px) plus an 8px margin: the
// centre is kept at least this far from either edge of a narrow screen.
const EDGE = 138;

// The shared "?" help affordance (docs/design-language.md, `.help-dot` + `.help-pop`):
// an instant popover on hover/focus, placed fixed from the dot so no overflow clips
// it. The full text is also the aria-label, so screen readers don't need the popover.
// A tap (click) shows it too, since a phone has no hover; tapping elsewhere blurs the
// dot and scrolling moves the dot away, and either hides it (#134). `children`, when given, is the
// popover's content (a short list, bold labels); `text` stays the aria-label either way.
export default function HelpDot({ text, children }) {
  const [pos, setPos] = useState(null);
  const show = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const centre = r.left + r.width / 2;
    const vw = window.innerWidth || 0;
    const left = vw > 2 * EDGE ? Math.min(Math.max(centre, EDGE), vw - EDGE) : centre;
    setPos({ left, top: r.bottom + 8 });
  };
  const hide = () => setPos(null);
  useEffect(() => {
    if (!pos) return undefined;
    window.addEventListener('scroll', hide, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', hide, { capture: true });
  }, [pos]);
  return (
    <>
      <span className="help-dot" role="img" tabIndex={0} aria-label={text}
        onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onClick={show}>?</span>
      {pos && <span className="help-pop" style={{ left: pos.left, top: pos.top }} aria-hidden="true">{children ?? text}</span>}
    </>
  );
}
