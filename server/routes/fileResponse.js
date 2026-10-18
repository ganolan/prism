// Sending a student's file through Prism (#107, #162): native dropbox files and
// files on submission comments. Images, videos, audio and PDFs are served inline
// (with byte ranges so a video can seek) for Prism's viewer; anything else
// downloads, sandboxed: a student's HTML file must never run on Prism's origin.
// ?download=1 always downloads.
import { Readable } from 'stream';

export const VIEWABLE = /^image\/(png|jpeg|gif|webp|heic|heif|avif)$|^video\/|^audio\/|^application\/pdf$/;

// f: { status (200 or 206), filename, filemime, filesize, contentRange, body (web stream) }.
export function sendFile(req, res, f) {
  const viewable = VIEWABLE.test(f.filemime);
  const inline = viewable && req.query.download !== '1';
  res.status(f.status || 200);
  res.set('Content-Type', f.filemime);
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Accept-Ranges', 'bytes');
  // (Not on media or PDFs: Chrome's PDF viewer refuses a sandboxed document.)
  if (!viewable) res.set('Content-Security-Policy', 'sandbox');
  if (f.contentRange) res.set('Content-Range', f.contentRange);
  if (f.filesize) res.set('Content-Length', String(f.filesize));
  if (!f.body) return res.end();
  const stream = Readable.fromWeb(f.body);
  stream.on('error', (err) => { console.error('student file stream failed:', err); res.destroy(err); });
  res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
  return stream.pipe(res);
}
