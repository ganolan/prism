import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { previewStatusLine } from '../services/api.js';
import { composeComment, plainLine, isPlainLine } from '../lib/statusLines.js';

// The confirm step before Prism writes to a student's Schoology comment (triage
// resubmissions spec, Amendment B → "Status lines" → confirm modal). Every
// status-line action (Ask, Extend, Grade stands, extensions, Undo) goes through
// it; Cancel / Escape / a backdrop press never call a write API.
//
// It reads the student's comment fresh once (previewStatusLine), then composes the
// resulting comment locally with the same composeComment the server publishes with
// (client/src/lib/statusLines.js mirrors server/lib/statusLines.js), so editing the
// line updates the preview instantly without another Schoology read per keystroke.
//
// Publish mode: editable one-line `defaultLine` (or `loadDefaultLine()` when the
// line needs the server first — e.g. its due date), onConfirm(line).
// removeMode (Undo): a "Remove Prism's line" checkbox (default on), onConfirm(checked);
// `undoSource` ({ sourceType, sourceId }) is the record being undone — the server only
// removes the stored line if that record published it.
//
// Focus: moves into the dialog on open (the line, or the dialog itself in removeMode —
// never the primary button), Tab is trapped inside, and focus returns on close.
// Parents give each action its own `key`, so a new action always remounts it.
const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export default function StatusLineModal({
  studentName, studentId, assignmentId, title, consequence,
  defaultLine = '', loadDefaultLine = null, confirmLabel, removeMode = false, undoSource = null,
  onConfirm, onCancel,
}) {
  const [line, setLine] = useState(loadDefaultLine ? '' : defaultLine);
  const [lineReady, setLineReady] = useState(!loadDefaultLine);
  const [preview, setPreview] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [remove, setRemove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // { message, published }
  const inFlight = useRef(false);
  const dialogRef = useRef(null);
  const lineRef = useRef(null);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    (async () => {
      try {
        let first = line;
        if (!lineReady) {
          first = await loadDefaultLine();
          if (!live) return;
          setLine(first);
          setLineReady(true);
        }
        const p = await previewStatusLine({ studentId, assignmentId, line: removeMode ? '' : first.trim() });
        if (live) setPreview(p);
      } catch (err) {
        if (live) setLoadError(err.message);
      }
    })();
    return () => { live = false; };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus in on open, back where it was on close.
  useEffect(() => {
    const previous = document.activeElement;
    (removeMode ? dialogRef.current : lineRef.current)?.focus();
    return () => { if (previous?.isConnected) previous.focus?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { if (!busy) onCancel(); };
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Tab never leaves the dialog: wrap at either end.
  function trapTab(e) {
    if (e.key !== 'Tab') return;
    const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = items.includes(active);
    if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
  }

  // What the server will store and publish: plain ASCII (typographic characters
  // normalised, as server checkLine does); anything else non-ASCII blocks publishing.
  const text = plainLine(line).trim();
  const notPlain = !removeMode && !isPlainLine(text);
  const current = preview?.currentComment ?? '';
  const stored = preview?.storedLine ?? null;
  const withoutLine = composeComment(current, stored, '');
  const nothingToRemove = removeMode && preview && withoutLine === current.replace(/\r\n/g, '\n');
  // The stored line was published by another record's action → this undo leaves it.
  const notOurs = removeMode && preview && !nothingToRemove && undoSource && !(
    preview.storedSource
    && preview.storedSource.sourceType === undoSource.sourceType
    && Number(preview.storedSource.sourceId) === Number(undoSource.sourceId)
  );
  const willRemove = remove && !nothingToRemove && !notOurs;
  const resulting = removeMode ? (willRemove ? withoutLine : current) : composeComment(current, stored, text);
  const canConfirm = Boolean(preview) && !busy && !error?.published && (removeMode || (text !== '' && !notPlain));

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(removeMode ? remove : text);
    } catch (err) {
      setError({ message: err.message, published: Boolean(err.published) });
      setBusy(false);
    } finally {
      inFlight.current = false;
    }
  }

  const heading = removeMode ? `Undo — ${studentName}'s Schoology comment` : `Publish to ${studentName}'s Schoology comment`;
  let sub = 'Visible to the student (and parents) as soon as you publish.';
  if (removeMode) sub = willRemove ? 'Changes their Schoology comment.' : 'Nothing in Schoology changes.';
  return createPortal(
    // Backdrop press closes — on mousedown on the backdrop itself, so a text selection
    // dragged out of the textarea doesn't dismiss the confirm.
    <div className="modal-overlay status-line-modal__overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div
        ref={dialogRef} tabIndex={-1} onKeyDown={trapTab}
        className="modal-content status-line-modal" role="dialog" aria-modal="true" aria-labelledby="status-line-modal-title"
      >
        <h3 id="status-line-modal-title" className="status-line-modal__title">{heading}</h3>
        {title && <div className="status-line-modal__task text-sm text-muted">{title}</div>}
        <p className="status-line-modal__sub">{sub}</p>
        {consequence && <p className="status-line-modal__consequence">{consequence}</p>}

        {removeMode ? (
          <label className="status-line-modal__check">
            <input type="checkbox" checked={remove} disabled={busy} onChange={(e) => setRemove(e.target.checked)} />
            Remove Prism&apos;s line from their comment
          </label>
        ) : (
          <label className="status-line-modal__field">
            <span className="text-sm text-muted">Status line (first line of their comment)</span>
            <textarea
              ref={lineRef} aria-label="Status line" rows={2} value={line} readOnly={busy || !lineReady}
              // One line only: the stored line must stay the comment's whole first line.
              onChange={(e) => setLine(e.target.value.replace(/[\r\n]+/g, ' '))}
            />
          </label>
        )}

        {notPlain && (
          <div className="alert alert-warning" role="alert">Use plain characters in the status line</div>
        )}
        {loadError && (
          <div className="alert alert-warning" role="alert">
            {loadError} <button type="button" className="ghost btn-sm" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
          </div>
        )}
        {!preview && !loadError && <p className="text-sm text-muted">Reading their comment from Schoology…</p>}
        {preview?.hiddenWarning && !removeMode && (
          <div className="alert alert-warning" role="alert">
            Their comment is hidden from the student. Publishing turns Display on, so your current hidden comment
            (below) becomes visible to the student and parents — edit or remove it in Schoology first if it isn&apos;t for them.{' '}
            <button type="button" className="ghost btn-sm" onClick={() => setAttempt((n) => n + 1)}>Re-read from Schoology</button>
          </div>
        )}
        {preview && (
          <>
            <div className="text-sm text-muted status-line-modal__label">Their comment will read:</div>
            <div className="status-line-modal__preview" role="region" aria-label="Their comment will read">
              {!removeMode && text && resulting.startsWith(text) ? (
                <><mark className="status-line-modal__new">{text}</mark>{resulting.slice(text.length)}</>
              ) : resulting}
            </div>
            {nothingToRemove && (
              <p className="text-sm text-muted">Prism&apos;s line isn&apos;t in their comment any more — there is nothing to remove.</p>
            )}
            {notOurs && (
              <p className="text-sm text-muted">Prism&apos;s current line belongs to a different action — it will stay.</p>
            )}
            {removeMode && willRemove && !undoSource && (
              <p className="text-sm text-muted">Removed only if it is still the line this action published, unchanged.</p>
            )}
          </>
        )}

        {error && (
          <div className={`alert ${error.published ? 'alert-error' : 'alert-warning'}`} role="alert">
            {error.published && (
              <strong>{removeMode ? 'Changed in Schoology — not recorded in Prism' : 'Published to Schoology — not recorded in Prism'}</strong>
            )}
            <div>{error.message}</div>
          </div>
        )}

        <div className="status-line-modal__actions">
          {error?.published ? (
            <button type="button" className="secondary" onClick={onCancel}>Close</button>
          ) : (
            <>
              <button type="button" className="ghost" disabled={busy} onClick={close}>Cancel</button>
              <button type="button" className="primary" disabled={!canConfirm} onClick={confirm}>
                {busy ? (removeMode ? 'Working…' : 'Publishing…') : confirmLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
