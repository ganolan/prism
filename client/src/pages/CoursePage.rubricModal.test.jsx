// Gradebook pop-up (the grade card, #176): the student's own OneDrive or Google Drive work link
// (#120, #142), the test attempt link, the student's Schoology uploads (#107), all in the card's
// header; the comment sits under the rubric.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api.js', async (orig) => ({
  ...(await orig()),
  getGradeCards: vi.fn(),
  getSubmissionLinks: vi.fn(),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  getQuizGroups: vi.fn().mockResolvedValue({ groups: [] }),
  getSubmissionFiles: vi.fn(),
  getRubricConfig: vi.fn().mockResolvedValue({ reportingCategoryColors: {} }),
  getProficiencyScale: vi.fn().mockResolvedValue({ levels: [] }),
}));

import { RubricModal } from './CoursePage.jsx';
import { getGradeCards, getSubmissionLinks, getAttemptLinks, getSubmissionFiles } from '../services/api.js';

const STUDENT = { id: 7, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace', preferred_name: null, preferred_name_teacher: null };
const TOPICS = [{ id: 't1', title: 'Topic 1', category_title: 'Cat', external_id: 'X1' }];

// The pop-up's card, in the shape GET /api/students/:id/grade-cards returns.
function serveCard({ assignment = {}, student = {} } = {}) {
  getGradeCards.mockResolvedValue({
    course: { id: 5, archived: 0, excluded: 0, writable: false },
    cards: { 'sa-1': {
      assignment: { id: 3, schoology_assignment_id: 'sa-1', title: 'Project', due_date: null, max_points: 100, is_test: 0, is_lti_submission: 0, ...assignment },
      topics: TOPICS, scoreScale: null, rubric: null, draft: null, hasDraft: false,
      student: {
        ...STUDENT, scores: { t1: { grade: 'EX' } }, grade_comment: '', comment_status: 1, exception: 0, score: null,
        submission_type: null, lti_submission_state: 'in_progress', timeline: null, attention: { reasons: [] }, ...student,
      },
    } },
  });
}

function renderModal({ assignment = {}, comment = '', student = STUDENT, grade = {} } = {}) {
  serveCard({ assignment, student: { grade_comment: comment, ...grade } });
  return render(
    <MemoryRouter>
      <RubricModal
        student={student}
        assignment={{
          id: 3, title: 'Project', schoology_assignment_id: 'sa-1', due_date: null, is_lti_submission: 0,
          web_url: 'https://schoology.hkis.edu.hk/assignment/sa-1/info', ...assignment,
        }}
        courseId="5"
        grade={{ score: null, resubmit_requested: false, resubmitted: false, lti_submission_state: 'in_progress', ...grade }}
        onClose={() => {}}
      />
    </MemoryRouter>
  );
}

beforeEach(() => vi.clearAllMocks());

describe('RubricModal: student work link (#120)', () => {
  it('no longer links to the assignment\'s Schoology page (that lives on the column header)', async () => {
    renderModal();
    await screen.findByText('Topic 1');
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
    await screen.findByText('Topic 1');
    await vi.waitFor(() => expect(getSubmissionLinks).toHaveBeenCalled());
    await getSubmissionLinks.mock.results[0].value;
    await act(async () => {});
    expect(screen.queryByRole('link', { name: /onedrive/i })).not.toBeInTheDocument();
  });

  it('does not look up OneDrive for a non-lti assignment', async () => {
    renderModal();
    await screen.findByText('Topic 1');
    expect(getSubmissionLinks).not.toHaveBeenCalled();
  });

  it('links to the student\'s submitted Google Drive copy through Schoology (#142)', async () => {
    const url = 'https://schoology.hkis.edu.hk/apps/lti/1073361950/run/assignment/sa-1?context=assignment_submission&custom_parameters[in_edit_mode]=true&studentId=1';
    getSubmissionLinks.mockResolvedValue({
      status: 'ok', provider: 'google_drive',
      links: { u1: { url, provider: 'google_drive', submittedAt: '2023-03-16T05:52:00.000Z' } },
    });
    renderModal({ assignment: { is_lti_submission: 1 } });
    const link = await screen.findByRole('link', { name: /open ada lovelace's work in google drive/i });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('target', '_blank');
  });
});

describe('RubricModal: comment', () => {
  it('shows the teacher comment below the rubric', async () => {
    renderModal({ comment: 'Great use of evidence.' });
    const comment = await screen.findByText('Great use of evidence.');
    const rubricCell = screen.getByText('Topic 1');
    // DOCUMENT_POSITION_FOLLOWING: the comment comes after the rubric.
    expect(rubricCell.compareDocumentPosition(comment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('RubricModal: test attempt link (linked quizzes)', () => {
  it('shows an Attempt link for the student, keyed by local student id', async () => {
    getAttemptLinks.mockResolvedValueOnce({ links: { 7: { url: 'https://schoology.hkis.edu.hk/assignment/9/assessment_results/student_stats/u/2', completedAt: '2026-10-09 09:31' } } });
    renderModal();
    const link = await screen.findByRole('link', { name: "Attempt: open Ada Lovelace's test attempt in Schoology" });
    expect(link).toHaveAttribute('href', expect.stringContaining('/student_stats/u/2'));
    expect(getAttemptLinks).toHaveBeenCalledWith({ assignmentId: 'sa-1' });
  });
});

describe('RubricModal: native dropbox files (#107)', () => {
  it('reads the student\'s files when it opens a native submission and shows the chip in the card\'s header', async () => {
    getSubmissionFiles.mockResolvedValue({ revisions: [], summary: { revisions: 2, files: 3 }, read_at: '2026-10-17T02:02:00.000Z' });
    renderModal({ grade: { submission_type: 'drop', lti_submission_state: null } });
    const chip = await screen.findByRole('button', { name: /Submitted files: 3 files in 2 revisions/ });
    expect(getSubmissionFiles).toHaveBeenCalledWith('sa-1', 7);
    expect(chip.compareDocumentPosition(screen.getByText('Topic 1')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no files chip when the files feature is off (403)', async () => {
    getSubmissionFiles.mockRejectedValue(Object.assign(new Error('off'), { status: 403 }));
    renderModal({ grade: { submission_type: 'drop', lti_submission_state: null } });
    await screen.findByText('Topic 1');
    await vi.waitFor(() => expect(getSubmissionFiles).toHaveBeenCalled());
    // The positive signal: the rejected read has settled (the card's own handler was attached first),
    // and React has applied what the handler set.
    await getSubmissionFiles.mock.results[0].value.catch(() => {});
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /Submitted files/ })).not.toBeInTheDocument();
  });

  it('shows no files chip without a native submission or on an OneDrive task', async () => {
    getSubmissionLinks.mockResolvedValue({ status: 'ok', links: {} });
    renderModal({ grade: { submission_type: null, lti_submission_state: null } });
    renderModal({ assignment: { is_lti_submission: 1 }, grade: { submission_type: 'drop' } });
    await waitFor(() => expect(screen.getAllByText('Topic 1')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /Submitted files/ })).not.toBeInTheDocument();
    expect(getSubmissionFiles).not.toHaveBeenCalled();
  });
});
