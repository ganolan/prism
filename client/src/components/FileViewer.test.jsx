import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FileViewer, { viewKind, videoOrder } from './FileViewer.jsx';

const URL = '/api/submission-files/a/7/1/files/12';
const mov = { id: 12, title: 'demo.mov', filename: 'demo.mov', filemime: 'video/quicktime', converted: { filemime: 'video/mp4', extension: 'mp4' } };
const webm = { id: 13, title: 'clip.webm', filename: 'clip.webm', filemime: 'video/webm', converted: { filemime: 'video/mp4', extension: 'mp4' } };
const png = { id: 14, title: 'shot.png', filename: 'shot.png', filemime: 'image/png', converted: { filemime: 'application/pdf', extension: 'pdf' } };
const heic = { id: 15, title: 'photo.heic', filename: 'photo.heic', filemime: 'image/heic', converted: null };
const docx = { id: 16, title: 'essay.docx', filename: 'essay.docx', filemime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', converted: { filemime: 'application/pdf', extension: 'pdf' } };
const pdf = { id: 17, title: 'notes.pdf', filename: 'notes.pdf', filemime: 'application/pdf', converted: { filemime: 'application/pdf', extension: 'pdf' } };
const zip = { id: 18, title: 'game.zip', filename: 'game.zip', filemime: 'application/zip', converted: null };
const html = { id: 19, title: 'page.html', filename: 'page.html', filemime: 'text/html', converted: { filemime: 'application/pdf', extension: 'pdf' } };

describe('viewKind and videoOrder', () => {
  test('images, videos and PDFs (or a PDF copy) open in Prism; the rest only download', () => {
    expect([mov, webm, png, heic, docx, pdf, zip, html].map(viewKind)).toEqual(['video', 'video', 'image', 'image', 'pdf', 'pdf', null, 'pdf']);
  });

  test('the original first when the browser may play it, else Schoology\'s mp4 first', () => {
    expect(videoOrder(mov, () => '')).toEqual(['original', 'converted']);
    expect(videoOrder(webm, () => 'maybe')).toEqual(['original', 'converted']);
    expect(videoOrder(webm, () => '')).toEqual(['converted', 'original']);
    expect(videoOrder({ ...webm, converted: null }, () => '')).toEqual(['original']);
  });
});

describe('FileViewer', () => {
  test('a video falls back to the converted copy when the original fails, and can switch back', () => {
    render(<FileViewer url={URL} file={mov} caption="Ana Lee, revision 1" onClose={() => {}} />);
    const video = () => screen.getByRole('dialog').querySelector('video');
    expect(video()).toHaveAttribute('src', URL);
    expect(screen.getByText('Playing the original.')).toBeInTheDocument();
    fireEvent.error(video());
    expect(video()).toHaveAttribute('src', `${URL}?copy=converted`);
    expect(screen.getByText("Playing Schoology's converted copy (smaller).")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play the original' }));
    expect(video()).toHaveAttribute('src', URL);
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `${URL}?download=1`);
  });

  test('a video that plays in no form says so', () => {
    render(<FileViewer url={URL} file={{ ...webm, converted: null }} onClose={() => {}} />);
    fireEvent.error(screen.getByRole('dialog').querySelector('video'));
    expect(screen.getByText(/does not open in this browser/)).toBeInTheDocument();
  });

  test('an image shows inline; one the browser cannot show (HEIC in Chrome) falls back or says so', () => {
    const { unmount } = render(<FileViewer url={URL} file={png} onClose={() => {}} />);
    fireEvent.error(screen.getByRole('img', { name: 'shot.png' }));
    expect(screen.getByTitle('shot.png')).toHaveAttribute('src', `${URL}?copy=converted`);
    unmount();
    render(<FileViewer url={URL} file={heic} onClose={() => {}} />);
    fireEvent.error(screen.getByRole('img', { name: 'photo.heic' }));
    expect(screen.getByText(/does not open in this browser/)).toBeInTheDocument();
  });

  test('a PDF shows itself; a document or HTML file shows Schoology\'s PDF copy, never the original', () => {
    const { unmount } = render(<FileViewer url={URL} file={pdf} onClose={() => {}} />);
    expect(screen.getByTitle('notes.pdf')).toHaveAttribute('src', URL);
    unmount();
    render(<FileViewer url={URL} file={html} onClose={() => {}} />);
    expect(screen.getByTitle('page.html')).toHaveAttribute('src', `${URL}?copy=converted`);
    expect(screen.getByText("Schoology's PDF copy of this file.")).toBeInTheDocument();
  });

  test('Escape and Close both close it', () => {
    const onClose = vi.fn();
    render(<FileViewer url={URL} file={pdf} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
