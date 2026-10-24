import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { setAssessmentPublished } from '../services/api.js';

// Publish or unpublish a task on Schoology (#138): the confirm and the "checked" line, shared by
// the course page's Assessments tab and the assessment page's header toggle (#184).

const GAP = 6; // px between the control and its popover
const EDGE = 8; // px kept clear of the window's edges

// The confirm, as a small popover at the control that opened it (Graham, 24 Oct 2026: a bar across
// the page put the Publish button far from the switch). Below the control, or above it when the
// window has no room below; kept inside the window. Escape or a click outside closes it.
export function PublishConfirm({ anchor, title, published, busy, onConfirm, onCancel }) {
  const verb = published ? 'Publish' : 'Unpublish';
  const ref = useRef(null);
  const confirmRef = useRef(null);
  const [place, setPlace] = useState(null);

  useLayoutEffect(() => {
    function placeIt() {
      const pop = ref.current;
      if (!anchor || !pop) return;
      const a = anchor.getBoundingClientRect();
      const { width, height } = pop.getBoundingClientRect();
      const below = a.bottom + GAP + height <= window.innerHeight - EDGE || a.top - GAP - height < EDGE;
      const top = below ? a.bottom + GAP : a.top - GAP - height;
      const left = Math.max(EDGE, Math.min(a.left, window.innerWidth - EDGE - width));
      setPlace({ top, left, above: !below });
    }
    placeIt();
    window.addEventListener('resize', placeIt);
    window.addEventListener('scroll', placeIt, true);
    return () => {
      window.removeEventListener('resize', placeIt);
      window.removeEventListener('scroll', placeIt, true);
    };
  }, [anchor]);

  useEffect(() => {
    confirmRef.current?.focus();
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || anchor?.contains(e.target)) return;
      onCancel();
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCancel();
      anchor?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onCancel]);

  return (
    <div
      ref={ref} className={`publish-pop${place?.above ? ' publish-pop--above' : ''}`}
      role="group" aria-label={`${verb} "${title}" on Schoology`}
      style={place ? { top: place.top, left: place.left } : { visibility: 'hidden', top: 0, left: 0 }}
    >
      <p className="publish-pop__warn">
        {published ? 'Students see it immediately.' : 'Students stop seeing it immediately.'}
      </p>
      <div className="publish-pop__actions">
        <button ref={confirmRef} type="button" className={`btn-sm ${published ? 'primary' : 'primary danger'}`} disabled={busy} onClick={onConfirm}>
          {verb}
        </button>
        <button type="button" className="btn-sm ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// After the write: the state Schoology read back.
export function PublishDone({ published }) {
  return (
    <div role="status" className="publish-done">
      {published ? 'Published' : 'Unpublished'} on Schoology (checked).
    </div>
  );
}

// The assessment page's header toggle (#184): a switch showing the task's published state, which
// asks before it changes it. `onChange(published)` gets the state Schoology read back.
export default function PublishToggle({ courseId, assignment, onChange }) {
  const published = Number(assignment.published) === 1;
  const toggleRef = useRef(null);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);

  const closeAsk = useCallback(() => setAsk(false), []);

  async function confirm() {
    setBusy(true);
    const want = published ? 0 : 1;
    try {
      const r = await setAssessmentPublished(courseId, assignment.id, want);
      const now = r?.published ?? want;
      onChange?.(now);
      setError(null);
      setDone(now);
      setTimeout(() => setDone(null), 5000);
    } catch (err) {
      setError(`Couldn't ${want ? 'publish' : 'unpublish'} "${assignment.title}": ${err.message}`);
    } finally {
      setBusy(false);
      setAsk(false);
    }
  }

  return (
    <>
      <button
        ref={toggleRef}
        type="button" role="switch" aria-checked={published} aria-expanded={ask}
        className={`publish-toggle${published ? ' publish-toggle--on' : ''}`}
        onClick={() => setAsk((a) => !a)}
      >
        <span className="publish-toggle__track" aria-hidden="true"><span className="publish-toggle__knob" /></span>
        {published ? 'Published' : 'Unpublished'}
      </button>
      {ask && (
        <PublishConfirm anchor={toggleRef.current} title={assignment.title} published={published ? 0 : 1} busy={busy}
          onConfirm={confirm} onCancel={closeAsk} />
      )}
      {done != null && <PublishDone published={done} />}
      {error && <div className="alert alert-warning publish-error">{error}</div>}
    </>
  );
}
