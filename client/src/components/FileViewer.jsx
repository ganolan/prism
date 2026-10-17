import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// A submitted file shown inside Prism (#107): images, videos and PDFs in a
// lightbox over the page, with Download kept. Schoology keeps a converted copy
// of many files (a video as H.264 .mp4, a document or an image as .pdf;
// verified 2026-10-18), served by the same route with ?copy=converted. A video
// plays its original when the browser may play it and falls back to the
// converted copy if it fails; the teacher can switch between the two.

const IMAGE = /^image\/(png|jpeg|gif|webp|heic|heif|avif)$/;
const isPdf = (m) => m === 'application/pdf';
const isVideo = (m) => /^video\//.test(m || '');

// How Prism can show a file, or null when it can only be downloaded.
export function viewKind(file) {
  const m = file?.filemime || '';
  if (IMAGE.test(m)) return 'image';
  if (isVideo(m) || isVideo(file?.converted?.filemime)) return 'video';
  if (isPdf(m) || isPdf(file?.converted?.filemime)) return 'pdf';
  return null;
}

// The video copies to try, best first: the original when the browser says it
// may play it (or for a QuickTime .mov, which is H.264 in every task seen and
// plays despite an empty canPlayType in Chrome), then Schoology's .mp4.
export function videoOrder(file, canPlay = (m) => document.createElement('video').canPlayType?.(m) ?? '') {
  const order = [];
  const originalPlays = isVideo(file.filemime) && (canPlay(file.filemime) !== '' || file.filemime === 'video/quicktime');
  if (originalPlays) order.push('original');
  if (isVideo(file.converted?.filemime)) order.push('converted');
  if (!originalPlays && isVideo(file.filemime)) order.push('original');
  return order;
}

export default function FileViewer({ url, file, caption, onClose }) {
  const kind = viewKind(file);
  const close = useRef(null);
  const [copyIdx, setCopyIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const order = kind === 'video' ? videoOrder(file) : [];
  // An image or PDF: the original when it is itself viewable, else the converted PDF.
  const still = kind === 'image' ? (failed && isPdf(file.converted?.filemime) ? 'pdf-converted' : 'image')
    : kind === 'pdf' ? (isPdf(file.filemime) ? 'pdf' : 'pdf-converted') : null;

  useEffect(() => { close.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const name = file.title || file.filename;
  const copy = order[copyIdx];
  const src = (c) => (c === 'converted' ? `${url}?copy=converted` : url);
  let body;
  let note = null;
  if (kind === 'video' && copy && !failed) {
    body = (
      <video key={copy} className="file-viewer-media" src={src(copy)} controls autoPlay playsInline
        onError={() => (copyIdx + 1 < order.length ? setCopyIdx(copyIdx + 1) : setFailed(true))} />
    );
    if (order.length > 1) {
      const other = order.findIndex((c) => c !== copy);
      note = (
        <span className="file-viewer-note">
          {copy === 'converted' ? "Playing Schoology's converted copy (smaller)." : 'Playing the original.'}
          <button type="button" className="ghost" onClick={() => setCopyIdx(other)}>
            {copy === 'converted' ? 'Play the original' : "Play Schoology's converted copy"}
          </button>
        </span>
      );
    }
  } else if (still === 'image' && !failed) {
    body = <img className="file-viewer-media" src={url} alt={name} onError={() => setFailed(true)} />;
  } else if (still === 'pdf' || still === 'pdf-converted') {
    body = <iframe className="file-viewer-frame" src={still === 'pdf' ? url : src('converted')} title={name} />;
    if (still === 'pdf-converted') note = <span className="file-viewer-note">Schoology's PDF copy of this file.</span>;
  } else {
    body = (
      <div className="file-viewer-fail">
        This {kind === 'video' ? 'video' : 'file'} does not open in this browser. Download it to view it.
      </div>
    );
  }

  return createPortal(
    <div className="file-viewer" role="dialog" aria-modal="true" aria-label={`View ${name}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="file-viewer-panel">
        <div className="file-viewer-head">
          <strong className="file-viewer-name">{name}</strong>
          {caption && <span className="comment-pop-title">{caption}</span>}
          {note}
          <a className="file-viewer-download" href={`${url}?download=1`} download>Download</a>
          <button ref={close} type="button" className="ghost" onClick={onClose}>Close</button>
        </div>
        <div className="file-viewer-body">{body}</div>
      </div>
    </div>,
    document.body,
  );
}
