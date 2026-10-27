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
// wider popover, for a table such as the grade scale's. `clipped` shows it only while the trigger's
// own text is cut off (an ellipsis): a truncated name or title says nothing new when it fits (#199).
export function useHelpPop({ wide = false, clipped = false } = {}) {
  const edge = wide ? WIDE_EDGE : EDGE;
  const [pos, setPos] = useState(null);
  const ref = useRef(null);
  const show = (e) => {
    const t = e.currentTarget;
    if (clipped && t.scrollWidth <= t.clientWidth && t.scrollHeight <= t.clientHeight) return;
    const r = t.getBoundingClientRect();
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

// useHelpPop's handlers without the tap, for a trigger whose own click opens something (a menu, a
// thread, a list): the popover shows on hover and focus only, so it never covers what the click
// opened. Render the popover only while that is closed (FlagsMenu's pill, the comment chip).
export const hoverOnly = ({ onClick: _tap, ...handlers }) => handlers;

// Any element with the instant popover in place of a native `title` (AGENTS.md: hover text is an
// instant popover): `text` is the aria-label and the popover's text, or `pop` is richer popover
// content (a short list). `as` is the element ('span' by default, or 'button', or a component such
// as Link); other props go on it, and its own click, hover, focus and blur handlers still run. A span
// is focusable and named as an image (its short visible code is not what a screen reader should
// read). `named={false}` keeps the element's own name (a button whose visible word is its name, the
// popover only adding to it).
// With no `text` and no `pop` (an optional hint that is empty this time) it is the plain element, with
// no popover. A table cell (`as="td"` or "th") holds its popover inside itself, since a <span> beside
// a <td> is invalid in a <tr> (#199). `clipped` (with `named={false}`, for a name or title cut off by an
// ellipsis) pops only while the text does not fit.
export function Tip({ as: Tag = 'span', text, pop, named = true, clipped = false, children, ...rest }) {
  const { handlers, popover } = useHelpPop({ clipped });
  if (!text && pop == null) return <Tag {...rest}>{children}</Tag>;
  // The element's own handler for the same event (a click, a mouse-leave that disarms a button) runs
  // after the popover's.
  const own = Object.fromEntries(Object.entries(handlers)
    .map(([event, fn]) => [event, rest[event] ? (e) => { fn(e); rest[event](e); } : fn]));
  // An unnamed span (named={false}: text the reader already has, shown in full in the popover, such
  // as a truncated title) stays a plain span.
  const span = Tag === 'span' && named ? { role: 'img', tabIndex: 0 } : {};
  const label = named ? { 'aria-label': text } : {};
  if (Tag === 'td' || Tag === 'th') {
    return <Tag {...label} {...rest} {...own}>{children}{popover(pop ?? text)}</Tag>;
  }
  return (
    <>
      <Tag {...span} {...label} {...rest} {...own}>{children}</Tag>
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
