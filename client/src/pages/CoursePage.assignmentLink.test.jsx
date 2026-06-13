// External "View in Schoology" affordance next to assignment titles (#76).
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AssessmentsView, RubricModal, GradebookView } from './CoursePage.jsx';

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

describe('RubricModal — Schoology link beside the assignment title (#76)', () => {
  function renderModal(web_url) {
    return render(
      <MemoryRouter>
        <RubricModal
          student={{ first_name: 'Ada', last_name: 'Lovelace', preferred_name: null, preferred_name_teacher: null }}
          assignment={{ title: 'Project', schoology_assignment_id: 'sa-1', web_url, due_date: null, is_lti_submission: 0 }}
          courseId="5"
          topics={[]}
          comment=""
          grade={{ score: null, review_needed: [], resubmit_requested: false, resubmitted: false }}
          onClose={() => {}}
        />
      </MemoryRouter>
    );
  }

  it('links out to Schoology when the assignment has a web_url', () => {
    renderModal('https://hkis.schoology.com/assignment/1/info');
    const link = screen.getByRole('link', { name: 'View "Project" in Schoology' });
    expect(link).toHaveAttribute('href', 'https://hkis.schoology.com/assignment/1/info');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('omits the link when there is no web_url', () => {
    renderModal(null);
    expect(screen.queryByRole('link', { name: /view .* in schoology/i })).not.toBeInTheDocument();
  });
});

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
});
