import { useState, useEffect } from 'react';

// Half the popover's widest (.help-pop max-width 260px) plus an 8px margin: the
// centre is kept at least this far from either edge of a narrow screen.
const EDGE = 138;

// The instant popover behind HelpDot, for anything else that wants the same one (the roster's gender
// tags and pills): spread `handlers` on the trigger and render `popover(content)` beside it. Placed
// fixed from the trigger so no overflow clips it; a tap (click) shows it too, since a phone has no
// hover; tapping elsewhere blurs the trigger and scrolling moves it away, and either hides it (#134).
export function useHelpPop() {
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
  const handlers = { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide, onClick: show };
  const popover = (content) => pos && <span className="help-pop" style={{ left: pos.left, top: pos.top }} aria-hidden="true">{content}</span>;
  return { handlers, popover };
}

// Any element with the instant popover in place of a native `title` (AGENTS.md: hover text is an
// instant popover): `text` is the aria-label and the popover's text, or `pop` is richer popover
// content (a short list). `as` is the element ('span' by default, or 'button', or a component such
// as Link); other props go on it, and a click of its own still runs. A span is focusable and named
// as an image (its short visible code is not what a screen reader should read). `named={false}` keeps
// the element's own name (a button whose visible word is its name, the popover only adding to it).
export function Tip({ as: Tag = 'span', text, pop, named = true, onClick, children, ...rest }) {
  const { handlers, popover } = useHelpPop();
  const own = onClick ? { ...handlers, onClick: (e) => { handlers.onClick(e); onClick(e); } } : handlers;
  const span = Tag === 'span' ? { role: 'img', tabIndex: 0 } : {};
  return (
    <>
      <Tag {...span} {...(named ? { 'aria-label': text } : {})} {...rest} {...own}>{children}</Tag>
      {popover(pop ?? text)}
    </>
  );
}

// The shared "?" help affordance (docs/design-language.md, `.help-dot` + `.help-pop`):
// an instant popover on hover/focus, placed fixed from the dot so no overflow clips
// it. The full text is also the aria-label, so screen readers don't need the popover.
// A tap (click) shows it too, since a phone has no hover; tapping elsewhere blurs the
// dot and scrolling moves the dot away, and either hides it (#134). `children`, when given, is the
// popover's content (a short list, bold labels); `text` stays the aria-label either way.
export default function HelpDot({ text, children }) {
  const { handlers, popover } = useHelpPop();
  return (
    <>
      <span className="help-dot" role="img" tabIndex={0} aria-label={text} {...handlers}>?</span>
      {popover(children ?? text)}
    </>
  );
}
