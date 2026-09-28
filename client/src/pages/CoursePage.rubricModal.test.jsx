// Gradebook submission modal: the student's own OneDrive work link replaces
// the assignment's Schoology link (#120); the comment sits under the rubric.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RubricModal } from './CoursePage.jsx';
import { getSubmissionLinks } from '../services/api.js';

vi.mock('../services/api.js', () => ({ getSubmissionLinks: vi.fn() }));

const STUDENT = { schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace', preferred_name: null, preferred_name_teacher: null };
const TOPICS = [{ topic_id: 't1', title: 'Topic 1', grade: 'EX' }];

function renderModal({ assignment = {}, comment = '' } = {}) {
  return render(
    <MemoryRouter>
      <RubricModal
        student={STUDENT}
        assignment={{
          title: 'Project', schoology_assignment_id: 'sa-1', due_date: null, is_lti_submission: 0,
          web_url: 'https://schoology.hkis.edu.hk/assignment/sa-1/info', ...assignment,
        }}
        courseId="5"
        topics={TOPICS}
        comment={comment}
        grade={{ score: null, review_needed: [], resubmit_requested: false, resubmitted: false, lti_submission_state: 'in_progress' }}
        onClose={() => {}}
      />
    </MemoryRouter>
  );
}

beforeEach(() => vi.clearAllMocks());

describe('RubricModal — student work link (#120)', () => {
  it('no longer links to the assignment\'s Schoology page (that lives on the column header)', () => {
    renderModal();
    expect(screen.queryByRole('link', { name: /in schoology/i })).not.toBeInTheDocument();
  });

  it('links to the student\'s own OneDrive copy for an lti_submission assignment', async () => {
    getSubmissionLinks.mockResolvedValue({
      status: 'ok',
      links: {
        u1: { url: 'https://hkis-my.sharepoint.com/f.pptx?d=wabc', fileName: 'f.pptx', modifiedAt: '2026-09-28T06:27:25Z' },
        u2: { url: 'https://hkis-my.sharepoint.com/other.pptx?d=wdef', fileName: 'other.pptx', modifiedAt: '2026-09-28T06:27:25Z' },
      },
    });
    renderModal({ assignment: { is_lti_submission: 1 } });
    const link = await screen.findByRole('link', { name: /open ada lovelace's work in onedrive/i });
    expect(link).toHaveAttribute('href', 'https://hkis-my.sharepoint.com/f.pptx?d=wabc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(getSubmissionLinks).toHaveBeenCalledWith('5', 'sa-1');
  });

  it('shows no link when the student has no file', async () => {
    getSubmissionLinks.mockResolvedValue({ status: 'ok', links: {} });
    renderModal({ assignment: { is_lti_submission: 1 } });
    await screen.findByText('Project');
    await Promise.resolve();
    expect(screen.queryByRole('link', { name: /onedrive/i })).not.toBeInTheDocument();
  });

  it('does not look up OneDrive for a non-lti assignment', () => {
    renderModal();
    expect(getSubmissionLinks).not.toHaveBeenCalled();
  });
});

describe('RubricModal — comment', () => {
  it('shows the teacher comment below the rubric', () => {
    renderModal({ comment: 'Great use of evidence.' });
    const comment = screen.getByText('Great use of evidence.');
    const rubricCell = screen.getByText('Topic 1');
    // DOCUMENT_POSITION_FOLLOWING: the comment comes after the rubric.
    expect(rubricCell.compareDocumentPosition(comment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
