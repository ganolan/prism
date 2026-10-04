import { useEffect, useState } from 'react';
import { getReferrals, undoReferral, getExtensions, undoExtension, getResubmissions, undoResubmission } from '../../services/api.js';
import { formatDate } from '../../lib/formatDate.js';
import CourseLine from './CourseLine.jsx';
import StatusLineModal from '../StatusLineModal.jsx';

// SQLite UTC 'YYYY-MM-DD HH:MM:SS'. A re-extended extension dates from its updatedAt.
// Resubmission history rows carry updatedAt/closedAt/createdAt instead (see `recordedAt` below).
const recordedAt = (r) => r.updatedAt || r.closedAt || r.createdAt;
const recordedOn = (r) => formatDate(`${recordedAt(r).replace(' ', 'T')}Z`);

const RESUB_LABEL = {
  asked: (r) => `Asked${r.until ? ` · by ${formatDate(`${r.until}T00:00:00`)}` : ''}`,
  grade_stands: () => 'Missed deadline · grade stands',
  done: () => 'Resubmitted · feedback given',
  undone: () => 'Undone',
  closed: () => 'Closed',
};
const resubLabel = (r) => (RESUB_LABEL[r.outcome] ?? (() => r.outcome))(r);
// A grade-stands record's close note is the outcome itself — don't repeat it.
const extraText = (r) => (r.kind === 'resubmission' && r.outcome === 'grade_stands' ? r.note : (r.closeNote || r.note));

// Records whose action may have published a status line to the student's Schoology
// comment: Undo offers to remove it (StatusLineModal removeMode, default on).
const mayHaveLine = (r) => r.kind === 'extension' || (r.kind === 'resubmission' && ['asked', 'grade_stands'].includes(r.outcome));

function undoConsequence(r) {
  if (r.kind === 'extension') return 'Deletes this extension from Prism.';
  // Undo reverses the last action: "grade stands" reopens the request.
  if (r.outcome === 'grade_stands') return 'Reopens this request.';
  // Unsubmitted OneDrive work: an open ask is closed, not deleted (so the next sync
  // doesn't re-add a request); the work stays unsubmitted (Prism never re-submits).
  if (r.ltiState === 'in_progress') return 'Closes this request in Prism. Their work stays unsubmitted in Schoology.';
  // An auto-added (Schoology Unsubmit) request is closed, not deleted, by Undo.
  if (r.source === 'schoology_unsubmit') return 'Closes this resubmission request in Prism.';
  return 'Deletes this resubmission record from Prism.';
}

// Referrals and deadline extensions (mode 'late', the default), or resubmission
// records (mode 'resubmissions'), newest first, each undoable.
// `version` bumps when the parent records one, so an open history reloads.
export default function ReferralHistory({ mode = 'late', courseId, version = 0, onClose, onChanged }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loadErrors, setLoadErrors] = useState([]);
  const resub = mode === 'resubmissions';

  // Each half loads independently: a failed one shows its own error, the other still lists.
  async function load() {
    if (resub) {
      try {
        const list = await getResubmissions({ courseId });
        setLoadErrors([]);
        setRows((list || []).map((r) => ({ ...r, kind: 'resubmission' }))
          .sort((x, y) => recordedAt(y).localeCompare(recordedAt(x))));
      } catch (err) {
        setLoadErrors([`Couldn't load resubmissions: ${err.message}`]);
        setRows([]);
      }
      return;
    }
    const [referrals, extensions] = await Promise.allSettled([getReferrals({ courseId }), getExtensions({ courseId })]);
    const ok = (res, kind) => (res.status === 'fulfilled' ? (res.value || []).map((r) => ({ ...r, kind })) : []);
    setLoadErrors([
      referrals.status === 'rejected' && `Couldn't load referrals: ${referrals.reason?.message}`,
      extensions.status === 'rejected' && `Couldn't load extensions: ${extensions.reason?.message}`,
    ].filter(Boolean));
    setRows([...ok(referrals, 'referral'), ...ok(extensions, 'extension')]
      .sort((x, y) => recordedAt(y).localeCompare(recordedAt(x))));
  }
  useEffect(() => { load(); }, [courseId, version, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const [confirming, setConfirming] = useState(null); // a row whose Undo is in the confirm
  const undoCall = (r, opts) => (r.kind === 'extension' ? undoExtension(r.id, opts)
    : r.kind === 'resubmission' ? undoResubmission(r.id, opts) : undoReferral(r.id));

  async function refresh() {
    await load();
    onChanged?.();
  }

  // Prism-only undo (referrals; resubmission records whose action wrote no line).
  async function undo(r) {
    try {
      await undoCall(r);
      setError(null);
    } catch (err) {
      setError(`Undo failed: ${err.message}`);
      return;
    }
    await refresh();
  }

  // Through the confirm: errors stay in the modal; a Schoology change that Prism
  // then failed to record still refreshes the lists.
  async function confirmUndo(removeLine) {
    try {
      await undoCall(confirming, { removeLine });
    } catch (err) {
      if (err.published) refresh();
      throw err;
    }
    setConfirming(null);
    setError(null);
    await refresh();
  }

  return (
    <section className="card triage-history" aria-label={resub ? 'Resubmission history' : 'Referral history'}>
      <div className="triage-panel__head">
        <h3 className="triage-panel__title">{resub ? 'Resubmissions' : 'Referred / extended'}</h3>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
      {error && <div className="alert alert-warning">{error}</div>}
      {loadErrors.map((msg) => <div key={msg} className="alert alert-warning">{msg}</div>)}
      {rows === null && <p className="text-sm text-muted">Loading…</p>}
      {rows?.length === 0 && loadErrors.length === 0 && (
        <p className="text-sm text-muted">{resub ? 'No resubmission records yet.' : 'No referrals or extensions recorded yet.'}</p>
      )}
      {rows?.map((r) => (
        <div key={`${r.kind}:${r.id}`} className="triage-row triage-row--history">
          <div className="triage-row__text">
            <span className="triage-row__name" title={r.studentName}>{r.studentName}</span>
            <CourseLine row={r} />
            <div className="triage-row__task" title={r.title}>{r.title}</div>
          </div>
          <div className="triage-row__actions">
            {r.kind === 'referral' && <span className="badge badge-red">Referred · day {r.day}</span>}
            {r.kind === 'extension' && <span className="badge badge-gray">Extended +{r.lessons} → {formatDate(`${r.until}T00:00:00`)}</span>}
            {r.kind === 'resubmission' && <span className="badge badge-resubmit">{resubLabel(r)}</span>}
            <span className="text-sm text-muted">{recordedOn(r)}{extraText(r) ? `: ${extraText(r)}` : ''}</span>
            <button className="ghost" onClick={() => (mayHaveLine(r) ? setConfirming(r) : undo(r))}>Undo</button>
          </div>
        </div>
      ))}
      {confirming && (
        <StatusLineModal
          key={`${confirming.kind}:${confirming.id}`}
          removeMode studentName={confirming.studentName} studentId={confirming.studentId}
          assignmentId={confirming.assignmentId} title={confirming.title}
          undoSource={{ sourceType: confirming.kind, sourceId: confirming.id }}
          consequence={undoConsequence(confirming)}
          confirmLabel="Undo" onConfirm={confirmUndo} onCancel={() => setConfirming(null)}
        />
      )}
    </section>
  );
}
