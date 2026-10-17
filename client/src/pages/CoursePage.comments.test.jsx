// Gradebook grid: a cell whose submission comment thread is cached shows a
// bubble (amber when the student wrote text) that opens the thread popover.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api.js', async (orig) => ({
  ...(await orig()),
  getCourseCommentSummaries: vi.fn().mockResolvedValue({
    assignments: { 'sa-1': { 10: { count: 2, student_text: true, student_words: 9, read_at: '2026-10-17T02:00:00.000Z' } } },
  }),
  getSubmissionCommentThread: vi.fn().mockResolvedValue({ comments: [], summary: { count: 0 }, read_at: null }),
}));

import { GradebookView } from './CoursePage.jsx';
import { getCourseCommentSummaries, getSubmissionCommentThread } from '../services/api.js';

const data = {
  assignments: [{ id: 1, title: 'Flappy Bird (F)', schoology_assignment_id: 'sa-1', aligned: 0, is_lti_submission: 0, due_date: '2020-01-01 00:00:00' }],
  students: [{ id: 10, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace' }],
  grades: { 10: { 1: { score: null, exception: 0, submitted_at: 1792300000, submission_type: 'drop' } } },
  grading_scales: {},
};

describe('GradebookView submission comment bubble', () => {
  it('reads cached summaries for the course and opens the thread from the cell', async () => {
    render(<MemoryRouter><GradebookView data={data} courseId="5" mastery={null} /></MemoryRouter>);
    const dot = await screen.findByRole('button', { name: /2 submission comments, the student wrote text/ });
    expect(getCourseCommentSummaries).toHaveBeenCalledWith('5');
    expect(dot).toHaveClass('comment-dot--wrote');
    fireEvent.click(dot);
    expect(await screen.findByRole('dialog', { name: 'Submission comments for Ada' })).toBeInTheDocument();
    expect(getSubmissionCommentThread).toHaveBeenCalledWith('sa-1', 10, { refresh: false });
  });
});
