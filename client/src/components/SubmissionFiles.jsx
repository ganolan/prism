import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getSubmissionFiles } from '../services/api.js';
import { formatDateTime } from '../lib/formatDate.js';
import FileViewer, { viewKind } from './FileViewer.jsx';
import { Tip, useHelpPop, hoverOnly } from './HelpDot.jsx';

// A student's native Schoology dropbox files (#107): a paperclip chip beside
// the status pill opens a popover with every revision, newest first, and each
// revision's files. Images, videos and PDFs (and files Schoology keeps a PDF
// copy of) open in a viewer inside Prism; every file can be downloaded. Files
// come through Prism, which signs the download.
// OneDrive work has its own Open link (#120); render this only when
// hasNativeSubmission() holds.

// The task takes Schoology uploads and the sync saw this student submit one.
export function hasNativeSubmission(assignment, grade) {
  if (!assignment || !grade) return false;
  if (assignment.is_lti_submission || assignment.is_test === 1) return false;
  return grade.submission_type === 'drop';
}

function Clip() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="comment-bubble-icon">
      <path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2" />
    </svg>
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sizeLabel = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const fileUrl = (assignmentId, studentId, revisionId, fileId) =>
  `/api/submission-files/${assignmentId}/${studentId}/${revisionId}/files/${fileId}`;

function chipText(summary) {
  if (!summary?.read_at) return 'Files';
  return summary.files ? plural(summary.files, 'file') : 'No files';
}
function summaryLabel(summary) {
  if (!summary?.read_at) return 'Submitted files: not read yet';
  if (!summary.files) return 'Submitted files: none';
  return `Submitted files: ${plural(summary.files, 'file')} in ${plural(summary.revisions, 'revision')}`;
}

// autoLoad: read the student's files when mounted (the gradebook pop-up, where
// opening the pop-up is opening the student's work). The chip hides itself if
// the feature is off.
export default function SubmissionFiles({ assignmentId, studentId, studentName, title, summary: given = null, onSummary, autoLoad = false }) {
  const [anchor, setAnchor] = useState(null);
  const [own, setOwn] = useState(null);
  const [off, setOff] = useState(false);
  const btn = useRef(null);
  const summary = given || own;
  const pop = useHelpPop();

  useEffect(() => {
    if (!autoLoad) return undefined;
    let active = true;
    Promise.resolve().then(() => getSubmissionFiles(assignmentId, studentId))
      .then((r) => { if (active) setOwn({ ...r.summary, read_at: r.read_at }); })
      .catch((e) => { if (active && e?.status === 403) setOff(true); });
    return () => { active = false; };
  }, [autoLoad, assignmentId, studentId]);

  if (off) return null;
  const take = (s) => { setOwn(s); onSummary?.(s); };
  const open = () => setAnchor(btn.current.getBoundingClientRect());
  const close = () => { setAnchor(null); btn.current?.focus(); };
  const label = summaryLabel(summary);
  const empty = !summary?.files;
  return (
    <>
      <button ref={btn} type="button" className={`comment-chip files-chip${empty ? ' comment-chip--empty' : ''}`}
        aria-label={`${label}. Open the list`} aria-expanded={!!anchor} {...hoverOnly(pop.handlers)}
        onClick={() => (anchor ? close() : open())}>
        <Clip />
        <span>{chipText(summary)}</span>
      </button>
      {!anchor && pop.popover(label)}
      {anchor && createPortal(
        <FilesPopover assignmentId={assignmentId} studentId={studentId} studentName={studentName} title={title}
          anchor={anchor} onClose={close} onSummary={take} anchorEl={btn} />,
        document.body,
      )}
    </>
  );
}

export function FilesPopover({ assignmentId, studentId, studentName, title, anchor, onClose, onSummary, anchorEl }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [viewing, setViewing] = useState(null); // { revision, file }
  const pop = useRef(null);
  const viewingRef = useRef(null);
  viewingRef.current = viewing;

  const load = (refresh) => {
    setLoading(true);
    return getSubmissionFiles(assignmentId, studentId, { refresh })
      .then((r) => { setData(r); setError(r.error || null); onSummary?.({ ...r.summary, read_at: r.read_at }); })
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

  const width = Math.min(420, window.innerWidth - 32);
  const left = Math.max(16, Math.min(anchor.left, window.innerWidth - width - 16));
  const top = Math.min(anchor.bottom + 6, Math.max(16, window.innerHeight - 320));
  const revisions = data?.revisions ?? [];

  return (
    <div ref={pop} className="comment-pop files-pop" role="dialog" aria-label={`Submitted files for ${studentName}`}
      style={{ left, top, width, maxHeight: `calc(100vh - ${top}px - 16px)` }}>
      <div className="comment-pop-head">
        <strong>Submitted files</strong>
        {title && <span className="comment-pop-title">{title}</span>}
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </div>
      <ol className="comment-thread" aria-busy={loading}>
        {loading && !data && <li className="comment-item comment-muted">Reading the submission from Schoology…</li>}
        {data && revisions.length === 0 && <li className="comment-item comment-muted">Schoology holds no submission from {studentName}.</li>}
        {revisions.map((r, i) => (
          <li key={r.revision_id} className="comment-item">
            <div className="comment-meta">
              <b>Revision {r.revision_id}</b>
              {r.created && <time dateTime={r.created}>{formatDateTime(r.created)}</time>}
              {i === 0 && revisions.length > 1 && <span className="files-tag">Latest</span>}
              {r.late && <span className="files-tag files-tag--late">Late</span>}
              {r.draft && <span className="files-tag">Draft</span>}
            </div>
            {r.files.length === 0 && <div className="comment-auto">(no files)</div>}
            {r.files.map((f) => {
              const url = fileUrl(assignmentId, studentId, r.revision_id, f.id);
              const name = f.title || f.filename;
              return (
                <div key={f.id} className="files-row">
                  {viewKind(f) ? (
                    <Tip as="button" type="button" className="comment-file files-view" text={`View ${name} in Prism`}
                      onClick={() => setViewing({ revision: r, file: f })}>
                      {name} <span className="comment-file-size">{sizeLabel(f.filesize)}</span>
                    </Tip>
                  ) : (
                    <span className="comment-file files-plain">
                      {name} <span className="comment-file-size">{sizeLabel(f.filesize)}</span>
                    </span>
                  )}
                  <a className="files-download" href={`${url}?download=1`} download aria-label={`Download ${name}`}>Download</a>
                </div>
              );
            })}
          </li>
        ))}
      </ol>
      {error && <div className="alert alert-warning comment-error files-error">{error}</div>}
      <div className="comment-pop-foot">
        <span>{data?.read_at ? `Read from Schoology ${formatDateTime(data.read_at)}` : 'Not read from Schoology yet'}</span>
        <button type="button" className="ghost" disabled={loading} onClick={() => load(true)}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {viewing && (
        <FileViewer url={fileUrl(assignmentId, studentId, viewing.revision.revision_id, viewing.file.id)} file={viewing.file}
          caption={`${studentName}, revision ${viewing.revision.revision_id}`} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
