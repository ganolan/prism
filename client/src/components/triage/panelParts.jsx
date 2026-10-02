import { useState } from 'react';

// Shared pieces of the three triage panels in the rail: the header (title +
// badge left; "All N ▾" toggle and any extra control right), the 5-row limit
// and each row's expand toggle.

export const ROW_LIMIT = 5;

const storageKey = (key) => `prism.triage.showAll.${key}`;

// Storage throws in Safari private mode; a forgotten toggle beats a crashed page.
function remembered(key) {
  try {
    return sessionStorage.getItem(storageKey(key)) === '1';
  } catch {
    return false;
  }
}

// "Show all rows" for one panel, remembered for the session per panel + scope
// (e.g. 'late.all' on the Dashboard, 'late.5' on course 5).
export function useShowAll(key) {
  const [showAll, setShowAll] = useState(() => remembered(key));
  function toggle() {
    const next = !showAll;
    setShowAll(next);
    try {
      sessionStorage.setItem(storageKey(key), next ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
  return [showAll, toggle];
}

// The visible rows: the first ROW_LIMIT (server order = most urgent first) unless showing all.
export const limitRows = (rows, showAll) => (showAll ? rows : rows.slice(0, ROW_LIMIT));

// Header toggle, only when the list is longer than the limit — at the top so it never needs a scroll.
export function ShowAllToggle({ total, showAll, onToggle }) {
  if (total <= ROW_LIMIT) return null;
  return (
    <button type="button" className="ghost accent triage-panel__more" aria-expanded={showAll} onClick={onToggle}>
      {showAll ? 'Fewer ▴' : `All ${total} ▾`}
    </button>
  );
}

export function PanelHead({ title, badge, children }) {
  return (
    <div className="triage-panel__head">
      <h3 className="triage-panel__title">{title} {badge}</h3>
      <div className="triage-panel__head-actions">{children}</div>
    </div>
  );
}

// Which rows of a panel are expanded (several may be open at once).
export function useOpenRows() {
  const [open, setOpen] = useState(() => new Set());
  const isOpen = (key) => open.has(key);
  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return [isOpen, toggle];
}

// The ▾ / ▴ button that shows a row's secondary actions below its text.
export function RowToggle({ label, expanded, controls, onToggle }) {
  return (
    <button
      type="button" className="ghost triage-row__toggle" aria-label={`Actions for ${label}`}
      aria-expanded={expanded} aria-controls={expanded ? controls : undefined} onClick={onToggle}
    >
      <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
    </button>
  );
}

// A row's DOM id for its expanded area, unique per panel.
export const moreId = (panelId, key) => `${panelId}-more-${key}`.replace(/[^\w-]/g, '_');
