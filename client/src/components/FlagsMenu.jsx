import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlagDisc } from './FlagSymbol.jsx';
import FlagPanel from './FlagPanel.jsx';
import ClearFlagPanel from './ClearFlagPanel.jsx';
import { FLAGS, FLAG_ORDER, FLAGS_MENU_HEADING, flagGuide, flagEffect, isFlag } from '../lib/flags.js';
import { getGradeFlags, setGradeFlag } from '../services/api.js';
import { useHelpPop } from './HelpDot.jsx';

const MENU_NOTE = 'On graded work, Schoology removes the grade while a flag is set. Prism keeps a copy and offers to restore it when you clear the flag.';
// The page shows Prism's last read; a fresh read that differs means Schoology changed since (a sync
// brings the page up to date). Nothing is written over a grade the teacher has not seen.
const CHANGED = 'Changed in Schoology since Prism last read this task. Sync, then try again.';
export const REFRESH_FAILED = 'Saved, but the page could not refresh. Reload to see it.';
// Errors that come after Schoology took the write: the page must refetch to show the true state.
const AFTER_WRITE = ['READBACK_MISMATCH'];
const MENU_WIDTH = 304; // 19rem
const GUTTER = 16;
// Scrolls this soon after opening are the page settling (focusing an item can scroll), not the
// teacher scrolling away. Found live on prod: the menu closed 16 ms after it opened (#40).
const OPEN_GUARD_MS = 150;
const MOVED_PX = 2; // a scroll that moves the pill less than this leaves the menu where it belongs

const num = (v) => (v == null || v === '' ? null : Number(v));
const sameScore = (x, y) => (x == null || y == null ? x == null && y == null : Math.abs(x - y) < 1e-9);

// The Flags control (#40, spec "The Flags control"): one pill in the style of Schoology's
// gradebook button, on the grade card's header (after Refer) and in Triage's Flags panel rows
// (size "sm", compact). Closed it reads "⚑ Flags ▾", or the set flag's symbol and name in its
// color. Open: the subheading "Flag in Schoology", the five flags in FLAG_ORDER with their lines,
// the set one ticked ("Choose again to clear it."), and a note under a divider. Arrow keys, Enter
// and Escape work the menu.
// Choosing reads the pair fresh from Schoology, then opens FlagPanel (set or change a flag) or,
// for the ticked flag, ClearFlagPanel when Prism kept a copy of the grade (clearing at once when it
// did not). `expected` is what the page loaded, so the server refuses a write over a change.
//   student     { id, firstName }
//   exception   the flag the page loaded (0 or null for none); score the score it loaded;
//               comment the comment it loaded (sent as expected.comment when given)
//   aligned     the task has measurement topics (Missing's line)
//   compact     the closed pill shows only the symbol (the set flag's disc, else ⚑) and the caret,
//               its name kept as the button's accessible name (Triage's Flags panel rows, #174)
//   panelHost   where the panel draws (the card's action-panel row); inline when null
//   beforeWrite()  awaited before each write (the card settles its queued draft save, so a
//               debounced save cannot overwrite a draft the write restores)
//   onChange(result)  after a write (result null after an error that followed the write, such as a
//               read-back mismatch); may return a promise (the page refetching the pair), and the
//               pill stays busy until it settles; a rejection shows "Saved, but the page could not
//               refresh. Reload to see it."
export default function FlagsMenu({ student, assignmentId, exception = 0, score = null, comment, aligned = false, size = 'md', compact = false, panelHost = null, beforeWrite = null, onChange }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [panel, setPanel] = useState(null); // { kind: 'set' | 'clear', code, state }
  const [pos, setPos] = useState(null);
  const pillRef = useRef(null);
  const menuRef = useRef(null);
  const itemRefs = useRef([]);
  const openedRef = useRef({ at: 0, top: 0, left: 0 }); // when the menu opened, and where the pill was

  const current = isFlag(exception) ? Number(exception) : 0;
  const flag = current ? FLAGS[current] : null;
  const firstName = student?.firstName || null;

  // Place the menu under the pill (fixed, so neither the card nor the pop-up clips it): its right
  // edge on the pill's in the card header, its left edge on the pill's in a Triage row (size "sm").
  const placeRef = useRef(() => {});
  placeRef.current = () => {
    if (!pillRef.current) return;
    const r = pillRef.current.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const width = Math.min(MENU_WIDTH, Math.max(0, vw - 2 * GUTTER));
    const left = size === 'sm'
      ? Math.max(GUTTER, Math.min(r.left, vw - GUTTER - width))
      : Math.max(GUTTER, r.right - width);
    // Below the pill when it fits, else above it (a Triage row near the bottom of the window, #174:
    // a fixed menu cannot be scrolled to); with no room either side, the larger side, scrolling
    // inside the menu.
    const vh = window.innerHeight || 0;
    // scrollHeight: the full height even while a max-height from an earlier placement clamps it.
    const height = menuRef.current?.scrollHeight || menuRef.current?.offsetHeight || 0;
    const below = vh - GUTTER - (r.bottom + 4);
    const above = r.top - 4 - GUTTER;
    if (!vh || !height || height <= below) setPos({ left, top: r.bottom + 4, width });
    else if (height <= above) setPos({ left, top: r.top - 4 - height, width });
    else if (above > below) setPos({ left, top: GUTTER, width, maxHeight: above });
    else setPos({ left, top: r.bottom + 4, width, maxHeight: below });
  };
  useLayoutEffect(() => {
    if (open) placeRef.current();
    else setPos(null); // a reopen starts unclamped
  }, [open, size]);

  // Focus the ticked flag, else the first, when the menu opens. preventScroll: focusing must not
  // scroll the page (the scroll would also be read as the teacher scrolling away).
  useEffect(() => {
    if (!open) return;
    const start = Math.max(0, FLAG_ORDER.indexOf(current));
    itemRefs.current[start]?.focus({ preventScroll: true });
  }, [open, current]);

  // A click outside or a scroll that moves the pill closes it.
  useEffect(() => {
    if (!open) return undefined;
    const r = pillRef.current?.getBoundingClientRect();
    openedRef.current = { at: Date.now(), top: r?.top ?? 0, left: r?.left ?? 0 };
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || pillRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = (e) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      const now = pillRef.current?.getBoundingClientRect();
      if (!now) return;
      // The page settling just after opening: the menu follows the pill, and that is where it
      // belongs now (#177; it stayed where the pill had been until the next scroll closed it).
      if (Date.now() - openedRef.current.at < OPEN_GUARD_MS) {
        openedRef.current = { ...openedRef.current, top: now.top, left: now.left };
        placeRef.current();
        return;
      }
      const { top, left } = openedRef.current;
      if (Math.abs(now.top - top) > MOVED_PX || Math.abs(now.left - left) > MOVED_PX) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [open]);

  const close = () => { setOpen(false); pillRef.current?.focus(); };

  // The page refetches the pair; a failed refetch is said beside the pill.
  async function refresh(result) {
    try {
      await onChange?.(result);
    } catch {
      setError((prev) => (prev ? `${prev} ${REFRESH_FAILED}` : REFRESH_FAILED));
    }
  }

  async function write(body) {
    setBusy(true);
    setError(null);
    const expected = { exception: current, score: num(score), ...(typeof comment === 'string' ? { comment } : {}) };
    try {
      await beforeWrite?.();
      const result = await setGradeFlag({ studentId: student.id, assignmentId, expected, ...body });
      setPanel(null);
      // Set, but a later step did not finish: the line in the comment, or the restore.
      const partial = result?.line?.error || result?.restored?.error || null;
      if (partial) setError(partial);
      await refresh(result);
    } catch (err) {
      setError(err.message);
      if (AFTER_WRITE.includes(err.code)) await refresh(null);
    } finally {
      setBusy(false);
    }
  }

  async function choose(code) {
    setOpen(false);
    setPanel(null);
    setError(null);
    setBusy(true);
    try {
      const state = await getGradeFlags(student.id, assignmentId);
      if ((Number(state.exception) || 0) !== current || !sameScore(num(state.score), num(score))) {
        setError(CHANGED);
        return;
      }
      if (code !== current) setPanel({ kind: 'set', code, state });
      else if (state.savedGrade) setPanel({ kind: 'clear', code, state });
      // No copy waiting: clear at once, and never restore unannounced (a copy kept by this clear,
      // e.g. Missing's levels, is offered on the card instead).
      else await write({ code: 0, reason: null, restore: false });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function onMenuKey(e, i) {
    const n = FLAG_ORDER.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      itemRefs.current[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]?.focus({ preventScroll: true });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      itemRefs.current[e.key === 'Home' ? 0 : n - 1]?.focus({ preventScroll: true });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(FLAG_ORDER[i]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      close();
    }
  }

  // The pill's meaning on hover or focus: the instant popover, not a native title (hidden while the menu is open).
  const pillPop = useHelpPop();
  const pillTitle = flag ? `Flag set in Schoology: ${flag.name}. ${flagEffect(current)}` : 'Flag this work in Schoology';
  const pillClass = ['flags-pill', flag && `flags-pill--${flag.key}`, size === 'sm' && 'flags-pill--sm', compact && 'flags-pill--compact', busy && 'flags-pill--busy']
    .filter(Boolean).join(' ');

  return (
    <span className={`flags-control flags-control--${size}`}>
      <button
        type="button" ref={pillRef} className={pillClass}
        aria-haspopup="menu" aria-expanded={open} aria-busy={busy || undefined} disabled={busy}
        aria-label={compact ? pillTitle : undefined}
        onMouseEnter={pillPop.handlers.onMouseEnter} onMouseLeave={pillPop.handlers.onMouseLeave}
        onFocus={pillPop.handlers.onFocus} onBlur={pillPop.handlers.onBlur}
        onClick={() => { if (panel) setPanel(null); else setOpen((o) => !o); }}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
      >
        {flag ? <FlagDisc code={current} /> : <span className="flags-pill__icon" aria-hidden="true">⚑</span>}
        {!compact && <span>{flag ? flag.name : 'Flags'}</span>}
        <span className="flags-pill__caret" aria-hidden="true">▾</span>
      </button>
      {!open && pillPop.popover(pillTitle)}
      {error && <span className="flags-error text-sm" role="alert">{error}</span>}

      {open && (
        <div ref={menuRef} className="flags-menu" role="menu" aria-label="Flags"
          style={pos ? { left: pos.left, top: pos.top, width: pos.width, ...(pos.maxHeight ? { maxHeight: pos.maxHeight, overflowY: 'auto' } : {}) } : undefined}>
          <div className="flags-menu__heading" role="presentation">{FLAGS_MENU_HEADING}</div>
          {FLAG_ORDER.map((code, i) => {
            const f = FLAGS[code];
            const ticked = code === current;
            return (
              <button
                key={code} type="button" role="menuitemradio" aria-checked={ticked} tabIndex={-1}
                ref={(el) => { itemRefs.current[i] = el; }}
                className={`flags-menu__item${ticked ? ' flags-menu__item--ticked' : ''}`}
                onClick={() => choose(code)} onKeyDown={(e) => onMenuKey(e, i)}
              >
                <FlagDisc code={code} />
                <span className="flags-menu__name">{f.name}</span>
                <span className="flags-menu__tick" aria-hidden="true">{ticked ? '✓' : ''}</span>
                <span className="flags-menu__line">{ticked ? 'Choose again to clear it.' : flagGuide(code, firstName, { aligned })}</span>
              </button>
            );
          })}
          <hr className="flags-menu__divider" />
          <p className="flags-menu__note">{MENU_NOTE}</p>
        </div>
      )}

      {panel?.kind === 'set' && (
        <FlagPanel
          key={panel.code} code={panel.code} firstName={firstName} state={panel.state} host={panelHost} busy={busy}
          onCancel={() => setPanel(null)} onConfirm={(reason) => write({ code: panel.code, reason })}
        />
      )}
      {panel?.kind === 'clear' && (
        <ClearFlagPanel
          code={panel.code} savedGrade={panel.state.savedGrade} hasDraft={panel.state.hasDraft} host={panelHost} busy={busy}
          onCancel={() => setPanel(null)} onConfirm={(restore) => write({ code: 0, reason: null, restore })}
        />
      )}
    </span>
  );
}
