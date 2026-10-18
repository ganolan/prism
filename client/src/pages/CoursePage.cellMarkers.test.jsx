// Gradebook cell markers (layout A, 18/10/2026): the late clock top right, one comment
// spot bottom right (an outline bubble for the overall comment, else the thread bubble),
// and the hover box with the overall comment, its visibility and a thread line.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getCourseCommentSummaries: vi.fn(),
}));

import { GradebookView } from './CoursePage.jsx';
import { getCourseCommentSummaries } from '../services/api.js';

function renderGrid(grade, summaries = {}) {
  getCourseCommentSummaries.mockResolvedValue({ assignments: summaries });
  const data = {
    assignments: [{ id: 1, title: 'Essay', schoology_assignment_id: 'sa-1', aligned: 0, is_lti_submission: 0, due_date: '2026-10-06 15:00:00', max_points: 100 }],
    students: [{ id: 10, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace' }],
    grades: { 10: { 1: { score: 80, exception: null, submission_type: 'drop', ...grade } } },
    timelines: {}, grading_scales: {},
  };
  return render(<MemoryRouter><GradebookView data={data} courseId="5" mastery={null} /></MemoryRouter>);
}
const cell = () => document.querySelector('tbody td:nth-child(2)');

beforeEach(() => vi.clearAllMocks());

describe('gradebook cell comment markers', () => {
  it('an overall comment with no thread: an outline bubble; hover shows it with its visibility', async () => {
    renderGrid({ grade_comment: 'Strong testing section.', comment_status: 1 });
    await waitFor(() => expect(getCourseCommentSummaries).toHaveBeenCalled());
    expect(screen.getByRole('img', { name: 'Has an overall comment' })).toHaveClass('overall-comment-mark');
    fireEvent.mouseEnter(cell());
    expect(screen.getByText('Your overall comment')).toBeInTheDocument();
    expect(screen.getByText('Visible to student')).toBeInTheDocument();
    expect(screen.getByText('Strong testing section.')).toBeInTheDocument();
  });

  it('a thread takes the corner (the outline bubble goes); hover adds the thread line, with unread', async () => {
    renderGrid({ grade_comment: '', comment_status: null }, { 'sa-1': { 10: { count: 2, student_text: true, unread: 1, read_at: 'x' } } });
    const bubble = await screen.findByRole('button', { name: /Open the thread/ });
    expect(bubble).toHaveClass('comment-dot--corner', 'comment-dot--unread');
    expect(screen.queryByRole('img', { name: 'Has an overall comment' })).toBeNull();
    fireEvent.mouseEnter(cell());
    expect(screen.getByText('No overall comment yet.')).toBeInTheDocument();
    expect(screen.getByText('Ada wrote in the submission comments (1 unread): click the bubble to open')).toBeInTheDocument();
  });

  it('nothing to say: no marker and no hover box', async () => {
    renderGrid({ grade_comment: '' });
    await waitFor(() => expect(getCourseCommentSummaries).toHaveBeenCalled());
    fireEvent.mouseEnter(cell());
    expect(screen.queryByText('Your overall comment')).toBeNull();
    expect(document.querySelector('.overall-comment-mark, .comment-dot')).toBeNull();
  });
});
