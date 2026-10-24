import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AnchoredPopover from './AnchoredPopover.jsx';
import { sizeLabel } from '../SubmissionComments.jsx';
import { getUnreadComments } from '../../services/api.js';
import { formatDateTime } from '../../lib/formatDate.js';
import { studentFullName } from '../../lib/studentNames.js';

// One student's unread comments in this course (#160), oldest first, from Prism's cache of the
// submission threads. Unread means what it means everywhere in Prism (submissionCommentStore.js): what
// the student typed or attached, newer than the last one seen. Opening this list marks nothing read;
// opening the thread on the assessment page does.
export default function CommentsPopover({ student, courseId, anchor, onClose }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let live = true;
    setState({ loading: true });
    getUnreadComments(courseId, student.id)
      .then((r) => { if (live) setState({ comments: r.comments || [] }); })
      .catch((err) => { if (live) setState({ error: err.message }); });
    return () => { live = false; };
  }, [courseId, student.id]);

  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} title={`${studentFullName(student)}: unread comments`}>
      {state.loading && <p className="text-sm text-muted">Reading the comments…</p>}
      {state.error && <p className="text-sm roster-pop__error">Could not read the comments: {state.error}</p>}
      {state.comments?.length === 0 && <p className="text-sm text-muted">No unread comments.</p>}
      {state.comments?.length > 0 && (
        <ol className="roster-comments">
          {state.comments.map((c, i) => (
            <li key={`${c.schoologyAssignmentId}-${c.created}-${i}`} className="roster-comment">
              <b>{c.title}</b>
              <time dateTime={c.created}>{formatDateTime(c.created)}</time>
              {c.studentText && <span className="roster-comment__text">{c.studentText}</span>}
              {c.attachments?.map((f) => (
                <span key={f.fid} className="comment-file comment-file--student">
                  {f.title || f.filename} {f.filesize != null && <span className="comment-file-size">{sizeLabel(f.filesize)}</span>}
                </span>
              ))}
              <Link className="link" to={`/course/${courseId}/assessment/${c.schoologyAssignmentId}?student=${student.id}`}>Open the task in Prism</Link>
            </li>
          ))}
        </ol>
      )}
      <p className="roster-pop__foot">Only what the student typed or attached counts. Opening this list marks nothing as read.</p>
    </AnchoredPopover>
  );
}
