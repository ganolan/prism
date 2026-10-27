// Summative / Formative / Unpublished filter on the Assessments and Gradebook tabs.
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AssessmentsView, GradebookView, TypeFilterBar } from './CoursePage.jsx';
import { DEFAULT_TYPE_FILTER } from '../lib/assessmentTypeFilter.js';

const assignments = [
  { id: 1, title: 'Project', schoology_assignment_id: 'sa-1', aligned: 1, published: 1, due_date: null },
  { id: 2, title: 'Quiz', schoology_assignment_id: 'sa-2', aligned: 0, published: 1, due_date: null },
  { id: 3, title: 'Draft test', schoology_assignment_id: 'sa-3', aligned: 1, published: 0, due_date: null },
];
const pill = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('AssessmentsView: unpublished assessments', () => {
  function renderList() {
    return render(
      <MemoryRouter><AssessmentsView data={{ assignments, folders: [] }} courseId="5" /></MemoryRouter>,
    );
  }

  it('hides unpublished assessments by default', () => {
    renderList();
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.queryByText('Draft test')).not.toBeInTheDocument();
    expect(pill('Unpublished')).toHaveAttribute('aria-pressed', 'false');
    expect(pill('Unpublished')).toHaveTextContent('Unpublished1');
  });

  it('shows them, with an Unpublished badge, when the filter is on', () => {
    renderList();
    fireEvent.click(pill('Unpublished'));
    expect(screen.getByText('Draft test')).toBeInTheDocument();
    expect(screen.getByLabelText('Not published on Schoology')).toHaveTextContent('Unpublished');
    expect(pill('Summative')).toHaveTextContent('Summative2');
  });

  it('keeps the type filters applying to unpublished assessments', () => {
    renderList();
    fireEvent.click(pill('Unpublished'));
    fireEvent.click(pill('Summative'));
    expect(screen.queryByText('Draft test')).not.toBeInTheDocument();
    expect(screen.getByText('Quiz')).toBeInTheDocument();
  });

  it('leaves out the Unpublished pill when every assessment is published', () => {
    render(
      <MemoryRouter><AssessmentsView data={{ assignments: assignments.slice(0, 2), folders: [] }} courseId="5" /></MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /^Unpublished/ })).not.toBeInTheDocument();
  });
});

describe('GradebookView with the compact filter bar', () => {
  function Harness() {
    const [filter, setFilter] = useState(DEFAULT_TYPE_FILTER);
    const data = {
      assignments, grades: {}, grading_scales: {},
      students: [{ id: 10, schoology_uid: 'u1', first_name: 'Ada', last_name: 'Lovelace' }],
    };
    return (
      <MemoryRouter>
        <TypeFilterBar compact assignments={assignments} filter={filter} onChange={setFilter} />
        <GradebookView data={data} courseId="5" mastery={null} filter={filter} />
      </MemoryRouter>
    );
  }
  const columns = () => within(screen.getByRole('table').querySelector('thead')).queryAllByRole('link').map((l) => l.textContent);

  it('shows published columns only by default', () => {
    render(<Harness />);
    expect(columns()).toEqual(['Project', 'Quiz']);
  });

  it('filters columns by summative, formative and unpublished', () => {
    render(<Harness />);
    fireEvent.click(pill('Unpublished'));
    expect(columns()).toEqual(['Project', 'Quiz', 'Draft test']);
    fireEvent.click(pill('Formative'));
    expect(columns()).toEqual(['Project', 'Draft test']);
    fireEvent.click(pill('Summative'));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('No assessments match the current filters.')).toBeInTheDocument();
  });
});
