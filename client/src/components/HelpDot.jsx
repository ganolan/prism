import { useState } from 'react';

// The shared "?" help affordance (docs/design-language.md, `.help-dot` + `.help-pop`):
// an instant popover on hover/focus, placed fixed from the dot so no overflow clips
// it. The full text is also the aria-label, so screen readers don't need the popover.
export default function HelpDot({ text }) {
  const [pos, setPos] = useState(null);
  const show = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ left: r.left + r.width / 2, top: r.bottom + 8 });
  };
  const hide = () => setPos(null);
  return (
    <>
      <span className="help-dot" role="img" tabIndex={0} aria-label={text}
        onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>?</span>
      {pos && <span className="help-pop" style={{ left: pos.left, top: pos.top }} aria-hidden="true">{text}</span>}
    </>
  );
}
