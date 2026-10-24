import { useEffect, useState } from 'react';
import AnchoredPopover from './AnchoredPopover.jsx';
import { getAlertDetail } from '../../services/api.js';
import { formatDateTime } from '../../lib/formatDate.js';
import { studentFullName } from '../../lib/studentNames.js';

// One alert's detail for one student (#160), read live from PowerSchool when the chip is tapped
// (GET /api/students/:id/alert-detail/:key; the server answers a learning alert with the Student
// Support Summary). Rows as a two-column table, empty rows left out; text as a paragraph; an alert
// Prism cannot read says so. Nothing is kept on the page.
function Detail({ detail }) {
  const rows = detail.kind === 'rows' ? (detail.rows || []).filter((r) => r.description) : [];
  if (rows.length) {
    return (
      <table className="roster-pop__table">
        <tbody>
          {rows.map((r, i) => {
            const groupStart = i > 0 && r.group != null && r.group !== rows[i - 1].group;
            const text = r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer" className="link">{r.description}</a> : r.description;
            return (
              <tr key={i} className={groupStart ? 'roster-pop__group-start' : undefined}>
                {r.category ? <><th scope="row">{r.category}</th><td>{text}</td></> : <td colSpan={2}>{text}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
  if (detail.kind === 'text' && detail.text) return <p className="roster-pop__text">{detail.text}</p>;
  return <p className="text-sm">Prism can read only that this alert is set.</p>;
}

export default function AlertPopover({ student, alert, anchor, onClose }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    getAlertDetail(student.id, alert.key)
      .then((detail) => { if (live) setState({ detail }); })
      .catch((err) => { if (live) setState({ error: err.message }); });
    return () => { live = false; };
  }, [student.id, alert.key]);

  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} title={`${studentFullName(student)}: ${alert.title || alert.label}`}>
      {state.loading && <p className="text-sm text-muted">Reading from PowerSchool…</p>}
      {state.error && <p className="text-sm roster-pop__error">Could not read this alert: {state.error}</p>}
      {state.detail && (
        <>
          <Detail detail={state.detail} />
          {state.detail.readAt && <p className="roster-pop__foot">From PowerSchool, read {formatDateTime(state.detail.readAt)}</p>}
        </>
      )}
    </AnchoredPopover>
  );
}
