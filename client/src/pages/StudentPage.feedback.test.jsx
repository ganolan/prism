// Student page = the shared feedback view per assignment (#135): the same
// layout as the gradebook modal, full descriptors for an attached rubric, and
// one batch request for every aligned assignment's rubric (no N+1 on load).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../components/MasteryPerformanceSummary.jsx', () => ({ default: () => null }));
vi.mock('../services/api.js', async (orig) => ({
  ...(await orig()),
  getStudent: vi.fn(),
  getAttemptLinks: vi.fn().mockResolvedValue({ links: {} }),
  getRubricsForAssignments: vi.fn(),
  getRubricConfig: vi.fn().mockResolvedValue({ reportingCategoryColors: {} }),
}));

import StudentPage, { CourseSection } from './StudentPage.jsx';
import { getStudent, getRubricsForAssignments } from '../services/api.js';

const TOPICS = [{ topic_id: 't1', title: 'Select, analyze', external_id: 'ART.5.1', category_title: 'HS Art: Producing', grade: 'EX' }];
const ATTACHMENT = {
  id: 1,
  rubric: { criteria: [{ id: 'c1', position: 1, criterion_name: 'UI/UX',
    descriptors: { ED: 'Polished and intuitive.', EX: 'Clear and usable.', D: 'Inconsistent.', EM: 'Hard to use.' } }] },
  topicByCriterion: [{ criterion_id: 'c1', topic_id: 't1' }],
};

const grade = (over = {}) => ({
  course_id: 1, assignment_id: 10, schoology_assignment_id: 'sa-10', assignment_title: 'Portfolio',
  due_date: '2026-04-12', score: 75, assignment_max_points: 100, exception: 0, late: 0, draft: 0,
  submitted_at: 1, submission_type: 'drop', grading_scale_id: null, mastery: { topics: TOPICS },
  grade_comment: 'Strong reflection.', ...over,
});

function renderSection(grades, rubrics) {
  return render(
    <MemoryRouter>
      <CourseSection course={{ id: 1, course_name: 'Art' }} grades={grades} flagsByAssignment={{}}
        studentUid="u1" scales={{}} studentName="Ada Lovelace" rubrics={rubrics} />
    </MemoryRouter>
  );
}

beforeEach(() => vi.clearAllMocks());

describe('CourseSection: shared feedback view (#135)', () => {
  it('shows an attached rubric\'s descriptors with the awarded level, comment below', () => {
    renderSection([grade()], { attachments: { 'sa-10': ATTACHMENT }, palette: {} });
    const awarded = screen.getByText('Clear and usable.').closest('td');
    expect(awarded).toHaveAttribute('data-awarded', 'true');
    const comment = screen.getByText('Strong reflection.');
    expect(awarded.compareDocumentPosition(comment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('without an attached rubric keeps the compact grid', () => {
    renderSection([grade()], { attachments: {}, palette: {} });
    expect(screen.getByText('Measurement Topic')).toBeInTheDocument();
    expect(screen.queryByText('Clear and usable.')).not.toBeInTheDocument();
  });

  it('badges come before the rubric, as in the gradebook modal', () => {
    renderSection([grade({ score: null })], { attachments: {}, palette: {} });
    const badge = screen.getByText('Submitted');
    expect(badge.closest('.assignment-feedback__badges')).not.toBeNull();
    expect(badge.compareDocumentPosition(screen.getByText('Select, analyze')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a points-only task shows its score in the rubric\'s place', () => {
    renderSection([grade({ mastery: null, score: 50 })], { attachments: {}, palette: {} });
    expect(screen.getByText('50 / 100')).toBeInTheDocument();
    expect(screen.getByText('Strong reflection.')).toBeInTheDocument();
  });
});

describe('StudentPage: one rubric request for the whole page', () => {
  it('asks for every aligned assignment\'s rubric in a single batch', async () => {
    getStudent.mockResolvedValue({
      id: 7, first_name: 'Ada', last_name: 'Lovelace', schoology_uid: 'u1',
      courses: [{ id: 1, course_name: 'Art' }, { id: 2, course_name: 'Design' }],
      grades: [
        grade(),
        grade({ course_id: 2, assignment_id: 20, schoology_assignment_id: 'sa-20', assignment_title: 'Poster' }),
        grade({ course_id: 2, assignment_id: 21, schoology_assignment_id: 'sa-21', assignment_title: 'Quiz', mastery: null }),
      ],
      notes: [], flags: [], parents: [], grading_scales: {},
    });
    getRubricsForAssignments.mockResolvedValue({ attachments: { 'sa-20': ATTACHMENT } });
    render(
      <MemoryRouter initialEntries={['/student/7']}>
        <Routes><Route path="/student/:id" element={<StudentPage />} /></Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('Clear and usable.')).toBeInTheDocument();
    expect(getRubricsForAssignments).toHaveBeenCalledTimes(1);
    expect(getRubricsForAssignments).toHaveBeenCalledWith(['sa-10', 'sa-20']);
  });
});
