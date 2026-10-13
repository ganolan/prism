// One student's answer to one FRQ (spec §12): the answer, the stored Schoology rubric, and
// the comment, with Accept, Save edit, Keep mine and Copy comment. The card starts from the
// teacher's mark, else the suggestion, else Schoology's mark.
import { useState } from 'react';
import { saveFrqMark } from '../../services/api.js';
import { sanitizeAnswerHtml } from '../../lib/sanitizeHtml.js';
import FrqRubricGrid from './FrqRubricGrid.jsx';
import AttemptLink from './AttemptLink.jsx';

const STATE_LABEL = { suggested: 'Suggested', accepted: 'Accepted', edited: 'Edited' };
const WRITEBACK = { pending: ['Waiting to post', 'badge-amber'], posted: ['Posted', 'badge-green'], failed: ['Post failed', 'badge-red'] };

export function stateChips({ schoology, mark }) {
  if (!mark) return [{ key: 'state', label: schoology ? 'In Schoology' : 'Not marked', tone: 'badge-gray' }];
  const chips = [{ key: 'state', label: STATE_LABEL[mark.state] ?? mark.state, tone: mark.state === 'suggested' ? 'badge-pink' : 'badge-blue' }];
  const wb = WRITEBACK[mark.writeback?.status];
  if (wb) chips.push({ key: 'writeback', label: wb[0], tone: wb[1] });
  if (mark.changed_in_schoology) chips.push({ key: 'changed', label: 'Changed in Schoology', tone: 'badge-amber' });
  return chips;
}

export default function FrqCard({ groupId, student, question, response, onSaved }) {
  const { mark, schoology } = response;
  const start = mark?.final ?? mark?.suggested ?? schoology ?? { cells: {}, comment: '' };
  const [cells, setCells] = useState(start.cells || {});
  const [comment, setComment] = useState(start.comment || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  async function send(body) {
    setBusy(true);
    try {
      const r = await saveFrqMark(groupId, student.attempt_id, question.position, body);
      setError(null);
      onSaved(r.mark);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(comment);
      setCopied(true);
    } catch {
      setError('Copy is not available here: select the comment and copy it.');
    }
  }

  return (
    <div className="card frq-card" data-testid="frq-card">
      <div className="frq-card__head">
        <strong>{student.name}</strong>
        <AttemptLink link={{ url: student.attempt_url, completedAt: student.completed_at }} name={student.name} />
        {stateChips(response).map(c => <span key={c.key} className={`badge ${c.tone}`} title={c.key === 'writeback' && mark?.writeback?.error ? mark.writeback.error : undefined}>{c.label}</span>)}
        {mark?.suggestion_revised && <span className="badge badge-pink">Revised suggestion</span>}
      </div>
      {response.answer_html
        ? <div className="frq-answer" dangerouslySetInnerHTML={{ __html: sanitizeAnswerHtml(response.answer_html) }} />
        : <p className="text-muted">No answer.</p>}
      {question.rubric ? (
        <FrqRubricGrid
          rubric={question.rubric}
          final={cells}
          suggested={mark?.suggested?.cells ?? null}
          schoology={schoology?.cells ?? null}
          onSelect={(rowId, points) => setCells(c => ({ ...c, [rowId]: points }))}
        />
      ) : (
        <label className="text-sm">
          Points (0 to {question.max_points}){' '}
          <input type="number" min="0" max={question.max_points} step="0.5" aria-label={`Points for ${student.name}`}
            value={cells.points ?? ''} onChange={(e) => setCells({ points: e.target.value === '' ? '' : Number(e.target.value) })} />
        </label>
      )}
      <textarea className="frq-comment" aria-label={`Comment for ${student.name}`} rows={4} value={comment}
        onChange={(e) => { setComment(e.target.value); setCopied(false); }} />
      {error && <div className="alert alert-warning">{error}</div>}
      <div className="frq-card__actions">
        {mark?.suggested && <button type="button" className="primary" disabled={busy} onClick={() => send({ action: 'accept' })}>Accept</button>}
        <button type="button" className="secondary" disabled={busy} onClick={() => send({ action: 'save', cells, comment })}>Save edit</button>
        {mark?.suggestion_revised && mark?.final && <button type="button" className="ghost" disabled={busy} onClick={() => send({ action: 'keep' })}>Keep mine</button>}
        <button type="button" className="ghost" onClick={copy}>Copy comment</button>
        {copied && <span className="text-sm text-muted">Copied</span>}
      </div>
    </div>
  );
}
