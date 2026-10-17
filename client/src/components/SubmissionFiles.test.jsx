import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/api.js', () => ({ getSubmissionFiles: vi.fn() }));

import SubmissionFiles, { hasNativeSubmission } from './SubmissionFiles.jsx';
import { getSubmissionFiles } from '../services/api.js';

const zip = { id: 11, filename: 'game.zip', title: 'game.zip', filesize: 3646421, filemime: 'application/zip', extension: 'zip' };
const mov = { id: 12, filename: 'demo.mov', title: 'demo.mov', filesize: 12794355, filemime: 'video/quicktime', extension: 'mov' };
const v2 = { id: 21, filename: 'game-v2.zip', title: 'game-v2.zip', filesize: 179260, filemime: 'application/zip', extension: 'zip' };
const data = {
  revisions: [
    { revision_id: '2', created: '2026-10-16T01:40:00.000Z', late: true, draft: false, files: [v2] },
    { revision_id: '1', created: '2026-10-14T07:12:00.000Z', late: false, draft: false, files: [zip, mov] },
  ],
  summary: { revisions: 2, files: 3 },
  read_at: '2026-10-17T02:02:00.000Z',
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getSubmissionFiles.mockResolvedValue(data);
});

describe('hasNativeSubmission', () => {
  test('only a Schoology upload on a task that is neither OneDrive nor a test', () => {
    expect(hasNativeSubmission({ is_lti_submission: 0 }, { submission_type: 'drop' })).toBe(true);
    expect(hasNativeSubmission({ is_lti_submission: 1 }, { submission_type: 'drop' })).toBe(false);
    expect(hasNativeSubmission({ is_lti_submission: 0, is_test: 1 }, { submission_type: 'assessment' })).toBe(false);
    expect(hasNativeSubmission({ is_lti_submission: 0 }, { submission_type: null, submitted_at: 1792300000 })).toBe(false);
    expect(hasNativeSubmission({ is_lti_submission: 0 }, null)).toBe(false);
  });
});

describe('SubmissionFiles', () => {
  test('the chip shows the cached count; opening lists every revision newest first with Prism links', async () => {
    const onSummary = vi.fn();
    render(<SubmissionFiles assignmentId="8590105935" studentId={7} studentName="Ana Lee" title="Flappy Bird (F)"
      summary={{ revisions: 2, files: 3, read_at: 'x' }} onSummary={onSummary} />);
    const chip = screen.getByRole('button', { name: /Submitted files: 3 files in 2 revisions/ });
    expect(chip).toHaveTextContent('3 files');
    expect(getSubmissionFiles).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(getSubmissionFiles).toHaveBeenCalledWith('8590105935', 7, { refresh: false });
    const dialog = await screen.findByRole('dialog', { name: 'Submitted files for Ana Lee' });
    await waitFor(() => expect(dialog).toHaveTextContent('game-v2.zip'));
    const items = dialog.querySelectorAll('li');
    expect(items[0]).toHaveTextContent('Revision 2');
    expect(items[0]).toHaveTextContent('Latest');
    expect(items[0]).toHaveTextContent('Late');
    expect(items[1]).toHaveTextContent('Revision 1');
    expect(screen.getByText('14/10/2026', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /demo\.mov/ })).toHaveAttribute('href', '/api/submission-files/8590105935/7/1/files/12');
    expect(screen.getByRole('link', { name: /demo\.mov/ })).toHaveTextContent('12.2 MB');
    expect(onSummary).toHaveBeenCalledWith({ revisions: 2, files: 3, read_at: data.read_at });
  });

  test('before a read the chip says Files; Refresh asks Schoology again; Escape closes', async () => {
    render(<SubmissionFiles assignmentId="a" studentId={7} studentName="Ana Lee" summary={null} />);
    expect(screen.getByRole('button', { name: /not read yet/ })).toHaveTextContent('Files');
    fireEvent.click(screen.getByRole('button', { name: /Open the list/ }));
    await screen.findByText('game.zip', { exact: false });
    expect(screen.getByRole('button', { name: /3 files in 2 revisions/ })).toHaveTextContent('3 files');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(getSubmissionFiles).toHaveBeenLastCalledWith('a', 7, { refresh: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('no submission and a failed read are said plainly', async () => {
    getSubmissionFiles.mockResolvedValueOnce({ revisions: [], summary: { revisions: 0, files: 0 }, read_at: data.read_at, error: 'Schoology API 503' });
    render(<SubmissionFiles assignmentId="a" studentId={7} studentName="Ana Lee" />);
    fireEvent.click(screen.getByRole('button', { name: /Open the list/ }));
    expect(await screen.findByText('Schoology holds no submission from Ana Lee.')).toBeInTheDocument();
    expect(screen.getByText('Schoology API 503')).toBeInTheDocument();
  });

  test('autoLoad reads the count when mounted, and hides when the feature is off', async () => {
    const { unmount } = render(<SubmissionFiles autoLoad assignmentId="a" studentId={7} studentName="Ana Lee" />);
    expect(await screen.findByRole('button', { name: /3 files in 2 revisions/ })).toBeInTheDocument();
    expect(getSubmissionFiles).toHaveBeenCalledWith('a', 7);
    unmount();
    getSubmissionFiles.mockRejectedValueOnce(Object.assign(new Error('Feature "submission_files" is not enabled'), { status: 403 }));
    render(<SubmissionFiles autoLoad assignmentId="a" studentId={7} studentName="Ana Lee" />);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Submitted files/ })).not.toBeInTheDocument());
  });
});
