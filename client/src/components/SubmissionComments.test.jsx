import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../services/api.js', () => ({
  getSubmissionCommentThread: vi.fn(),
  postSubmissionComment: vi.fn(),
  deleteSubmissionComment: vi.fn(),
}));

import SubmissionComments from './SubmissionComments.jsx';
import { getSubmissionCommentThread, postSubmissionComment, deleteSubmissionComment } from '../services/api.js';

const thread = (comments) => ({
  comments,
  summary: { count: comments.length, student_text: comments.some((c) => c.student_text), student_words: 0 },
  read_at: '2026-10-17T02:02:00.000Z',
});
const auto = { id: '1', author_role: 'student', author_name: 'Ana Lee', is_mine: false, created: '2026-10-14T07:12:00.000Z', text: 'Revision 1 submitted', automatic_lines: ['Revision 1 submitted'], is_automatic: true, student_text: null };
const wrote = { id: '2', author_role: 'student', author_name: 'Ana Lee', is_mine: false, created: '2026-10-16T01:40:00.000Z', text: 'Revision 2 submitted\nPlaytest notes', automatic_lines: ['Revision 2 submitted'], is_automatic: false, student_text: 'Playtest notes' };
const mine = { id: '3', author_role: 'teacher', author_name: 'Graham Nolan', is_mine: true, created: '2026-10-16T10:05:00.000Z', text: 'Your rubric feedback is attached.', automatic_lines: [], is_automatic: false, student_text: null };

function renderCard(summary = { count: 3, student_text: true, read_at: 'x' }, onSummary = vi.fn()) {
  render(<SubmissionComments assignmentId="8590105935" studentId={7} studentName="Ana Lee" title="Flappy Bird (F)"
    summary={summary} onSummary={onSummary} />);
  return onSummary;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSubmissionCommentThread.mockResolvedValue(thread([auto, wrote, mine]));
});

describe('SubmissionComments', () => {
  test('the card chip shows the count and the Wrote in comments badge', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /3 submission comments, the student wrote text/ })).toHaveTextContent('3');
    expect(screen.getByText('Wrote in comments')).toBeInTheDocument();
  });

  test('opening reads the thread: automatic lines faint, student text marked, oldest first', async () => {
    const onSummary = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Open the thread/ }));
    expect(getSubmissionCommentThread).toHaveBeenCalledWith('8590105935', 7, { refresh: false });
    const dialog = await screen.findByRole('dialog', { name: 'Submission comments for Ana Lee' });
    await waitFor(() => expect(dialog).toHaveTextContent('Playtest notes'));
    expect(screen.getByText('Revision 1 submitted')).toHaveClass('comment-auto');
    expect(screen.getByText('Student wrote').parentElement).toHaveClass('comment-student-text');
    expect(screen.getByText('14/10/2026', { exact: false })).toBeInTheDocument();
    expect(onSummary).toHaveBeenCalledWith(expect.objectContaining({ count: 3, student_text: true }));
    // Delete only on the teacher's own comment.
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });

  test('Post comment asks once more before it calls Schoology', async () => {
    postSubmissionComment.mockResolvedValue(thread([auto, wrote, mine, { ...mine, id: '4', text: 'Thanks' }]));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Open the thread/ }));
    await screen.findByText('Playtest notes');
    fireEvent.change(screen.getByLabelText('Reply to Ana Lee'), { target: { value: 'Thanks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    expect(postSubmissionComment).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Students see a submission comment at once');
    fireEvent.click(screen.getByRole('button', { name: 'Post now' }));
    await waitFor(() => expect(postSubmissionComment).toHaveBeenCalledWith('8590105935', 7, 'Thanks'));
    await waitFor(() => expect(screen.getByLabelText('Reply to Ana Lee')).toHaveValue(''));
  });

  test('Delete confirms, then deletes', async () => {
    deleteSubmissionComment.mockResolvedValue(thread([auto, wrote]));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Open the thread/ }));
    await screen.findByText('Your rubric feedback is attached.');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteSubmissionComment).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' }).at(-1));
    await waitFor(() => expect(deleteSubmissionComment).toHaveBeenCalledWith('8590105935', 7, '3'));
    await waitFor(() => expect(screen.queryByText('Your rubric feedback is attached.')).not.toBeInTheDocument());
  });

  test('a failed post shows the error and keeps the text', async () => {
    postSubmissionComment.mockRejectedValue(new Error('Schoology refused the comment (403); nothing was posted.'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Open the thread/ }));
    await screen.findByText('Playtest notes');
    fireEvent.change(screen.getByLabelText('Reply to Ana Lee'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Post now' }));
    expect(await screen.findByText(/nothing was posted/)).toBeInTheDocument();
    expect(screen.getByLabelText('Reply to Ana Lee')).toHaveValue('Hello');
  });

  test('Escape closes the popover', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Open the thread/ }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('the cell variant shows nothing without comments, an amber dot with student text', () => {
    const { rerender } = render(<SubmissionComments variant="cell" assignmentId="a" studentId={1} studentName="Ana" summary={{ count: 0, read_at: 'x' }} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<SubmissionComments variant="cell" assignmentId="a" studentId={1} studentName="Ana" summary={{ count: 2, student_text: true, read_at: 'x' }} />);
    expect(screen.getByRole('button')).toHaveClass('comment-dot--wrote');
  });

  test('a never-read card chip still opens', () => {
    renderCard(null);
    expect(screen.getByRole('button', { name: /not read yet/ })).toHaveClass('comment-chip--empty');
  });
});
