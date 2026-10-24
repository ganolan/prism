// Publish / unpublish on Schoology from the Assessments tab (#138): an
// unpublished row has Publish, a published row a quiet Unpublish; both confirm
// under the row first, because students see the change at once.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CoursePage, { AssessmentsView } from './CoursePage.jsx';
import * as api from '../services/api.js';

vi.mock('../services/api.js');

const live = { id: 21, title: 'Unit 2 Algorithms Test', schoology_assignment_id: 's21', aligned: 1, published: 1, due_date: null };
const draft = { id: 22, title: 'Unit 2 Validation Test', schoology_assignment_id: 's22', aligned: 1, published: 0, due_date: null };

function renderView(props) {
  return render(<MemoryRouter><AssessmentsView data={{ assignments: [live, draft], folders: [] }} courseId="5" {...props} /></MemoryRouter>);
}
const showUnpublished = () => fireEvent.click(screen.getByRole('button', { name: /Unpublished/ }));
const rowOf = (title) => screen.getByRole('link', { name: title }).closest('.assessment-row');

describe('AssessmentsView — publish control', () => {
  it('a published row offers Unpublish, an unpublished row Publish, only on a live course', () => {
    const { unmount } = renderView({ onSetPublished: vi.fn() });
    showUnpublished();
    expect(within(rowOf('Unit 2 Algorithms Test')).getByRole('button', { name: 'Unpublish' })).toBeInTheDocument();
    expect(within(rowOf('Unit 2 Validation Test')).getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    unmount();
    renderView({});
    showUnpublished();
    expect(screen.queryByRole('button', { name: /^(Publish|Unpublish)$/ })).not.toBeInTheDocument();
  });

  it('Publish asks first; Cancel sends nothing', () => {
    const onSetPublished = vi.fn();
    renderView({ onSetPublished });
    showUnpublished();
    fireEvent.click(within(rowOf('Unit 2 Validation Test')).getByRole('button', { name: 'Publish' }));
    const confirm = screen.getByRole('group', { name: /Publish "Unit 2 Validation Test"/ });
    expect(confirm).toHaveTextContent('Students see it immediately.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: /Publish "/ })).not.toBeInTheDocument();
    expect(onSetPublished).not.toHaveBeenCalled();
  });

  it('confirming sends the change and says it was checked', async () => {
    const onSetPublished = vi.fn().mockResolvedValue({ published: 0 });
    renderView({ onSetPublished });
    fireEvent.click(within(rowOf('Unit 2 Algorithms Test')).getByRole('button', { name: 'Unpublish' }));
    const confirm = screen.getByRole('group', { name: /Unpublish "Unit 2 Algorithms Test"/ });
    expect(confirm).toHaveTextContent('Students stop seeing it immediately.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Unpublish' }));
    expect(onSetPublished).toHaveBeenCalledWith(expect.objectContaining({ id: 21 }), 0);
    expect(await screen.findByRole('status')).toHaveTextContent('Unpublished on Schoology (checked)');
  });

  it('a refused change shows the error in the row', async () => {
    renderView({ onSetPublished: vi.fn().mockRejectedValue(new Error('Schoology refused the change (HTTP 403)')) });
    showUnpublished();
    fireEvent.click(within(rowOf('Unit 2 Validation Test')).getByRole('button', { name: 'Publish' }));
    fireEvent.click(within(screen.getByRole('group', { name: /Publish "/ })).getByRole('button', { name: 'Publish' }));
    expect((await screen.findByText(/HTTP 403/)).closest('.alert')).toHaveClass('alert-warning');
  });
});

describe('CoursePage — publish round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP CSP', archived: 0 });
    vi.mocked(api.getCourseStudents).mockResolvedValue([]);
    vi.mocked(api.getGradebook).mockResolvedValue({ assignments: [live, draft], folders: [], students: [], grades: {} });
    vi.mocked(api.getMasteryForCourse).mockResolvedValue(null);
    vi.mocked(api.getTriage).mockResolvedValue(null);
    vi.mocked(api.setAssessmentPublished).mockResolvedValue({ assignmentId: 22, published: 1, changed: true });
  });

  const renderPage = () => render(
    <MemoryRouter initialEntries={['/course/5?tab=assessments']}>
      <Routes><Route path="/course/:id" element={<CoursePage />} /></Routes>
    </MemoryRouter>,
  );

  it('publishing calls the API and the row loses its Unpublished badge', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Unpublished/ }));
    fireEvent.click(within(rowOf('Unit 2 Validation Test')).getByRole('button', { name: 'Publish' }));
    fireEvent.click(within(screen.getByRole('group', { name: /Publish "/ })).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(api.setAssessmentPublished).toHaveBeenCalledWith('5', 22, 1));
    await waitFor(() => expect(within(rowOf('Unit 2 Validation Test')).queryByText('Unpublished')).not.toBeInTheDocument());
    expect(within(rowOf('Unit 2 Validation Test')).getByRole('button', { name: 'Unpublish' })).toBeInTheDocument();
  });

  it('an archived course has no publish control', async () => {
    vi.mocked(api.getCourse).mockResolvedValue({ id: 5, course_name: 'AP CSP', archived: 1 });
    renderPage();
    await screen.findByRole('link', { name: 'Unit 2 Algorithms Test' });
    expect(screen.queryByRole('button', { name: 'Unpublish' })).not.toBeInTheDocument();
  });
});
