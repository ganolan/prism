// Gradebook submission modal = the shared feedback view (#135): full rubric
// descriptors when a rubric is attached (and a wider modal), the compact grid
// otherwise, and points-only cells ("50 / 100") open it too, without a rubric.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api.js', async (orig) => ({
  ...(await orig()),
  getSubmissionLinks: vi.fn().mockResolvedValue({ status: 'ok', links: {} }),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  getQuizGroups: vi.fn().mockResolvedValue({ groups: [] }),
  getCourseCommentSummaries: vi.fn().mockResolvedValue({ assignments: {} }),
  getRubricsForAssignments: vi.fn().mockResolvedValue({ attachments: {} }),
  getRubricConfig: vi.fn().mockResolvedValue({ reportingCategoryColors: { produc: '#B4A7D6' } }),
}));

import { RubricModal, GradebookView } from './CoursePage.jsx';
import { getRubricsForAssignments, getCourseCommentSummaries } from '../services/api.js';

const STUDENT = { id: 10, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace' };
const TOPICS = [{ topic_id: 't1', title: 'Select, analyze', external_id: 'ART.5.1', category_title: 'HS Art: Producing', grade: 'EX' }];
const ATTACHMENT = {
  id: 1,
  rubric: { criteria: [{ id: 'c1', position: 1, criterion_name: 'UI/UX',
    descriptors: { ED: 'Polished and intuitive.', EX: 'Clear and usable.', D: 'Inconsistent.', EM: 'Hard to use.' } }] },
  topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }],
};
const GRADE = { score: 75, exception: 0, review_needed: [], resubmit_requested: false, resubmitted: false };

function renderModal(props = {}) {
  return render(
    <MemoryRouter>
      <RubricModal
        student={STUDENT}
        assignment={{ title: 'Project', schoology_assignment_id: 'sa-1', due_date: null, is_lti_submission: 0, aligned: 1 }}
        courseId="5" topics={TOPICS} comment="Great use of evidence." grade={GRADE}
        onClose={() => {}}
        {...props}
      />
    </MemoryRouter>
  );
}

beforeEach(() => vi.clearAllMocks());

describe('RubricModal: rubric descriptors (#135)', () => {
  it('shows the attached rubric\'s full descriptors, highlights the awarded level, and widens', async () => {
    getRubricsForAssignments.mockResolvedValueOnce({ attachments: { 'sa-1': ATTACHMENT } });
    renderModal();
    const awarded = (await screen.findByText('Clear and usable.')).closest('td');
    expect(awarded).toHaveAttribute('data-awarded', 'true');
    expect(getRubricsForAssignments).toHaveBeenCalledWith(['sa-1'], { studentUid: 'u1' });
    expect(screen.getByRole('dialog')).toHaveClass('feedback-modal--wide');
    // The comment stays below the rubric.
    expect(awarded.compareDocumentPosition(screen.getByText('Great use of evidence.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('without an attached rubric keeps the compact grid at the narrow width', async () => {
    renderModal();
    await Promise.resolve();
    expect(screen.getByText('Measurement Topic')).toBeInTheDocument();
    expect(screen.queryByText('Clear and usable.')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).not.toHaveClass('feedback-modal--wide');
  });
});

describe('RubricModal: points-only task', () => {
  it('shows the score, timeline and comment, with no rubric', async () => {
    renderModal({
      topics: [],
      assignment: { title: 'Ep 1 Result', schoology_assignment_id: 'sa-2', due_date: null, is_lti_submission: 0, aligned: 0 },
      score: { text: '50 / 100', kind: 'numeric' },
      comment: 'Revise question 3.',
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('50 / 100')).toBeInTheDocument();
    expect(within(dialog).getByText('Revise question 3.')).toBeInTheDocument();
    // A formative task is marked F, not S.
    expect(within(dialog).getByText('F')).toBeInTheDocument();
    await vi.waitFor(() => expect(getRubricsForAssignments).toHaveBeenCalled());
    expect(within(dialog).queryByRole('table')).not.toBeInTheDocument();
    expect(dialog).not.toHaveClass('feedback-modal--wide');
  });
});

describe('RubricModal: feedback rows on an unaligned task', () => {
  it('shows the attached rows with this student\'s levels, then the overall level, and widens', async () => {
    getRubricsForAssignments.mockResolvedValueOnce({ attachments: { 'sa-3': {
      id: 4, mode: 'feedback_rows', topicByCriterion: [], rowLevels: { Playtesting: 'D' },
      rubric: { criteria: [{ id: 'c9', position: 1, criterion_name: 'Playtesting', standard_title: 'Refine work',
        descriptors: { ED: 'Iterates from evidence.', EX: 'Tests and fixes.', D: 'Tests once.', EM: 'No testing.' } }] },
    } } });
    renderModal({
      topics: [],
      assignment: { title: 'Flappy Bird (F)', schoology_assignment_id: 'sa-3', due_date: null, is_lti_submission: 0, aligned: 0 },
      score: { text: 'Developing', kind: 'scale' },
    });
    const awarded = (await screen.findByText('Tests once.')).closest('td');
    expect(awarded).toHaveAttribute('data-awarded', 'true');
    expect(getRubricsForAssignments).toHaveBeenCalledWith(['sa-3'], { studentUid: 'u1' });
    expect(within(screen.getByText('Overall:').parentElement).getByText('Developing')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveClass('feedback-modal--wide');
  });
});

describe('RubricModal: submission comments in the badges row', () => {
  it('shows the comments chip beside the badges when the feature is on', () => {
    renderModal({
      grade: { ...GRADE, score: null, submitted_at: 1, submission_type: 'drop' },
      commentSummary: { count: 2, read_at: '2026-10-17T02:00:00.000Z' }, onCommentSummary: () => {},
    });
    const chip = screen.getByRole('button', { name: /2 submission comments/ });
    expect(chip.closest('.assignment-feedback__badges')).toContainElement(screen.getByText('Submitted'));
  });

  it('shows no chip when the feature is off (no summary callback)', () => {
    renderModal();
    expect(screen.queryByRole('button', { name: /submission comment/ })).not.toBeInTheDocument();
  });
});

describe('GradebookView: points-only cells open the modal', () => {
  const data = {
    assignments: [{ id: 1, title: 'Ep 1 Result', schoology_assignment_id: 'sa-2', aligned: 0, is_lti_submission: 0, max_points: 100, due_date: '2020-01-01 00:00:00' }],
    students: [STUDENT],
    grades: { 10: { 1: { score: 50, exception: 0, grade_comment: 'Revise question 3.', submitted_at: 1, submission_type: 'drop' } } },
    grading_scales: {},
  };

  it('opens the feedback modal from a "50 / 100" cell', async () => {
    render(<MemoryRouter><GradebookView data={data} courseId="5" mastery={null} /></MemoryRouter>);
    await screen.findByRole('button', { name: /50 \/ 100/ });
    expect(getCourseCommentSummaries).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /50 \/ 100/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(dialog).getByText('50 / 100')).toBeInTheDocument();
    expect(within(dialog).getByText('Revise question 3.')).toBeInTheDocument();
  });
});
