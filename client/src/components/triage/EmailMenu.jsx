import { useEffect, useMemo, useRef, useState } from 'react';
import { buildEmailMenu, uniqueAddresses, copiedMessage, mailtoFor } from '../../lib/emailLists.js';

// "@ ▾" in a triage panel header (#137): copies the addresses of students who still
// owe something, by urgency tier or by assessment, as "a@x; b@x" for Outlook's To or
// Bcc. "@" = copy addresses; the row's ✉ (MailLink) = write one email. The menu, the
// "copied" status and the copy-by-hand fallback (no clipboard, or it refused) float
// below the button. Rows are the panel's whole list, not just the visible five.
const STATUS_MS = 5000;

export default function EmailMenu({ kind, rows, showCourse = false }) {
  const menu = useMemo(() => buildEmailMenu(kind, rows, { showCourse }), [kind, rows, showCourse]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [fallback, setFallback] = useState(null); // the address string to copy by hand
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const fieldRef = useRef(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => { if (fallback) fieldRef.current?.select(); }, [fallback]);

  if (menu.tiers.length === 0) return null;

  function say(text) {
    setStatus(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(''), STATUS_MS);
  }

  async function copy(item) {
    setOpen(false);
    setFallback(null);
    const addresses = uniqueAddresses(item.emails);
    if (addresses.length === 0) { say(copiedMessage(0, item.missing)); return; }
    const text = addresses.join('; ');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('No clipboard');
      await navigator.clipboard.writeText(text);
      say(copiedMessage(addresses.length, item.missing));
    } catch {
      clearTimeout(timer.current);
      setStatus('');
      setFallback(text);
    }
  }

  const itemButton = (item) => (
    <button key={item.key} type="button" role="menuitem" className="ghost email-menu__item" onClick={() => copy(item)}>
      {item.label} ({item.students})
    </button>
  );

  return (
    <div className="email-menu" ref={wrapRef}>
      <button
        ref={buttonRef} type="button" className="ghost accent triage-panel__more"
        aria-label="Copy student emails" title="Copy student emails"
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
      >
        @ ▾
      </button>
      {open && (
        <div className="email-menu__pop" role="menu" aria-label="Copy student emails">
          {menu.tiers.map(itemButton)}
          {menu.byAssessment.length > 0 && (
            <>
              <div className="email-menu__group" role="presentation">By assessment</div>
              {menu.byAssessment.map(itemButton)}
            </>
          )}
        </div>
      )}
      <p className="email-menu__status" role="status">{status}</p>
      {fallback && (
        <div className="email-menu__bubble">
          <span>Copy these addresses:</span>
          <input
            ref={fieldRef} readOnly value={fallback} aria-label="Addresses to copy"
            className="email-menu__field" onFocus={(e) => e.target.select()}
          />
          <button type="button" className="ghost" onClick={() => setFallback(null)}>Close</button>
        </div>
      )}
    </div>
  );
}

// A row's ✉: opens the mail app to that one student, subject prefilled.
export function MailLink({ row, kind }) {
  const href = mailtoFor(row, kind);
  if (!href) return null;
  const label = `Email ${row.studentName}`;
  return <a className="triage-row__mail" href={href} aria-label={label} title={label}>✉</a>;
}
