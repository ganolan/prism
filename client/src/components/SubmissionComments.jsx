import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getSubmissionCommentThread, postSubmissionComment, postSubmissionCommentFile, deleteSubmissionComment } from '../services/api.js';
import { formatDateTime } from '../lib/formatDate.js';

// A student's Schoology submission comment thread (spec
// 2026-10-17-submission-comments-design.md): a bubble on the assessment card
// (variant "card") or a gradebook cell (variant "cell") opens a popover with the
// thread oldest first. Students often type their answers in the comment box, so
// their own text is marked clearly; Schoology's automatic "Revision N submitted"
// lines are faint. Posting and deleting reach the student at once, so each asks
// once more before it calls Schoology.

function Bubble() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="comment-bubble-icon">
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 3v-3h-.5A1.5 1.5 0 0 1 2 9.5z" />
    </svg>
  );
}

function summaryLabel(summary) {
  if (!summary?.read_at) return 'Submission comments: not read yet';
  if (!summary.count) return 'Submission comments: none';
  const n = `${summary.count} submission comment${summary.count === 1 ? '' : 's'}`;
  return summary.student_text ? `${n}, the student wrote text` : n;
}

export default function SubmissionComments({ assignmentId, studentId, studentName, title, summary, onSummary, variant = 'card' }) {
  const [anchor, setAnchor] = useState(null);
  const btn = useRef(null);
  const open = () => setAnchor(btn.current.getBoundingClientRect());
  const close = () => { setAnchor(null); btn.current?.focus(); };

  // A cell shows no bubble without comments, but keeps it while its popover is
  // open (a refresh or a delete can bring the count to 0).
  if (variant === 'cell' && !(summary?.count > 0) && !anchor) return null;
  const label = summaryLabel(summary);
  return (
    <>
      {variant === 'cell' ? (
        <button ref={btn} type="button" className={`comment-dot${summary?.student_text ? ' comment-dot--wrote' : ''}`}
          title={label} aria-label={`${label}. Open the thread`} aria-expanded={!!anchor}
          onClick={(e) => { e.stopPropagation(); anchor ? close() : open(); }}>
          <Bubble />
        </button>
      ) : (
        <>
          <button ref={btn} type="button" className={`comment-chip${summary?.count ? '' : ' comment-chip--empty'}${summary?.student_text ? ' comment-chip--wrote' : ''}`}
            title={label} aria-label={`${label}. Open the thread`} aria-expanded={!!anchor}
            onClick={() => (anchor ? close() : open())}>
            <Bubble />
            {summary?.count > 0 && <span>{summary.count}</span>}
          </button>
          {summary?.student_text && (
            <span className="comment-wrote" title="The student typed their own text in a submission comment">Wrote in comments</span>
          )}
        </>
      )}
      {anchor && createPortal(
        <CommentPopover assignmentId={assignmentId} studentId={studentId} studentName={studentName} title={title}
          anchor={anchor} onClose={close} onSummary={onSummary} anchorEl={btn} />,
        document.body,
      )}
    </>
  );
}

export function CommentPopover({ assignmentId, studentId, studentName, title, anchor, onClose, onSummary, anchorEl }) {
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [confirmPost, setConfirmPost] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const pop = useRef(null);
  const fileInput = useRef(null);

  const take = (t) => {
    setThread(t);
    setError(t.error || null);
    onSummary?.({ ...t.summary, read_at: t.read_at });
  };
  const load = (refresh) => {
    setLoading(true);
    return getSubmissionCommentThread(assignmentId, studentId, { refresh })
      .then(take)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(false); }, [assignmentId, studentId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => {
      if (pop.current?.contains(e.target) || anchorEl?.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [onClose, anchorEl]);

  const post = async () => {
    setBusy(true); setError(null);
    try {
      take(file
        ? await postSubmissionCommentFile(assignmentId, studentId, text, file)
        : await postSubmissionComment(assignmentId, studentId, text));
      setText(''); setFile(null); setConfirmPost(false);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const remove = async (id) => {
    setBusy(true); setError(null);
    try { take(await deleteSubmissionComment(assignmentId, studentId, id)); setConfirmDelete(null); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const width = Math.min(460, window.innerWidth - 32);
  const left = Math.max(16, Math.min(anchor.left, window.innerWidth - width - 16));
  const top = Math.min(anchor.bottom + 6, Math.max(16, window.innerHeight - 320));
  const comments = thread?.comments ?? [];

  return (
    <div ref={pop} className="comment-pop" role="dialog" aria-label={`Submission comments for ${studentName}`}
      style={{ left, top, width, maxHeight: `calc(100vh - ${top}px - 16px)` }}>
      <div className="comment-pop-head">
        <strong>Submission comments</strong>
        {title && <span className="comment-pop-title">{title}</span>}
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </div>
      <ol className="comment-thread" aria-busy={loading}>
        {loading && !thread && <li className="comment-item comment-muted">Reading the thread from Schoology…</li>}
        {thread && comments.length === 0 && <li className="comment-item comment-muted">No comments on this submission.</li>}
        {comments.map((c) => (
          <li key={c.id} className="comment-item">
            <div className="comment-meta">
              <b>{c.is_mine ? 'You' : (c.author_name || (c.author_role === 'student' ? studentName : 'Teacher'))}</b>
              <time dateTime={c.created}>{formatDateTime(c.created)}</time>
              {c.is_mine && (
                <button type="button" className="ghost danger comment-del" disabled={busy}
                  onClick={() => setConfirmDelete(c.id)}>Delete</button>
              )}
            </div>
            {c.automatic_lines.map((l, i) => <div key={i} className="comment-auto">{l}</div>)}
            {c.student_text && (
              <div className="comment-student-text"><span className="comment-student-tag">Student wrote</span>{c.student_text}</div>
            )}
            {c.author_role !== 'student' && c.text && <div className="comment-text">{c.text}</div>}
            {c.author_role === 'student' && !c.student_text && !c.automatic_lines.length && (
              <div className="comment-auto">(empty comment)</div>
            )}
            {confirmDelete === c.id && (
              <div className="comment-confirm" role="alert">
                <span>Delete this comment from Schoology? {studentName} can no longer see it.</span>
                <div className="comment-row">
                  <button type="button" className="primary danger" disabled={busy} onClick={() => remove(c.id)}>Delete</button>
                  <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="comment-compose">
        <label htmlFor={`comment-${assignmentId}-${studentId}`} className="comment-label">Reply to {studentName}</label>
        <textarea id={`comment-${assignmentId}-${studentId}`} value={text} disabled={busy}
          onChange={(e) => { setText(e.target.value); setConfirmPost(false); }} />
        <input ref={fileInput} type="file" hidden data-testid="comment-file"
          onChange={(e) => { setFile(e.target.files?.[0] || null); setConfirmPost(false); e.target.value = ''; }} />
        {!confirmPost ? (
          <div className="comment-row">
            {file ? (
              <span className="comment-file">
                {file.name}
                <button type="button" className="ghost" disabled={busy} aria-label={`Remove ${file.name}`} onClick={() => setFile(null)}>Remove</button>
              </span>
            ) : (
              <button type="button" className="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>Attach file</button>
            )}
            <button type="button" className="primary comment-post" disabled={busy || (!text.trim() && !file)}
              onClick={() => setConfirmPost(true)}>Post comment</button>
          </div>
        ) : (
          <div className="comment-confirm" role="alert">
            <span>Post this{file ? ` with ${file.name}` : ''} to {studentName} now? Students see a submission comment at once, and it stays until you delete it.</span>
            <div className="comment-row">
              <button type="button" className="primary" disabled={busy} onClick={post}>{busy ? 'Posting…' : 'Post now'}</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmPost(false)}>Cancel</button>
            </div>
          </div>
        )}
        {error && <div className="alert alert-warning comment-error">{error}</div>}
      </div>
      <div className="comment-pop-foot">
        <span>{thread?.read_at ? `Read from Schoology ${formatDateTime(thread.read_at)}` : 'Not read from Schoology yet'}</span>
        <button type="button" className="ghost" disabled={loading || busy} onClick={() => load(true)}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}
