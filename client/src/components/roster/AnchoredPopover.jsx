import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GUTTER = 16; // the pop-up stays this far inside the window
const GAP = 6; // between the anchor and the pop-up

// The Roster tab's pop-ups (#160): portalled to <body> and placed `position: fixed` from the anchor
// (the comment popover's pattern, SubmissionComments.jsx), so no card or overflow clips it. Below the
// anchor, or above it when there is more room there; always inside a 16px gutter, scrolling inside
// itself when taller than the room. Escape or a press outside closes it (a press on the anchor is
// left to the anchor, which toggles it). `title` heads it and names the dialog, with a Close button.
export default function AnchoredPopover({ anchor, onClose, title, width = 360, children }) {
  const pop = useRef(null);
  const [pos, setPos] = useState(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const place = useCallback(() => {
    if (!anchor || !pop.current) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 2 * GUTTER);
    const h = pop.current.scrollHeight;
    const below = vh - GUTTER - (r.bottom + GAP);
    const above = r.top - GAP - GUTTER;
    const up = h > below && above > below;
    const maxHeight = Math.max(120, up ? above : below);
    const next = {
      left: Math.max(GUTTER, Math.min(r.left, vw - w - GUTTER)),
      top: up ? Math.max(GUTTER, r.top - GAP - Math.min(h, maxHeight)) : r.bottom + GAP,
      width: w,
      maxHeight,
    };
    setPos((p) => (p && Object.keys(next).every((k) => p[k] === next[k]) ? p : next));
  }, [anchor, width]);

  useLayoutEffect(() => { place(); });

  useEffect(() => {
    pop.current?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      closeRef.current();
      anchor?.focus?.();
    };
    const onDown = (e) => {
      if (pop.current?.contains(e.target) || anchor?.contains?.(e.target)) return;
      closeRef.current();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true, capture: true });
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, { capture: true });
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [anchor, place]);

  return createPortal(
    <div ref={pop} className="roster-pop" role="dialog" aria-label={title} tabIndex={-1}
      style={pos || { left: 0, top: 0, width: Math.min(width, window.innerWidth - 2 * GUTTER), visibility: 'hidden' }}>
      <div className="roster-pop__head">
        <strong>{title}</strong>
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </div>
      {children}
    </div>,
    document.body,
  );
}
