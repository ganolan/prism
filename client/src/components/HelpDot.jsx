import { useState, useEffect, useLayoutEffect, useRef } from 'react';

// Half the popover's widest (.help-pop max-width 260px) plus an 8px margin: the
// centre is kept at least this far from either edge of a narrow screen.
const EDGE = 138;
// The same for the wide popover (.help-pop--wide, max-width 340px): the grade scale's chip table.
const WIDE_EDGE = 178;

// The instant popover behind HelpDot, for anything else that wants the same one (the roster's gender
// tags and pills): spread `handlers` on the trigger and render `popover(content)` beside it. Placed
// fixed from the trigger so no overflow clips it; a tap (click) shows it too, since a phone has no
// hover; tapping elsewhere blurs the trigger and scrolling moves it away, and either hides it (#134).
// A popover too tall for the space below its trigger opens above it instead (#193). `wide` gives the
// wider popover, for a table such as the grade scale's.
export function useHelpPop({ wide = false } = {}) {
  const edge = wide ? WIDE_EDGE : EDGE;
  const [pos, setPos] = useState(null);
  const ref = useRef(null);
  const show = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const centre = r.left + r.width / 2;
    const vw = window.innerWidth || 0;
    const left = vw > 2 * edge ? Math.min(Math.max(centre, edge), vw - edge) : centre;
    setPos({ left, top: r.bottom + 8, above: r.top - 8 });
  };
  useLayoutEffect(() => {
    const el = ref.current;
    const vh = window.innerHeight || 0;
    if (!pos || !el || !vh || pos.top + el.offsetHeight <= vh - 8) return;
    el.style.top = `${Math.max(8, pos.above - el.offsetHeight)}px`;
  }, [pos]);
  const hide = () => setPos(null);
  useEffect(() => {
    if (!pos) return undefined;
    window.addEventListener('scroll', hide, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', hide, { capture: true });
  }, [pos]);
  const handlers = { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide, onClick: show };
  const popover = (content) => pos && (
    <span ref={ref} className={wide ? 'help-pop help-pop--wide' : 'help-pop'} style={{ left: pos.left, top: pos.top }} aria-hidden="true">{content}</span>
  );
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
// popover's content (a short list, bold labels); `text` stays the aria-label either way. `wide` gives
// the wider popover (a small table).
export default function HelpDot({ text, wide = false, children }) {
  const { handlers, popover } = useHelpPop({ wide });
  return (
    <>
      <span className="help-dot" role="img" tabIndex={0} aria-label={text} {...handlers}>?</span>
      {popover(children ?? text)}
    </>
  );
}
