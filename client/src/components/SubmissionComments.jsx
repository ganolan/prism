import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getSubmissionCommentThread, postSubmissionComment, postSubmissionCommentFile, deleteSubmissionComment, markSubmissionCommentsSeen } from '../services/api.js';
import { formatDateTime } from '../lib/formatDate.js';
import FileViewer, { viewKind } from './FileViewer.jsx';

// A student's Schoology submission comment thread (spec
// 2026-10-17-submission-comments-design.md): a bubble on the assessment card
// (variant "card") or a gradebook cell (variant "cell") opens a popover with the
// thread oldest first. Students often type their answers in the comment box, so
// their own text is marked clearly; Schoology's automatic "Revision N submitted"
// lines are faint. Posting and deleting reach the student at once, so each asks
// once more before it calls Schoology.
// Unread (18/10/2026): a student comment with typed text or a file newer than the
// thread was last opened in Prism shows a red dot on the bubble and a "New" tag in
// the thread; opening the popover marks the thread seen.
// The gradebook cell (layout A, 18/10/2026) puts the bubble in the cell's bottom-right
// corner, and its popover opens with the teacher's overall comment (read-only).
// A comment's image, video or PDF opens in FileViewer over the thread (#162), as a
// dropbox file does; any other file downloads.

function Bubble() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="comment-bubble-icon">
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 3v-3h-.5A1.5 1.5 0 0 1 2 9.5z" />
    </svg>
  );
}

// The student put their own work in the thread: typed text or an attached file.
const studentWork = (summary) => !!(summary?.student_text || summary?.student_files > 0);

export function summaryLabel(summary) {
  if (!summary?.read_at) return 'Submission comments: not read yet';
  if (!summary.count) return 'Submission comments: none';
  const n = `${summary.count} submission comment${summary.count === 1 ? '' : 's'}`;
  const parts = [summary.student_text && 'the student wrote text', summary.student_files > 0 && 'the student attached a file'].filter(Boolean);
  const unread = summary.unread > 0 ? `, ${summary.unread} unread` : '';
  return (parts.length ? `${n}, ${parts.join(' and ')}` : n) + unread;
}

const sizeLabel = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// overall: { text, visible } for the cell's popover (the teacher's overall comment, read-only).
export default function SubmissionComments({ assignmentId, studentId, studentName, title, summary, onSummary, variant = 'card', overall = null }) {
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
        <button ref={btn} type="button" className={`comment-dot comment-dot--corner${studentWork(summary) ? ' comment-dot--wrote' : ''}${summary?.unread > 0 ? ' comment-dot--unread' : ''}`}
          title={label} aria-label={`${label}. Open the thread`} aria-expanded={!!anchor}
          onClick={(e) => { e.stopPropagation(); anchor ? close() : open(); }}>
          <Bubble />
        </button>
      ) : (
        <>
          <button ref={btn} type="button" className={`comment-chip${summary?.count ? '' : ' comment-chip--empty'}${studentWork(summary) ? ' comment-chip--wrote' : ''}${summary?.unread > 0 ? ' comment-chip--unread' : ''}`}
            title={label} aria-label={`${label}. Open the thread`} aria-expanded={!!anchor}
            onClick={() => (anchor ? close() : open())}>
            <Bubble />
            {summary?.count > 0 && <span>{summary.count}</span>}
          </button>
        </>
      )}
      {anchor && createPortal(
        <CommentPopover assignmentId={assignmentId} studentId={studentId} studentName={studentName} title={title}
          anchor={anchor} onClose={close} onSummary={onSummary} anchorEl={btn} overall={overall} />,
        document.body,
      )}
    </>
  );
}

export function CommentPopover({ assignmentId, studentId, studentName, title, anchor, onClose, onSummary, anchorEl, overall = null }) {
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [confirmPost, setConfirmPost] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const [viewing, setViewing] = useState(null); // { comment, file } open in FileViewer
  const pop = useRef(null);
  const fileInput = useRef(null);
  const viewingRef = useRef(null);
  viewingRef.current = viewing;
  const fileUrl = (commentId, fid) => `/api/submission-comments/${assignmentId}/${studentId}/${commentId}/files/${fid}`;
  const authorOf = (c) => (c.is_mine ? 'You' : (c.author_name || (c.author_role === 'student' ? studentName : 'Teacher')));

  const take = (t) => {
    setThread(t);
    setError(t.error || null);
    onSummary?.({ ...t.summary, read_at: t.read_at });
  };
  // Seeing the thread clears its unread marker. The thread on screen keeps its "New"
  // tags; only the summary (the bubble's dot, the filter reason) follows.
  const markSeen = (t) => {
    if (!(t?.summary?.unread > 0)) return;
    markSubmissionCommentsSeen(assignmentId, studentId)
      .then((r) => r && onSummary?.({ ...r.summary, read_at: r.read_at }))
      .catch(() => {}); // the dot stays; the next open tries again
  };
  const load = (refresh) => {
    setLoading(true);
    return getSubmissionCommentThread(assignmentId, studentId, { refresh })
      .then((t) => { take(t); markSeen(t); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(false); }, [assignmentId, studentId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // While the viewer is open it owns Escape and clicks.
    const onKey = (e) => { if (e.key === 'Escape' && !viewingRef.current) onClose(); };
    const onDown = (e) => {
      if (viewingRef.current || pop.current?.contains(e.target) || anchorEl?.current?.contains(e.target)) return;
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
        <strong>{overall ? 'Comments' : 'Submission comments'}</strong>
        {title && <span className="comment-pop-title">{title}</span>}
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </div>
      {overall && (
        <div className="comment-overall">
          <div className="comment-label">
            Your overall comment
            {overall.text && <span className={`comment-vis comment-vis--${overall.visible ? 'on' : 'off'}`}>{overall.visible ? 'Visible to student' : 'Hidden from student'}</span>}
          </div>
          {overall.text ? <div className="comment-text">{overall.text}</div> : <div className="comment-auto">No overall comment yet.</div>}
        </div>
      )}
      {overall && <div className="comment-label comment-thread-label">Submission comments</div>}
      <ol className="comment-thread" aria-busy={loading}>
        {loading && !thread && <li className="comment-item comment-muted">Reading the thread from Schoology…</li>}
        {thread && comments.length === 0 && <li className="comment-item comment-muted">No comments on this submission.</li>}
        {comments.map((c) => (
          <li key={c.id} className="comment-item">
            <div className="comment-meta">
              <b>{authorOf(c)}</b>
              <time dateTime={c.created}>{formatDateTime(c.created)}</time>
              {c.unread && <span className="comment-new">New</span>}
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
            {c.attachments?.map((f) => {
              const cls = `comment-file${c.author_role === 'student' ? ' comment-file--student' : ''}`;
              const name = f.title || f.filename;
              const label = <>{name} <span className="comment-file-size">{sizeLabel(f.filesize)}</span></>;
              // An image, video or PDF opens in Prism's viewer (#162); anything else downloads.
              return viewKind(f) ? (
                <button key={f.fid} type="button" className={`${cls} files-view`} title={`View ${name} in Prism`}
                  onClick={() => setViewing({ comment: c, file: f })}>{label}</button>
              ) : (
                <a key={f.fid} className={cls} href={`${fileUrl(c.id, f.fid)}?download=1`} download>{label}</a>
              );
            })}
            {c.author_role === 'student' && !c.student_text && !c.automatic_lines.length && !c.attachments?.length && (
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
      {viewing && (
        <FileViewer url={fileUrl(viewing.comment.id, viewing.file.fid)} file={viewing.file}
          caption={`${authorOf(viewing.comment)}, ${formatDateTime(viewing.comment.created)}`}
          onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
