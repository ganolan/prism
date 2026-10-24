import { useState } from 'react';
import { setAssessmentPublished } from '../services/api.js';

// Publish or unpublish a task on Schoology (#138): the confirm and the "checked" line, shared by
// the course page's Assessments tab and the assessment page's header toggle (#184).

// The confirm under the control: what the change does to students, then the verb or Cancel.
export function PublishConfirm({ title, published, busy, onConfirm, onCancel }) {
  const verb = published ? 'Publish' : 'Unpublish';
  return (
    <div className="publish-confirm" role="group" aria-label={`${verb} "${title}" on Schoology`}>
      <span className="publish-confirm__q">
        {verb} <b>{title}</b> on Schoology?{' '}
        <span className="publish-confirm__warn">
          {published ? 'Students see it at once.' : 'Students stop seeing it at once.'}
        </span>
      </span>
      <button type="button" className={published ? 'primary' : 'primary danger'} disabled={busy} onClick={onConfirm}>
        {verb}
      </button>
      <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
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
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);

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
        type="button" role="switch" aria-checked={published} aria-expanded={ask}
        className={`publish-toggle${published ? ' publish-toggle--on' : ''}`}
        onClick={() => setAsk((a) => !a)}
      >
        <span className="publish-toggle__track" aria-hidden="true"><span className="publish-toggle__knob" /></span>
        {published ? 'Published' : 'Unpublished'}
      </button>
      {ask && (
        <PublishConfirm title={assignment.title} published={published ? 0 : 1} busy={busy}
          onConfirm={confirm} onCancel={() => setAsk(false)} />
      )}
      {done != null && <PublishDone published={done} />}
      {error && <div className="alert alert-warning publish-error">{error}</div>}
    </>
  );
}
