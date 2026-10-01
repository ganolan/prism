// External "View in Schoology" affordance next to assignment titles (#76).
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AssessmentsView, GradebookView } from './CoursePage.jsx';

const assignments = [
  { id: 1, title: 'Project', schoology_assignment_id: 'sa-1', aligned: 1,
    web_url: 'https://hkis.schoology.com/assignment/1/info', due_date: null },
  { id: 2, title: 'Quiz', schoology_assignment_id: 'sa-2', aligned: 0,
    web_url: null, due_date: null },
];

describe('AssessmentsView — Schoology link beside assignment titles (#76)', () => {
  function renderList() {
    return render(
      <MemoryRouter>
        <AssessmentsView data={{ assignments, folders: [] }} courseId="5" />
      </MemoryRouter>
    );
  }

  it('links out to Schoology for an assignment that has a web_url', () => {
    renderList();
    const link = screen.getByRole('link', { name: 'View "Project" in Schoology' });
    expect(link).toHaveAttribute('href', 'https://hkis.schoology.com/assignment/1/info');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('omits the Schoology link for an assignment with no web_url', () => {
    renderList();
    expect(screen.queryByRole('link', { name: 'View "Quiz" in Schoology' })).not.toBeInTheDocument();
  });
});

// RubricModal's links (per-student OneDrive work, #120) live in
// CoursePage.rubricModal.test.jsx — the modal no longer links to the assignment.

describe('GradebookView — Schoology link in the diagonal column header (#76)', () => {
  function renderGrid() {
    const data = {
      assignments: [
        { id: 1, title: 'Project', schoology_assignment_id: 'sa-1', aligned: 0,
          web_url: 'https://schoology.hkis.edu.hk/assignments/sa-1/info', due_date: null },
        { id: 2, title: 'Quiz', schoology_assignment_id: 'sa-2', aligned: 0,
          web_url: null, due_date: null },
      ],
      students: [{ id: 10, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace' }],
      grades: {},
      grading_scales: {},
    };
    return render(
      <MemoryRouter>
        <GradebookView data={data} courseId="5" mastery={null} />
      </MemoryRouter>
    );
  }

  it('renders an external Schoology link in the header for an assignment with web_url', () => {
    renderGrid();
    const link = screen.getByRole('link', { name: 'View "Project" in Schoology' });
    expect(link).toHaveAttribute('href', 'https://schoology.hkis.edu.hk/assignments/sa-1/info');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('omits the header Schoology link for an assignment with no web_url', () => {
    renderGrid();
    expect(screen.queryByRole('link', { name: 'View "Quiz" in Schoology' })).not.toBeInTheDocument();
  });

  // The diagonal titles overflow rightward by design; the last column has no
  // neighbour to overflow onto, so a trailing spacer carries the header
  // background across that overflow instead of exposing the white card bg.
  it('renders a trailing header spacer in each of the three header rows', () => {
    renderGrid();
    expect(screen.getAllByTestId('grid-header-spacer')).toHaveLength(3);
  });
});

describe('AssessmentsView — feedback wait column (triage)', () => {
  it('shows ungraded count + wait for assignments that owe feedback', () => {
    const assignments = [
      { id: 1, title: 'CP1', aligned: 1, schoology_assignment_id: 'a1', due_date: '2026-09-17' },
      { id: 2, title: 'Quiz', aligned: 1, schoology_assignment_id: 'a2', due_date: '2026-09-02' },
    ];
    render(
      <MemoryRouter>
        <AssessmentsView
          data={{ assignments, folders: [] }} courseId="5" feedbackLimit={10}
          waits={{ a1: { owed: 7, submittedTotal: 24, oldestWaitDays: 8, tone: 'amber' } }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('7/24 ungraded')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '8 of 10 school days' })).toBeInTheDocument();
    expect(screen.getAllByText(/ungraded/)).toHaveLength(1);
  });
});
