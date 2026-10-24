import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import UrgencyRing from '../triage/UrgencyRing.jsx';
import ExtendEditor, { ExtensionTag } from '../triage/ExtendEditor.jsx';
import { MailLink } from '../triage/EmailMenu.jsx';
import ReferPanel, { canClearInSchoology } from '../ReferPanel.jsx';
import FlagsMenu, { REFRESH_FAILED } from '../FlagsMenu.jsx';
import { FlagDisc } from '../FlagSymbol.jsx';
import { useTriageActions } from '../../hooks/useTriageActions.js';
import { studentRows, withHeld, rowWhen, flagOnRow } from '../../lib/needsAttention.js';
import { assessmentLink } from '../../lib/triage.js';
import { formatDate } from '../../lib/formatDate.js';

// The Roster tab's Needs attention mode (#160, spec "Needs attention"), shown only with Private
// details on: the students with at least one triage row in this course, most urgent first, each as
// the Roster card with its rows under a thin divider; then everyone else as plain cards.
// The rows are triage's own (CoursePage's getTriage answer, as the rail reads it: lib/needsAttention.js),
// and the actions are the rail's (useTriageActions, ReferPanel, ExtendEditor, FlagsMenu), with the
// rail's rules:
//  - overdue work: Extend and Email, and Refer once at the limit (ReferPanel, which can also write IE
//    and Missing in Schoology);
//  - late work handed in at the limit: Refer (recorded immediately) and Waive (with a note);
//  - a make-up test: Extend and Email;
//  - a resubmission: Email; a flag row: Email and the Flags panel's FlagsMenu.
// A row an action took off triage stays in its place with what was done and Undo, until the mode
// is left. The task title opens the task with this student's card in view and the Needs action
// filter on.
// Props: triage, active (enrolled students), gradebook (for the Missing flag on overdue work),
// archived, card(student, { children }) (RosterTab's Roster card), onChanged (re-read triage),
// onFlagChanged (re-read the gradebook too, after a write that changed a Schoology flag).

const MAIL_KIND = {
  overdue: 'late', late_at_limit: 'late', make_up: 'makeUps',
  resub_pending: 'resubmissions', resub_overdue: 'resubmissions', incomplete: 'flags', absent: 'flags',
};
const MISSING = 3;
const taskLink = (r) => assessmentLink(r, { studentId: r.studentId, filter: ['action'] });
const until = (iso) => formatDate(`${iso}T00:00:00`);

// What an action left on a held row: the rail's words and badge tones (ReferralHistory).
function DoneBadge({ done }) {
  if (done.action === 'waived') return <span className="badge badge-gray">Referral waived</span>;
  if (done.action === 'extended') return <span className="badge badge-gray">Extended to {until(done.record.until)}</span>;
  return <span className="badge badge-red">Referred</span>;
}

function AttentionRow({ entry, done, gradebook, actions, onChanged, onFlagChanged, onError }) {
  const r = entry.row;
  const [open, setOpen] = useState(null); // 'refer' | 'extend' | 'waive' | 'undo' (a referral's ReferPanel)
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [panelError, setPanelError] = useState(null);
  const [host, setHost] = useState(null); // where FlagsMenu draws its panel
  const red = entry.tone === 'red';
  const toggle = (what) => { setOpen((cur) => (cur === what ? null : what)); setPanelError(null); };
  const missing = entry.kind === 'overdue' && flagOnRow(gradebook, r) === MISSING;
  const flagRow = entry.kind === 'incomplete' || entry.kind === 'absent';

  // ReferPanel's confirm (Refer on overdue work, or Undo of a referral that wrote IE and Missing):
  // a refusal shows in the panel. The write is done before the refresh, so a failed refresh (CoursePage
  // throws when the gradebook read fails) shows in the list's message, not the closed panel.
  async function viaPanel(run, schoology) {
    setBusy(true);
    setPanelError(null);
    try {
      await run(schoology);
      setOpen(null);
      if (schoology) Promise.resolve(onFlagChanged?.()).catch(() => onError(REFRESH_FAILED));
    } catch (err) {
      setPanelError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    const rec = done.record;
    if (done.kind === 'referral' && canClearInSchoology(rec.schoologyMark)) { toggle('undo'); return; }
    try {
      await actions.undo(r, done);
    } catch (err) {
      onError(`Undo failed: ${err.message}`);
    }
  }

  const mail = <MailLink row={r} kind={MAIL_KIND[entry.kind]} className="roster-attention__email">Email</MailLink>;
  let buttons;
  if (done) {
    buttons = (
      <>
        <DoneBadge done={done} />
        <button type="button" className="ghost accent" aria-expanded={open === 'undo' ? true : undefined} onClick={undo}>Undo</button>
      </>
    );
  } else if (entry.kind === 'late_at_limit') {
    buttons = (
      <>
        <button type="button" className="primary danger btn-sm" title="Mark referred" onClick={() => actions.record(r, 'referred')}>Refer</button>
        <button type="button" className="secondary btn-sm" title="Don't refer: record why" aria-expanded={open === 'waive'}
          onClick={() => { setNote(''); toggle('waive'); }}>Waive</button>
      </>
    );
  } else if (entry.kind === 'overdue' || entry.kind === 'make_up') {
    buttons = (
      <>
        {entry.kind === 'overdue' && red && (
          <button type="button" className="primary danger btn-sm" title="Mark referred" aria-expanded={open === 'refer'} onClick={() => toggle('refer')}>Refer</button>
        )}
        <button type="button" className="secondary btn-sm" aria-expanded={open === 'extend'} onClick={() => toggle('extend')}>Extend</button>
        {mail}
      </>
    );
  } else {
    buttons = (
      <>
        {mail}
        {flagRow && (
          <FlagsMenu compact size="sm" student={{ id: r.studentId, firstName: r.firstName }} assignmentId={r.assignmentId}
            exception={r.exception} score={r.score} aligned={r.aligned} panelHost={host} onChange={onFlagChanged ?? onChanged} />
        )}
      </>
    );
  }

  return (
    <div className="roster-attention-row">
      <UrgencyRing day={entry.day} limit={entry.limit} tone={entry.tone} approx={r.approx} size={28} />
      <div className="roster-attention-row__text">
        <div className="roster-attention-row__line">
          <span className={`roster-attention-row__kind${red ? ' roster-attention-row__kind--red' : ''}`}>{entry.label}</span>
          {flagRow && <FlagDisc code={r.flag} />}
          {missing && (
            <span className="roster-attention-row__flag" role="img" aria-label="Flagged Missing in Schoology" title="Flagged Missing in Schoology">
              <FlagDisc code={MISSING} />
            </span>
          )}
          <Link className="roster-attention-row__task" to={taskLink(r)} title={r.title}>{r.title}</Link>
          {r.extension && !done && <ExtensionTag extension={r.extension} />}
        </div>
        <span className="roster-attention-row__when">{rowWhen(entry)}</span>
      </div>
      <div className="roster-attention-row__actions">{buttons}</div>
      {open === 'refer' && (
        <div className="triage-row__more">
          <ReferPanel busy={busy} error={panelError} onCancel={() => setOpen(null)}
            onConfirm={(schoology) => viaPanel((s) => actions.refer(r, s), schoology)} />
        </div>
      )}
      {open === 'undo' && done && (
        <div className="triage-row__more">
          <ReferPanel mode="undo" busy={busy} error={panelError} onCancel={() => setOpen(null)}
            onConfirm={(schoology) => viaPanel((s) => actions.undo(r, done, { schoology: s }), schoology)} />
        </div>
      )}
      {open === 'waive' && (
        <div className="triage-row__more">
          <input className="triage-note" placeholder="Reason (optional)" aria-label="Waive note" value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="secondary btn-sm" onClick={() => { actions.record(r, 'waived', note); setOpen(null); }}>Waive referral</button>
          <button type="button" className="ghost" onClick={() => setOpen(null)}>Cancel</button>
        </div>
      )}
      {open === 'extend' && (
        <div className="triage-row__more">
          <ExtendEditor courseId={r.courseId} from={r.dueDate} extension={r.extension}
            onSave={(lessons, n) => { (entry.kind === 'make_up' ? actions.extendMakeUp : actions.extend)(r, lessons, n); setOpen(null); }}
            onCancel={() => setOpen(null)} />
        </div>
      )}
      {flagRow && <div ref={setHost} className="triage-row__more triage-row__flag-panel" />}
    </div>
  );
}

export default function NeedsAttention({ triage, active, gradebook = null, archived = false, card, onChanged, onFlagChanged }) {
  const [held, setHeld] = useState(() => new Map()); // row key → { entry, done: { action, kind, record } }
  const [error, setError] = useState(null);
  // Every row object drawn in this mode (as handed to an action) → its entry, so an action that ends
  // after triage re-read (a confirm left open) still finds its row.
  const shownEntries = useRef(new WeakMap());

  const actions = useTriageActions({
    onChanged: () => onChanged?.(),
    onError: setError,
    onDone: (action, row, out) => {
      const entry = shownEntries.current.get(row);
      if (!entry) return;
      setHeld((prev) => {
        const next = new Map(prev);
        if (action === 'undone') next.delete(entry.key);
        else if (action === 'referred' || action === 'waived') next.set(entry.key, { entry, done: { action, kind: 'referral', record: out } });
        else if (action === 'extended') next.set(entry.key, { entry, done: { action, kind: 'extension', record: out } });
        return next;
      });
    },
  });

  if (archived) return <p className="text-sm text-muted">An archived course has no triage.</p>;
  if (!triage) return <p className="text-sm text-muted">Reading triage…</p>;

  const byId = new Map(active.map((s) => [s.id, s]));
  const groups = withHeld(studentRows(triage, active.map((s) => s.id)), [...held.values()].map((h) => h.entry))
    .filter((g) => byId.has(g.studentId));
  const listed = new Set(groups.map((g) => g.studentId));
  const others = active.filter((s) => !listed.has(s.id));
  for (const g of groups) for (const e of g.rows) shownEntries.current.set(e.row, e);

  return (
    <div className="roster-mode roster-attention">
      <p className="text-sm text-muted">
        Each student&apos;s triage rows, most urgent first: the ring counts school days, and red means at the limit.
        A task name opens that task in Prism with this student&apos;s card in view.
      </p>
      {error && (
        <div className="alert alert-warning roster-attention__error">
          <span>{error}</span>
          <button type="button" className="ghost" onClick={() => setError(null)}>Close</button>
        </div>
      )}
      <h3 className="roster-group-title">Needs attention ({groups.length})</h3>
      <div className="roster-cards">
        {groups.length === 0 && <p className="text-sm text-muted">No student owes anything in this course.</p>}
        {groups.map((g) => card(byId.get(g.studentId), {
          children: g.rows.map((e) => (
            <AttentionRow key={e.key} entry={e} done={held.get(e.key)?.done ?? null} gradebook={gradebook} actions={actions}
              onChanged={onChanged} onFlagChanged={onFlagChanged} onError={setError} />
          )),
        }))}
      </div>
      <h3 className="roster-group-title">Everyone else ({others.length})</h3>
      <div className="roster-cards">{others.map((s) => card(s))}</div>
      {actions.modal}
    </div>
  );
}
