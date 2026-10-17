// One question tag across every quiz group in the course (#139), opened from a tag on the
// Questions tab. A drawer from the right, so the quiz stays in view beside it. MCQs only, as
// the Questions tab counts tags. Per test: its date, the tagged questions and percent correct.
// Per student: correct out of total on each test they sat and across the course, lowest first.
// Closes with Close, Escape or the backdrop; Tab stays inside while it is open and focus goes
// back to the tag that opened it.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getTagResults } from '../../services/api.js';
import { formatDate } from '../../lib/formatDate.js';
import ScoreDots from './ScoreDots.jsx';

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const PercentBar = ({ pct, label }) => (
  <span className="pct-bar" role="img" aria-label={label}><span style={{ width: `${pct}%` }} /></span>
);
const PercentCell = ({ pct }) => (pct == null ? null : (
  <span className="pct-cell"><PercentBar pct={pct} label={`${pct}% correct`} />{pct}%</span>
));

export default function TagResultsDrawer({ courseId, tag: initialTag, groupId, onClose, returnFocus = null }) {
  const [tag, setTag] = useState(initialTag);
  const [loaded, setLoaded] = useState({ tag: null, data: null });
  const [error, setError] = useState(null);
  const data = loaded.tag === tag ? loaded.data : null;
  const dialogRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    let active = true;
    setError(null);
    getTagResults(courseId, tag).then(d => { if (active) setLoaded({ tag, data: d }); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [courseId, tag]);

  // Focus moves in on open and back to the opener on close: returnFocus when given, since Safari
  // does not focus a button on click, else whatever had focus.
  useEffect(() => {
    const opener = returnFocus || document.activeElement;
    closeRef.current?.focus();
    return () => { if (opener && opener !== document.body && typeof opener.focus === 'function') opener.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tags = data?.courseTags?.length ? data.courseTags : [tag];
  const questionCount = data ? data.tests.reduce((n, t) => n + t.questions.length, 0) : 0;

  return createPortal(
    <div className="tag-drawer__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={dialogRef} className="tag-drawer" role="dialog" aria-modal="true" aria-labelledby="tag-drawer-title">
        <div className="tag-drawer__head">
          <h2 id="tag-drawer-title" className="tag-drawer__title">{`${tag} across the course`}</h2>
          <button ref={closeRef} type="button" className="ghost" onClick={onClose}>Close</button>
        </div>
        <label className="tag-drawer__picker text-sm">
          <span>Tag</span>
          <select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            {tags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>

        {error && <div className="alert alert-warning">{error}</div>}
        {!error && !data && <div className="loading">Loading...</div>}
        {data && (
          <>
            {data.text && <p className="tag-drawer__text">{data.text}</p>}
            {!data.tests.length ? (
              <p className="text-muted">No MCQ in this course carries this tag. Tags on free-response questions are not counted.</p>
            ) : (
              <>
                <p className="tag-drawer__total">
                  <span>{`${data.overall.correct}/${data.overall.total} correct${data.overall.percent == null ? '' : ` (${data.overall.percent}%)`} on ${plural(questionCount, 'MCQ')} in ${plural(data.tests.length, 'test')}`}</span>
                  {data.overall.percent != null && <PercentBar pct={data.overall.percent} label={`Course: ${data.overall.percent}% correct`} />}
                </p>

                <h3 className="tag-drawer__section">By test</h3>
                <div className="tag-drawer__scroll">
                  <table aria-label="By test" className="text-sm tag-drawer__table">
                    <thead><tr><th>#</th><th>Test</th><th>Date</th><th>Questions</th><th>Correct</th><th>%</th></tr></thead>
                    <tbody>{data.tests.map((t, i) => (
                      <tr key={t.group_id} className={t.group_id === groupId ? 'tag-drawer__current' : undefined}>
                        <td>{i + 1}</td>
                        <td>{t.title}{t.group_id === groupId && <span className="text-muted"> (this quiz)</span>}</td>
                        <td>{formatDate(t.date)}</td>
                        <td>{t.questions.map((q, k) => (
                          <span key={q.position}>{k > 0 && ', '}<span className="tag-drawer__q">{`Q${q.position}${q.percent == null ? '' : ` ${q.percent}%`}`}</span></span>
                        ))}</td>
                        <td>{t.takers ? `${t.correct}/${t.total}` : <span className="text-muted">Not loaded</span>}</td>
                        <td><PercentCell pct={t.percent} /></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>

                {data.students.length > 0 && (
                  <>
                    <h3 className="tag-drawer__section">By student</h3>
                    <ScoreDots students={data.students} />
                    <div className="tag-drawer__scroll">
                      <table aria-label="By student" className="text-sm tag-drawer__table">
                        <thead><tr>
                          <th>Student</th>
                          {data.tests.map((t, i) => <th key={t.group_id} title={t.title}>{i + 1}</th>)}
                          <th>Total</th><th>%</th>
                        </tr></thead>
                        <tbody>{data.students.map(s => (
                          <tr key={s.student_id}>
                            <td>{s.name}</td>
                            {data.tests.map(t => {
                              const r = s.tests[t.group_id];
                              return <td key={t.group_id} title={r ? undefined : 'Did not sit it'}>{r ? `${r.correct}/${r.total}` : '-'}</td>;
                            })}
                            <td>{`${s.correct}/${s.total}`}</td>
                            <td><PercentCell pct={s.percent} /></td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </aside>
    </div>,
    document.body,
  );
}
